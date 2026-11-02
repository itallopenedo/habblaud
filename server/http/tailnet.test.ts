import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { createTailnetGate, DEFAULT_TAILNET_PORT, isTailnetRequest, parseTailnetConfig, ptyNeedsConfirm, startTailnetListener } from './tailnet';
import { AccountsService } from '../accounts/service';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { hashPassword, parsePasswordHash } from '../remote/password';
import { tempDir } from '../test/fixtures';
import { createApiHandler, sendJson } from './app';
import { createRequestGuard } from './guard';
import { CONFIRM_MS, COOKIE, createRemoteGate, isRemoteRequest, LoginThrottle, readCookie, RemoteSessions, type RemoteFeature } from './remote';
import { Hub } from './sse';
import { TerminalStreams } from './terminal';

setQuiet(true);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function listen(server: http.Server): Promise<string> {
  return new Promise((ok) => {
    const done = () => {
      closers.push(() => new Promise<void>((c) => server.close(() => c())));
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    };
    if (server.listening) done();
    else server.once('listening', done);
  });
}

describe('porta da tailnet: configuração', () => {
  it('desligada sem HABBLAUD_TAILNET_USER', () => {
    expect(parseTailnetConfig({}, false, true)).toEqual({});
  });
  it('liga com o usuário (em minúsculas) e a porta padrão; porta inválida volta ao padrão', () => {
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: ' Ana@Example.com ' }, false, true)).toEqual({ config: { port: DEFAULT_TAILNET_PORT, user: 'ana@example.com' } });
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_TAILNET_PORT: '5000' }, false, true).config?.port).toBe(5000);
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_TAILNET_PORT: '99999' }, false, true).config?.port).toBe(DEFAULT_TAILNET_PORT);
  });
  it('no Docker e sem o acesso remoto com login: desligada, com o motivo', () => {
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b' }, true, true)).toEqual({ warning: expect.stringMatching(/Docker/) });
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b' }, false, false)).toEqual({ warning: expect.stringMatching(/remote:setup/) });
  });
});

describe('porta da tailnet: escuta e cabeçalho do Tailscale', () => {
  it('escuta só em 127.0.0.1; sem o cabeçalho ou com outro usuário: 403; o usuário certo (qualquer caixa) passa e fica marcado', async () => {
    const gate = createTailnetGate({ user: 'ana@example.com' });
    const marked: boolean[] = [];
    const server = startTailnetListener(
      0,
      (req, res) => {
        if (gate(req, res)) return;
        marked.push(isTailnetRequest(req));
        res.writeHead(200);
        res.end('ok');
      },
      { error: () => {} },
    );
    const base = await listen(server);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    const status = (headers: Record<string, string>) => fetch(`${base}/api/health`, { headers }).then((r) => r.status);
    expect(await status({})).toBe(403);
    expect(await status({ 'Tailscale-User-Login': 'bob@example.com' })).toBe(403);
    expect(await status({ 'Tailscale-User-Login': '' })).toBe(403);
    expect(await status({ 'Tailscale-User-Login': 'Ana@Example.com' })).toBe(200);
    expect(marked).toEqual([true]);
  });

  it('ptyNeedsConfirm: abrir, assumir, encerrar e o stream; a lista, digitar, redimensionar e fechar não', () => {
    expect(ptyNeedsConfirm('POST', '/api/pty')).toBe(true);
    expect(ptyNeedsConfirm('POST', '/api/agents/acc%3A1/takeover')).toBe(true);
    expect(ptyNeedsConfirm('POST', '/api/agents/acc%3A1/stop')).toBe(true);
    expect(ptyNeedsConfirm('GET', '/api/pty/p1/stream')).toBe(true);
    expect(ptyNeedsConfirm('GET', '/api/pty')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/input')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/resize')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/close')).toBe(false);
  });
});

const SECRET = Buffer.alloc(32, 9);
const PASSWORD = 'senha do terminal';
const HASH_TEXT = await hashPassword(PASSWORD, 10);
const CFG = { user: 'ana', passwordHash: parsePasswordHash(HASH_TEXT)!, passwordHashText: HASH_TEXT };
const TS_HOST = 'mac.tail.ts.net:8443';
const TS = { Host: TS_HOST, 'Tailscale-User-Login': 'ana@example.com' };

