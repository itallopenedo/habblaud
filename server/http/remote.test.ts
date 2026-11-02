import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { AgentFiles } from '../deliveries/agent-files';
import { FileFetcher } from '../deliveries/fetcher';
import { L, symlinkOrSkip, tempDir, writeLines } from '../test/fixtures';
import { createApiHandler, sendJson, type ApiDeps } from './app';
import { createRequestGuard, isLoopbackHost } from './guard';
import {
  CONFIRM_MS,
  COOKIE,
  createRemoteGate,
  isRemoteRequest,
  loadSecret,
  LoginThrottle,
  parseAllow,
  parseRemoteConfig,
  readCookie,
  RemoteSessions,
  SESSION_MS,
  type RemoteFeature,
} from './remote';
import { Hub } from './sse';
import { hashPassword, parsePasswordHash } from '../remote/password';
import { SpawnService } from '../spawn/spawn';
import { AttachmentStore } from '../spawn/attachments';

setQuiet(true);

const SECRET = Buffer.alloc(32, 7);
const PASSWORD = 'correct horse battery';
// logN 10: rápido nos testes (o setup usa 15).
const HASH_TEXT = await hashPassword(PASSWORD, 10);
const CFG = { user: 'ana', passwordHash: parsePasswordHash(HASH_TEXT)!, passwordHashText: HASH_TEXT };
const CREDS = { user: 'ana', password: PASSWORD };
const TLS_FILES = (p: string) => p.endsWith('server.key') || p.endsWith('server.crt');

describe('parseRemoteConfig', () => {
  const base = { HABBLAUD_REMOTE_USER: 'ana', HABBLAUD_REMOTE_PASSWORD_HASH: HASH_TEXT };
  it('fica desligado sem as variáveis', () => {
    expect(parseRemoteConfig({}, false)).toEqual({});
  });
  it('recusa senha em texto puro e hash ausente ou inválido', () => {
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a', HABBLAUD_REMOTE_PASSWORD: '12345678' }, false).warning).toMatch(/texto puro/);
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a' }, false).warning).toMatch(/remote:setup/);
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a', HABBLAUD_REMOTE_PASSWORD_HASH: 'scrypt:1:2' }, false, TLS_FILES).warning).toMatch(/inválido/);
  });
  it('exige HTTPS: sem certificado não sobe, a menos de HABBLAUD_REMOTE_INSECURE_HTTP=1', () => {
    expect(parseRemoteConfig(base, false, () => false).warning).toMatch(/HTTPS é obrigatório/);
    const insecure = parseRemoteConfig({ ...base, HABBLAUD_REMOTE_INSECURE_HTTP: '1' }, false, () => false).config;
    expect(insecure?.tls).toBeUndefined();
  });
  it('liga com padrões: porta 4748, só permissões, certificado da pasta padrão', () => {
    const { config } = parseRemoteConfig({ ...base, HOME: '/h' }, false, TLS_FILES);
    expect(config).toMatchObject({ port: 4748, host: '0.0.0.0', user: 'ana' });
    expect(config?.tls?.certFile).toBe('/h/.habblaud/remote-tls/server/server.crt');
    expect([...config!.allow]).toEqual(['permissions']);
  });
  it('no Docker ignora porta e host (o container escuta sempre em 0.0.0.0:4748) e lê o certificado de /remote-tls', () => {
    const env = { ...base, HABBLAUD_REMOTE_PORT: '9999', HABBLAUD_REMOTE_HOST: '10.0.0.1' };
    const docker = parseRemoteConfig(env, true, TLS_FILES).config;
    expect(docker).toMatchObject({ port: 4748, host: '0.0.0.0' });
    expect(docker?.tls?.dir).toBe('/remote-tls');
    expect(parseRemoteConfig(env, false, TLS_FILES).config).toMatchObject({ port: 9999, host: '10.0.0.1' });
  });
  it('HABBLAUD_REMOTE_ALLOW: lista, ignora nomes desconhecidos, "none" = só ver', () => {
    expect([...parseAllow('messages, Terminal, bogus')]).toEqual(['messages', 'terminal']);
    expect([...parseAllow('terminal,pty')]).toEqual(['terminal', 'pty']);
    expect([...parseAllow('none')]).toEqual([]);
    expect([...parseAllow('')]).toEqual(['permissions']);
  });
});