/** Porta do celular na rede (LAN) e porta da tailnet sobre a MESMA API, sessões e freio, como no server/index.ts. */
async function start(allow: RemoteFeature[]) {
  let clock = Date.now();
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10, canAnswer: () => false });
  hub.start();
  const terminals = new TerminalStreams({ office, transcriptPathOf: () => undefined });
  const allowSet = new Set(allow);
  const sessions = new RemoteSessions(SECRET, CFG, () => clock);
  const throttle = new LoginThrottle(() => clock);
  const ptyCalls: string[] = [];
  const ok = (req: http.IncomingMessage, res: http.ServerResponse) => {
    req.resume();
    sendJson(res, 200, { ok: true });
  };
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    terminal: true,
    terminals,
    permissions: ok,
    messages: ok,
    world: (req, res) => ok(req, res),
    pty: (req, res, path) => {
      ptyCalls.push(`${req.method} ${path}`);
      ok(req, res);
    },
    remote: {
      is: isRemoteRequest,
      allows: (f) => allowSet.has(f),
      tailnet: isTailnetRequest,
      confirmed: (req) => sessions.confirmedWithin(readCookie(req.headers.cookie, COOKIE), CONFIRM_MS),
    },
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['mac.tail.ts.net']) });
  const lanGate = createRemoteGate({ config: CFG, sessions, secure: false, throttle });
  const tsGate = createRemoteGate({ config: CFG, sessions, secure: true, throttle });
  const tailnetGate = createTailnetGate({ user: 'ana@example.com' });
  const page = (res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Habblaud</title>');
  };
  const lan = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (lanGate(req, res, url)) return;
    if (!api(req, res, url)) page(res);
  });
  lan.listen(0, '127.0.0.1');
  const tailnet = startTailnetListener(
    0,
    (req, res) => {
      if (guard(req, res)) return;
      if (tailnetGate(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      if (tsGate(req, res, url)) return;
      if (!api(req, res, url)) page(res);
    },
    { error: () => {} },
  );
  const lanBase = await listen(lan);
  const tsBase = await listen(tailnet);
  closers.push(async () => {
    terminals.stop();
    hub.stop();
    tmp.cleanup();
  });
  return { lanBase, tsBase, ptyCalls, advance: (ms: number) => void (clock += ms) };
}

/** Requisição crua (o fetch do Node não deixa trocar o Host). */
function request(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, fail) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

async function login(base: string, headers: Record<string, string> = {}): Promise<{ cookie: string; setCookie: string }> {
  const r = await request(base, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: PASSWORD }, headers });
  expect(r.status).toBe(200);
  const setCookie = r.headers['set-cookie']?.[0] ?? '';
  return { cookie: setCookie.split(';')[0], setCookie };
}

const PTY_ROUTES: Array<[string, string]> = [
  ['GET', '/api/pty'],
  ['POST', '/api/pty'],
  ['POST', '/api/pty/p1/input'],
  ['GET', '/api/pty/p1/stream'],
  ['POST', '/api/agents/a1/takeover'],
  ['POST', '/api/agents/a1/stop'],
];
const call = (base: string, [method, path]: [string, string], headers: Record<string, string>) =>
  request(base, path, { method, headers, ...(method === 'POST' ? { body: {} } : {}) });

describe('terminal interativo: LAN x tailnet', () => {
  it('LAN (4748) logado com pty liberado: o terminal interativo continua recusado (403) e health/access dizem pty false', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.lanBase);
    for (const r of PTY_ROUTES) expect((await call(s.lanBase, r, { Cookie: cookie })).status, r.join(' ')).toBe(403);
    expect(s.ptyCalls).toEqual([]);
    expect(JSON.parse((await request(s.lanBase, '/api/health', { headers: { Cookie: cookie } })).body).pty).toBe(false);
    expect(JSON.parse((await request(s.lanBase, '/api/access', { headers: { Cookie: cookie } })).body).pty).toBe(false);
  });

  it('tailnet sem o cabeçalho do Tailscale: 403 em tudo, até no login e na página', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/health', { headers: { Host: TS_HOST } })).status).toBe(403);
    expect((await request(s.tsBase, '/login', { headers: { Host: TS_HOST } })).status).toBe(403);
    expect((await request(s.tsBase, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: PASSWORD }, headers: { Host: TS_HOST } })).status).toBe(403);
  });

  it('tailnet com outro usuário do Tailscale: 403', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/health', { headers: { ...TS, 'Tailscale-User-Login': 'bob@example.com' } })).status).toBe(403);
  });

  it('tailnet sem login: API 401 e a página vai para /login', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/pty', { headers: TS })).status).toBe(401);
    const page = await request(s.tsBase, '/', { headers: TS });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
  });

  it('tailnet logado sem pty liberado: terminal interativo 403; o resto liberado funciona', async () => {
    const s = await start(['permissions', 'terminal']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    for (const r of PTY_ROUTES) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(403);
    expect((await request(s.tsBase, '/api/snapshot', { headers: h })).status).toBe(200);
    expect(JSON.parse((await request(s.tsBase, '/api/access', { headers: h })).body)).toMatchObject({ remote: true, terminal: true, pty: false });
  });

  it('tailnet logado com pty: lista, abre, assume, liga a tela e digita (200); health e access dizem pty true', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    for (const r of PTY_ROUTES) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(200);
    expect(s.ptyCalls).toEqual(PTY_ROUTES.map(([m, p]) => `${m} ${p}`));
    expect(JSON.parse((await request(s.tsBase, '/api/health', { headers: h })).body).pty).toBe(true);
    expect(JSON.parse((await request(s.tsBase, '/api/access', { headers: h })).body).pty).toBe(true);
  });

  it('senha conferida há mais de 10 min: abrir, assumir, encerrar e a tela pedem a senha (401 reauth); a lista e digitar não; confirmar libera', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    s.advance(CONFIRM_MS + 1);
    for (const r of [PTY_ROUTES[1], PTY_ROUTES[3], PTY_ROUTES[4], PTY_ROUTES[5]]) {
      const res = await call(s.tsBase, r, h);
      expect(res.status, r.join(' ')).toBe(401);
      expect(JSON.parse(res.body).code).toBe('reauth');
    }
    expect((await call(s.tsBase, PTY_ROUTES[0], h)).status).toBe(200);
    expect((await call(s.tsBase, PTY_ROUTES[2], h)).status).toBe(200);
    expect((await request(s.tsBase, '/api/remote/confirm', { method: 'POST', body: { password: 'errada' }, headers: h })).status).toBe(401);
    expect((await request(s.tsBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD }, headers: h })).status).toBe(200);
    expect((await call(s.tsBase, PTY_ROUTES[1], h)).status).toBe(200);
  });

  it('tailnet: as rotas só do próprio computador, o World e o demo continuam recusados, mesmo logado com tudo', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    const blocked: Array<[string, string]> = [
      ['POST', '/api/permissions'],
      ['GET', '/api/permissions/p1/wait'],
      ['POST', '/api/mod/inbox'],
      ['POST', '/api/codex/events'],
      ['POST', '/api/codex/bridge/poll'],
      ['POST', '/api/host/files/poll'],
      ['POST', '/api/host/attachments/poll'],
      ['POST', '/api/host/spawn/poll'],
      ['POST', '/api/host/dictation/poll'],
      ['GET', '/api/world/account'],
      ['POST', '/api/demo'],
    ];
    for (const r of blocked) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(403);
  });

  it('login pela tailnet: cookie com Secure (o TLS está no tailscale serve); o login da LAN vale na tailnet (mesmas sessões)', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const ts = await login(s.tsBase, TS);
    expect(ts.setCookie).toMatch(/; Secure/);
    expect(ts.setCookie).toMatch(/HttpOnly/);
    expect(ts.setCookie).toMatch(/SameSite=Strict/);
    const lan = await login(s.lanBase);
    expect((await request(s.tsBase, '/api/snapshot', { headers: { ...TS, Cookie: lan.cookie } })).status).toBe(200);
  });

  it('tailnet: Origin de outro site é barrado pelo guard antes de tudo', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const r = await request(s.tsBase, '/api/pty', { method: 'POST', body: {}, headers: { ...TS, Cookie: cookie, Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(s.ptyCalls).toEqual([]);
  });
});