describe('RemoteSessions', () => {
  it('aceita o próprio token e recusa adulterado, vencido ou de outra senha', () => {
    let now = 1_800_000_000_000;
    const sessions = new RemoteSessions(SECRET, CFG, () => now);
    const { token, maxAgeS } = sessions.issue();
    expect(maxAgeS).toBe(SESSION_MS / 1000);
    expect(sessions.verify(token)).toBe(true);
    expect(sessions.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(sessions.verify(token.replace(/^v1\.\d+/, `v1.${now + SESSION_MS * 2}`))).toBe(false);
    expect(new RemoteSessions(SECRET, { ...CFG, passwordHashText: 'outro-hash' }, () => now).verify(token)).toBe(false);
    expect(sessions.verify(undefined)).toBe(false);
    expect(sessions.verify('lixo')).toBe(false);
    now += SESSION_MS + 1;
    expect(sessions.verify(token)).toBe(false);
  });

  it('revoke encerra só aquele token, e a lista sobrevive a um reinício', () => {
    const now = 1_800_000_000_000;
    const tmp = tempDir();
    const file = join(tmp.dir, 'data', 'remote-revoked.json');
    const sessions = new RemoteSessions(SECRET, CFG, () => now, file);
    const phone = sessions.issue().token;
    const other = new RemoteSessions(SECRET, CFG, () => now + 1).issue().token;
    sessions.revoke(phone);
    sessions.revoke('lixo');
    expect(sessions.verify(phone)).toBe(false);
    expect(sessions.verify(other)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new RemoteSessions(SECRET, CFG, () => now, file);
    expect(restarted.verify(phone)).toBe(false);
    expect(restarted.verify(other)).toBe(true);
    tmp.cleanup();
  });

  it('loadSecret cria o segredo com permissão 600 e o reaproveita', () => {
    const tmp = tempDir();
    const file = join(tmp.dir, 'data', 'remote-secret');
    const a = loadSecret(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(a.toString('hex'));
    expect(loadSecret(file).equals(a)).toBe(true);
    tmp.cleanup();
  });
});

describe('LoginThrottle', () => {
  it('libera 4 falhas, depois espera 1 s, 2 s... e zera ao acertar', () => {
    let now = 0;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 4; i++) t.fail();
    expect(t.retryAfter()).toBe(0);
    t.fail();
    expect(t.retryAfter()).toBe(1);
    now += 1000;
    t.fail();
    expect(t.retryAfter()).toBe(2);
    t.succeed();
    expect(t.retryAfter()).toBe(0);
  });

  it('uma tentativa por vez, contada como falha antes de conferir a senha', () => {
    let now = 0;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 4; i++) {
      expect(t.begin()).toBe(true);
      expect(t.begin()).toBe(false);
      t.end(false);
    }
    // 5ª tentativa: já conta antes do fim, então a 6ª espera mesmo com a 5ª ainda conferindo.
    expect(t.begin()).toBe(true);
    expect(t.retryAfter()).toBe(1);
    t.end(false);
    expect(t.begin()).toBe(false);
    now += 1000;
    expect(t.begin()).toBe(true);
    t.end(true);
    expect(t.retryAfter()).toBe(0);
  });
});

describe('readCookie', () => {
  it('acha o cookie pelo nome', () => {
    expect(readCookie('a=1; habblaud_remote=v1.x.y; b=2', COOKIE)).toBe('v1.x.y');
    expect(readCookie(undefined, COOKIE)).toBeUndefined();
  });
});

interface Harness {
  hub: Hub;
  remoteBase: string;
  localBase: string;
  permissionCalls: string[];
  ptyCalls: string[];
  worldCalls: string[];
  spawn: SpawnService;
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Uma porta local (sem login) e uma remota (com login), sobre a MESMA API, como no server/index.ts. */
async function start(allow: RemoteFeature[] = ['permissions'], extra: Partial<ApiDeps> = {}): Promise<Harness> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
  });
  const allowSet = new Set(allow);
  // Mesma regra do server/index.ts.
  const hub = new Hub(office, {
    throttleMs: 10,
    canAnswer: (req) => (isRemoteRequest(req) ? allowSet.has('permissions') : isLoopbackHost(req.headers.host)),
  });
  hub.start();
  const permissionCalls: string[] = [];
  const ptyCalls: string[] = [];
  const worldCalls: string[] = [];
  const spawn = new SpawnService();
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: true,
    terminal: true,
    spawn,
    permissions: (req, res, path) => {
      req.resume();
      permissionCalls.push(`${isRemoteRequest(req) ? 'remote' : 'local'} ${req.method} ${path}`);
      sendJson(res, 200, { ok: true });
    },
    messages: (req, res) => {
      req.resume();
      sendJson(res, 200, { ok: true });
    },
    pty: (req, res, path) => {
      req.resume();
      ptyCalls.push(`${req.method} ${path}`);
      sendJson(res, 200, { ok: true });
    },
    renameRoom: () => 'sala',
    remote: { is: isRemoteRequest, allows: (f) => allowSet.has(f) },
    world: (req, res, url) => {
      req.resume();
      worldCalls.push(`${req.method} ${url.pathname}`);
      sendJson(res, 200, { ok: true });
    },
    ...extra,
  });
  const guard = createRequestGuard();
  const gate = createRemoteGate({ config: CFG, sessions: new RemoteSessions(SECRET, CFG), secure: false });
  const page = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Habblaud</title>');
  };
  const local = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) page(req, res);
  });
  const remote = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (gate(req, res, url)) return;
    if (!api(req, res, url)) page(req, res);
  });
  await new Promise<void>((ok) => local.listen(0, '127.0.0.1', ok));
  await new Promise<void>((ok) => remote.listen(0, '127.0.0.1', ok));
  const close = async () => {
    hub.stop();
    await new Promise<void>((ok) => local.close(() => ok()));
    await new Promise<void>((ok) => remote.close(() => ok()));
    tmp.cleanup();
  };
  closers.push(close);
  return {
    hub,
    localBase: `http://127.0.0.1:${(local.address() as AddressInfo).port}`,
    remoteBase: `http://127.0.0.1:${(remote.address() as AddressInfo).port}`,
    permissionCalls,
    ptyCalls,
    worldCalls,
    spawn,
    close,
  };
}

/** Requisição crua (o fetch do Node não deixa trocar o Host). */
function request(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = http.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

async function login(base: string): Promise<string> {
  const r = await request(base, '/api/remote/login', { method: 'POST', body: CREDS });
  expect(r.status).toBe(200);
  const setCookie = r.headers['set-cookie']?.[0] ?? '';
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  return setCookie.split(';')[0];
}

describe('porta remota', () => {
  it('anexo de mensagem (POST /api/attachments): com messages liberado; spawn sozinho não basta; o do Novo agente segue com spawn', async () => {
    const file = { name: 'foto.jpg', type: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') };
    const msg = await start(['permissions', 'messages'], { attachments: new AttachmentStore() });
    const c1 = await login(msg.remoteBase);
    const ok = await request(msg.remoteBase, '/api/attachments', { method: 'POST', body: file, headers: { Cookie: c1 } });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body)).toMatchObject({ id: expect.any(String), name: 'foto.jpg', size: 4 });
    expect((await request(msg.remoteBase, '/api/spawn/attachments', { method: 'POST', body: file, headers: { Cookie: c1 } })).status).toBe(403);

    const sp = await start(['permissions', 'spawn'], { attachments: new AttachmentStore() });
    const c2 = await login(sp.remoteBase);
    expect((await request(sp.remoteBase, '/api/attachments', { method: 'POST', body: file, headers: { Cookie: c2 } })).status).toBe(403);
    expect((await request(sp.remoteBase, '/api/spawn/attachments', { method: 'POST', body: file, headers: { Cookie: c2 } })).status).toBe(201);
    // Porta local com Host local: vale como antes.
    expect((await request(sp.localBase, '/api/attachments', { method: 'POST', body: file })).status).toBe(201);
    expect((await request(sp.localBase, '/api/attachments')).status).toBe(405);
    const off = await start(['permissions', 'messages']);
    const c3 = await login(off.remoteBase);
    expect((await request(off.remoteBase, '/api/attachments', { method: 'POST', body: file, headers: { Cookie: c3 } })).status).toBe(403);
  });

  it('logado: terminal interativo, rotas do hook e do plugin e o auxiliar nunca passam, nem com Host local', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn']);
    const cookie = await login(s.remoteBase);
    const headers = { Cookie: cookie, Host: 'localhost' };
    const blocked: Array<[string, string]> = [
      ['GET', '/api/pty'],
      ['POST', '/api/pty/x/input'],
      ['POST', '/api/agents/a1/stop'],
      ['POST', '/api/agents/a1/takeover'],
      ['POST', '/api/permissions'],
      ['GET', '/api/permissions/p1/wait'],
      ['POST', '/api/mod/inbox'],
      ['POST', '/api/mod/inbox/ack'],
      ['POST', '/api/codex/bridge/poll'],
      ['POST', '/api/codex/events'],
      ['POST', '/api/host/files/poll'],
      ['POST', '/api/host/attachments/poll'],
      ['POST', '/api/host/spawn/poll'],
    ];
    for (const [method, path] of blocked) {
      const r = await request(s.remoteBase, path, { method, headers, ...(method === 'POST' ? { body: {} } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(s.permissionCalls).toEqual([]);
    expect(s.ptyCalls).toEqual([]);
    // O que o celular usa continua passando: o detalhe e a decisão do pedido.
    expect((await request(s.remoteBase, '/api/permissions/p1', { headers })).status).toBe(200);
    expect((await request(s.remoteBase, '/api/permissions/p1/decision', { method: 'POST', body: { behavior: 'allow' }, headers })).status).toBe(200);
    expect(JSON.parse((await request(s.remoteBase, '/api/health', { headers })).body).pty).toBe(false);
    // O modo demonstração vale para todo mundo: o celular não liga nem desliga.
    expect((await request(s.remoteBase, '/api/demo', { method: 'POST', body: { enabled: true }, headers })).status).toBe(403);
    // Na porta local, o hook e o terminal interativo seguem como antes.
    expect((await request(s.localBase, '/api/permissions', { method: 'POST', body: {} })).status).toBe(200);
    expect((await request(s.localBase, '/api/pty')).status).toBe(200);
  });

  it('Habblaud World: nenhuma rota pela porta do celular, nem logado com tudo liberado e Host imitando localhost', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn']);
    const cookie = await login(s.remoteBase);
    const headers = { Cookie: cookie, Host: 'localhost' };
    const routes: Array<[string, string]> = [
      ['GET', '/api/world/status'],
      ['POST', '/api/world/register'],
      ['POST', '/api/world/verify'],
      ['POST', '/api/world/login'],
      ['POST', '/api/world/logout'],
      ['POST', '/api/world/resend'],
      ['POST', '/api/world/password/forgot'],
      ['POST', '/api/world/password/reset'],
      ['PUT', '/api/world/character'],
      ['PUT', '/api/world/visibility'],
      ['GET', '/api/world/devices'],
      ['POST', '/api/world/devices/d1/revoke'],
      ['PUT', '/api/world/theme'],
      ['POST', '/api/world/pause'],
      ['POST', '/api/world/resume'],
      ['GET', '/api/world/last-uplink'],
      ['POST', '/api/world/leave'],
      ['POST', '/api/world/join'],
      ['GET', '/api/world/stream'],
      ['POST', '/api/world/cmd'],
      ['POST', '/api/world/delete-account'],
      ['POST', '/api/world/delete-account/confirm'],
      ['GET', '/api/world/export'],
      ['POST', '/api/world/summary/seen'],
      ['POST', '/api/world/unblock'],
    ];
    for (const [method, path] of routes) {
      const r = await request(s.remoteBase, path, { method, headers, ...(method === 'GET' ? {} : { body: {} }) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(r.body).error.code).toBe('local_only');
    }
    expect(s.worldCalls).toEqual([]);
    expect(JSON.parse((await request(s.remoteBase, '/api/access', { headers })).body).world).toBe(false);
    // Na porta local, com Host local, as rotas chegam ao Habblaud World.
    expect((await request(s.localBase, '/api/world/status')).status).toBe(200);
    expect((await request(s.localBase, '/api/world/status', { headers: { Host: '192.168.0.10:4747' } })).status).toBe(403);
    expect(s.worldCalls).toEqual(['GET /api/world/status']);
    expect(JSON.parse((await request(s.localBase, '/api/access')).body).world).toBe(true);
  });

  it('novo agente: só com spawn liberado no celular; o auxiliar do host nunca pela porta remota', async () => {
    const s = await start(['permissions']);
    const cookie = await login(s.remoteBase);
    const body = { folder: '/Users/voce/projeto', prompt: 'oi' };
    expect((await request(s.remoteBase, '/api/spawn', { method: 'POST', body, headers: { Cookie: cookie } })).status).toBe(403);
    expect(JSON.parse((await request(s.remoteBase, '/api/access', { headers: { Cookie: cookie } })).body).spawn).toBe(false);

    const t = await start(['permissions', 'spawn']);
    const c2 = await login(t.remoteBase);
    expect(JSON.parse((await request(t.remoteBase, '/api/access', { headers: { Cookie: c2 } })).body).spawn).toBe(true);
    // Sem o auxiliar do host rodando: 409 com o motivo.
    const off = await request(t.remoteBase, '/api/spawn', { method: 'POST', body, headers: { Cookie: c2 } });
    expect(off.status).toBe(409);
    expect(off.body).toMatch(/codex:bridge/);
    expect((await request(t.remoteBase, '/api/host/spawn/poll', { method: 'POST', body: {}, headers: { Cookie: c2 } })).status).toBe(403);
    // O auxiliar (porta local) passa: o celular pede, o auxiliar busca, abre e confirma.
    expect(JSON.parse((await request(t.localBase, '/api/host/spawn/poll', { method: 'POST', body: {} })).body)).toEqual({ spawns: [] });
    const made = await request(t.remoteBase, '/api/spawn', { method: 'POST', body, headers: { Cookie: c2 } });
    expect(made.status).toBe(201);
    const { id } = JSON.parse(made.body);
    expect(JSON.parse((await request(t.localBase, '/api/host/spawn/poll', { method: 'POST', body: {} })).body).spawns).toEqual([{ id, ...body, files: [] }]);
    expect((await request(t.localBase, '/api/host/spawn/ack', { method: 'POST', body: { results: [{ id, ok: true }] } })).status).toBe(200);
    expect(JSON.parse((await request(t.remoteBase, `/api/spawn/${id}`, { headers: { Cookie: c2 } })).body).status).toBe('opened');
    expect((await request(t.localBase, '/api/spawn', { method: 'POST', body: { folder: 'relativa', prompt: '' } })).status).toBe(400);
  });

  it('login com o corpo pela metade não trava o login de mais ninguém', async () => {
    const s = await start();
    const hanging = http.request(new URL('/api/remote/login', s.remoteBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '200' },
    });
    hanging.on('error', () => {});
    hanging.write('{"user":"ana","pass');
    await new Promise((r) => setTimeout(r, 50));
    await login(s.remoteBase);
    hanging.destroy();
  });

  it('Sair: apaga o cookie e o mesmo token deixa de valer (mesmo guardado numa cópia)', async () => {
    const s = await start();
    const cookie = await login(s.remoteBase);
    expect((await request(s.remoteBase, '/api/access', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request(s.remoteBase, '/api/remote/logout', { headers: { Cookie: cookie } })).status).toBe(405);
    const out = await request(s.remoteBase, '/api/remote/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/);
    expect((await request(s.remoteBase, '/api/access', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request(s.remoteBase, '/', { headers: { Cookie: cookie } })).headers.location).toBe('/login');
  });

  it('sem login: a página vira /login e a API responde 401', async () => {
    const h = await start();
    const page = await request(h.remoteBase, '/');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    const loginPage = await request(h.remoteBase, '/login');
    expect(loginPage.status).toBe(200);
    expect(loginPage.body).toContain('/api/remote/login');
    expect(loginPage.headers['x-frame-options']).toBe('DENY');
    expect((await request(h.remoteBase, '/api/snapshot')).status).toBe(401);
    expect((await request(h.remoteBase, '/api/stream')).status).toBe(401);
    const decision = await request(h.remoteBase, '/api/permissions/p1/decision', { method: 'POST', body: { behavior: 'allow' } });
    expect(decision.status).toBe(401);
    expect(h.permissionCalls).toEqual([]);
  });

  it('sem login: só manifesto e ícones passam (o resto vira /login)', async () => {
    const h = await start();
    for (const path of ['/manifest.webmanifest', '/assets/brand/icon-192.png']) {
      expect((await request(h.remoteBase, path)).status, path).not.toBe(302);
    }
    for (const path of ['/sw.js', '/manifest.webmanifest.map', '/assets/brand/../index.html', '/assets/app.js']) {
      expect((await request(h.remoteBase, path)).status, path).toBe(302);
    }
  });

  it('senha errada: 401 sem cookie; certa: cookie de sessão e acesso à API', async () => {
    const h = await start();
    const wrong = await request(h.remoteBase, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: 'nope nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const cookie = await login(h.remoteBase);
    expect((await request(h.remoteBase, '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(200);
    const page = await request(h.remoteBase, '/', { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect((await request(h.remoteBase, '/login', { headers: { Cookie: cookie } })).headers.location).toBe('/');
  });

  it('logado: aprova permissões (o padrão) e o health diz o que vale nesta porta', async () => {
    const h = await start();
    const cookie = await login(h.remoteBase);
    const health = JSON.parse((await request(h.remoteBase, '/api/health', { headers: { Cookie: cookie } })).body);
    expect(health).toMatchObject({ remote: true, permissions: true, messages: false, terminal: false });
    const decision = await request(h.remoteBase, '/api/permissions/p1/decision', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { behavior: 'allow' },
    });
    expect(decision.status).toBe(200);
    expect(h.permissionCalls).toEqual(['remote POST /api/permissions/p1/decision']);
  });

  it('logado com Host imitando localhost: continua sem o que não foi liberado', async () => {
    const h = await start();
    const cookie = await login(h.remoteBase);
    const headers = { Cookie: cookie, Host: 'localhost' };
    for (const [path, body] of [
      ['/api/messages', { agentId: 'x', text: 'oi' }],
      ['/api/rooms/rename', { id: 'r', name: 'n' }],
    ] as const) {
      const r = await request(h.remoteBase, path, { method: 'POST', headers, body });
      expect(r.status, path).toBe(403);
      expect(JSON.parse(r.body).error).toMatch(/HABBLAUD_REMOTE_ALLOW/);
    }
    expect((await request(h.remoteBase, '/api/agents/x/terminal', { headers })).status).toBe(403);
    expect((await request(h.remoteBase, '/api/sessions/recent', { headers })).status).toBe(403);
  });

  it('HABBLAUD_REMOTE_ALLOW=messages libera mensagens e "none" tira até as permissões', async () => {
    const withMessages = await start(['messages']);
    const c1 = await login(withMessages.remoteBase);
    expect((await request(withMessages.remoteBase, '/api/messages', { method: 'POST', headers: { Cookie: c1 }, body: {} })).status).toBe(200);
    expect((await request(withMessages.remoteBase, '/api/permissions/p1/decision', { method: 'POST', headers: { Cookie: c1 }, body: {} })).status).toBe(403);
    const viewOnly = await start([]);
    const c2 = await login(viewOnly.remoteBase);
    expect((await request(viewOnly.remoteBase, '/api/permissions/p1/decision', { method: 'POST', headers: { Cookie: c2 }, body: {} })).status).toBe(403);
    expect((await request(viewOnly.remoteBase, '/api/snapshot', { headers: { Cookie: c2 } })).status).toBe(200);
  });

  it('login de outra origem é barrado pelo guard (CSRF)', async () => {
    const h = await start();
    const r = await request(h.remoteBase, '/api/remote/login', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: CREDS });
    expect(r.status).toBe(403);
  });

  it('aba Arquivos: o arquivo aberto é sempre a versão atual (nada de cache) e a checagem real recusa o que é protegido', async (ctx) => {
    const tmp = tempDir();
    try {
      mkdirSync(join(tmp.dir, 'docs'));
      mkdirSync(join(tmp.dir, '.ssh'));
      const doc = join(tmp.dir, 'docs', 'relatorio.md');
      writeFileSync(doc, 'versao 1');
      writeFileSync(join(tmp.dir, '.ssh', 'notas.md'), 'segredo');
      symlinkOrSkip(ctx.skip, join(tmp.dir, '.ssh', 'notas.md'), join(tmp.dir, 'docs', 'atalho.md'));
      const transcript = join(tmp.dir, 't.jsonl');
      writeLines(transcript, [
        L.assistant([L.tool('w1', 'Write', { file_path: doc, content: 'x' })]),
        L.assistant([L.tool('w2', 'Write', { file_path: join(tmp.dir, 'docs', 'atalho.md'), content: 'x' })]),
      ]);
      const s = await start(['terminal'], {
        agentFiles: new AgentFiles({ transcriptPathOf: () => transcript, cwdOf: () => tmp.dir }),
        files: new FileFetcher({ direct: true }),
      });
      const cookie = await login(s.remoteBase);
      const headers = { Cookie: cookie };
      const { files } = JSON.parse((await request(s.remoteBase, '/api/agents/a1/files', { headers })).body);
      const idOf = (name: string) => files.find((f: { name: string }) => f.name === name).id;
      const first = await request(s.remoteBase, `/api/agents/a1/files/${idOf('relatorio.md')}`, { headers });
      expect([first.status, first.body]).toEqual([200, 'versao 1']);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['cross-origin-resource-policy']).toBe('same-origin');
      writeFileSync(doc, 'versao 2, maior');
      const second = await request(s.remoteBase, `/api/agents/a1/files/${idOf('relatorio.md')}`, { headers });
      expect([second.status, second.body]).toEqual([200, 'versao 2, maior']);
      // O atalho parece um .md comum no caminho, mas aponta para dentro de .ssh: a checagem real, na hora de abrir, recusa.
      const link = await request(s.remoteBase, `/api/agents/a1/files/${idOf('atalho.md')}`, { headers });
      expect(link.status).toBe(403);
      expect(link.body).not.toContain('segredo');
      rmSync(doc);
      expect((await request(s.remoteBase, `/api/agents/a1/files/${idOf('relatorio.md')}`, { headers })).status).toBe(404);
    } finally {
      tmp.cleanup();
    }
  });

  it('aba Arquivos: só com terminal liberado; lista e abre pelo id, nunca pelo caminho', async () => {
    const tmp = tempDir();
    try {
      const transcript = join(tmp.dir, 't.jsonl');
      writeLines(transcript, [L.assistant([L.tool('w1', 'Write', { file_path: '/p/loja/relatorio.md', content: '# oi' })])]);
      const extra = {
        agentFiles: new AgentFiles({ transcriptPathOf: (id) => (id === 'a1' ? transcript : undefined), cwdOf: () => '/p/loja' }),
        files: new FileFetcher({ direct: true, check: (p: string) => ({ path: p, size: 4 }), read: () => Buffer.from('# oi') }),
      };
      const no = await start(['permissions'], extra);
      const c1 = await login(no.remoteBase);
      expect((await request(no.remoteBase, '/api/agents/a1/files', { headers: { Cookie: c1 } })).status).toBe(403);
      const yes = await start(['terminal'], extra);
      const c2 = await login(yes.remoteBase);
      const listed = JSON.parse((await request(yes.remoteBase, '/api/agents/a1/files', { headers: { Cookie: c2 } })).body);
      expect(listed.files).toEqual([expect.objectContaining({ name: 'relatorio.md', path: 'relatorio.md', kind: 'text' })]);
      const opened = await request(yes.remoteBase, `/api/agents/a1/files/${listed.files[0].id}`, { headers: { Cookie: c2 } });
      expect(opened.status).toBe(200);
      expect(opened.body).toBe('# oi');
      expect((await request(yes.remoteBase, '/api/agents/a1/files/nao-existe', { headers: { Cookie: c2 } })).status).toBe(404);
      expect((await request(yes.remoteBase, '/api/agents/a9/files', { headers: { Cookie: c2 } })).status).toBe(404);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('porta local (inalterada)', () => {
  it('sem login, vale a trava do Host local como antes', async () => {
    const h = await start();
    const ok = await request(h.localBase, '/api/permissions/p1/decision', { method: 'POST', body: { behavior: 'allow' } });
    expect(ok.status).toBe(200);
    const lanHost = await request(h.localBase, '/api/permissions/p1/decision', {
      method: 'POST',
      headers: { Host: '192.168.1.5:4747' },
      body: { behavior: 'allow' },
    });
    expect(lanHost.status).toBe(403);
    expect(JSON.parse(lanHost.body).error).toMatch(/próprio computador/);
    expect(h.permissionCalls).toEqual(['local POST /api/permissions/p1/decision']);
    const health = JSON.parse((await request(h.localBase, '/api/health')).body);
    expect(health).toMatchObject({ remote: false, permissions: true, messages: true });
  });
});

/** Abre o stream (SSE) e espera o primeiro pedaço; devolve como fechar. */
function openStream(base: string, headers: Record<string, string>): Promise<{ status: number; close: () => void }> {
  return new Promise((ok, fail) => {
    const req = http.request(new URL('/api/stream', base), { headers }, (res) => {
      res.once('data', () => ok({ status: res.statusCode ?? 0, close: () => req.destroy() }));
      if (res.statusCode !== 200) ok({ status: res.statusCode ?? 0, close: () => req.destroy() });
    });
    req.on('error', fail);
    req.end();
  });
}

describe('quem pode responder (o hook só espera se houver página que responda)', () => {
  it('celular logado com permissions conta como página que responde', async () => {
    const h = await start(['permissions']);
    const cookie = await login(h.remoteBase);
    expect(h.hub.localSize).toBe(0);
    const s = await openStream(h.remoteBase, { Cookie: cookie });
    expect(s.status).toBe(200);
    expect(h.hub.localSize).toBe(1);
    s.close();
  });

  it('celular só-ver não conta, nem imitando o Host local', async () => {
    const h = await start([]);
    const cookie = await login(h.remoteBase);
    const s = await openStream(h.remoteBase, { Cookie: cookie, Host: 'localhost' });
    expect(s.status).toBe(200);
    expect(h.hub.localSize).toBe(0);
    s.close();
  });
});

describe('GET /api/access (o que a página pode fazer)', () => {
  it('porta remota: só o liberado; porta local: tudo pelo Host local; Host da rede na local: nada', async () => {
    const h = await start(['permissions']);
    const cookie = await login(h.remoteBase);
    expect(JSON.parse((await request(h.remoteBase, '/api/access', { headers: { Cookie: cookie, Host: 'localhost' } })).body)).toEqual({
      remote: true,
      local: false,
      permissions: true,
      messages: false,
      terminal: false,
      spawn: false,
      world: false,
      pty: false,
    });
    expect(JSON.parse((await request(h.localBase, '/api/access')).body)).toEqual({ remote: false, local: true, permissions: true, messages: true, terminal: false, spawn: true, world: true, pty: true });
    expect(JSON.parse((await request(h.localBase, '/api/access', { headers: { Host: '192.168.1.5:4747' } })).body)).toMatchObject({
      local: false,
      permissions: false,
      messages: false,
      spawn: false,
      world: false,
    });
    expect((await request(h.remoteBase, '/api/access')).status).toBe(401);
  });
});

describe('cookie Secure e download da CA', () => {
  it('com HTTPS o cookie leva Secure; /remote/ca.crt é público e só existe com a CA', async () => {
    const tmp = tempDir();
    const caFile = join(tmp.dir, 'ca.crt');
    const gate = createRemoteGate({ config: CFG, sessions: new RemoteSessions(SECRET, CFG), secure: true, caFile });
    const server = http.createServer((req, res) => {
      if (!gate(req, res, new URL(req.url ?? '/', 'http://x'))) {
        res.writeHead(204);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      tmp.cleanup();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await request(base, '/api/remote/login', { method: 'POST', body: CREDS });
    expect(r.headers['set-cookie']?.[0]).toMatch(/; Secure$/);
    expect((await request(base, '/remote/ca.crt')).status).toBe(404);
    expect((await request(base, '/login')).body).not.toContain('/remote/ca.crt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    const ca = await request(base, '/remote/ca.crt');
    expect(ca.status).toBe(200);
    expect(ca.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect((await request(base, '/login')).body).toContain('/remote/ca.crt');
  });
});

describe('RemoteSessions — senha conferida há pouco (terminal pelo celular)', () => {
  it('o login conta como conferência; vence em CONFIRM_MS; confirm renova; token inválido ou encerrado não', () => {
    let now = 1_800_000_000_000;
    const s = new RemoteSessions(SECRET, CFG, () => now);
    const { token } = s.issue();
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(true);
    now += CONFIRM_MS;
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(false);
    expect(s.confirm(token)).toBe(true);
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(true);
    expect(s.confirm('v1.1800000000000.x')).toBe(false);
    expect(s.confirmedWithin(undefined, CONFIRM_MS)).toBe(false);
    s.revoke(token);
    expect(s.confirm(token)).toBe(false);
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(false);
  });

  it('cada token tem a sua conferência (outro aparelho não herda)', () => {
    let now = 1_800_000_000_000;
    const s = new RemoteSessions(SECRET, CFG, () => now);
    const a = s.issue().token;
    now += 1_000;
    const b = s.issue().token;
    now += CONFIRM_MS - 500;
    expect(s.confirmedWithin(a, CONFIRM_MS)).toBe(false);
    expect(s.confirmedWithin(b, CONFIRM_MS)).toBe(true);
  });

  it('terminais da sessão: só registra com a senha recente; é por token; Sair apaga', () => {
    let now = 1_800_000_000_000;
    const s = new RemoteSessions(SECRET, CFG, () => now);
    const a = s.issue().token;
    now += 1_000;
    const b = s.issue().token;
    expect(s.claim(a, 'p1')).toBe(true);
    expect(s.owns(a, 'p1')).toBe(true);
    expect(s.owns(a, 'p2')).toBe(false);
    expect(s.owns(b, 'p1')).toBe(false);
    expect(s.owns(undefined, 'p1')).toBe(false);
    expect(s.claim('v1.1800000000000.x', 'p1')).toBe(false);
    now += CONFIRM_MS;
    expect(s.claim(a, 'p2')).toBe(false);
    expect(s.owns(a, 'p2')).toBe(false);
    expect(s.owns(a, 'p1')).toBe(true);
    s.revoke(a);
    expect(s.owns(a, 'p1')).toBe(false);
    expect(s.confirm(a)).toBe(false);
  });
});

describe('/api/remote/confirm (senha de novo)', () => {
  it('sem login 401; logado: GET diz se está em dia, senha errada 401, certa 200, outro método 405', async () => {
    const s = await start();
    expect((await request(s.remoteBase, '/api/remote/confirm')).status).toBe(401);
    expect((await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD } })).status).toBe(401);
    const cookie = await login(s.remoteBase);
    const fresh = await request(s.remoteBase, '/api/remote/confirm', { headers: { Cookie: cookie } });
    expect(fresh.status).toBe(200);
    expect(JSON.parse(fresh.body)).toEqual({ fresh: true });
    const wrong = await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: 'errada' }, headers: { Cookie: cookie } });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body).error).toBe('Senha incorreta.');
    const ok = await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD }, headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect((await request(s.remoteBase, '/api/remote/confirm', { method: 'PUT', body: {}, headers: { Cookie: cookie } })).status).toBe(405);
  });
});
