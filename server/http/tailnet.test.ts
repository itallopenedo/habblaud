import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { createTailnetGate, createTailnetRemoteGate, DEFAULT_TAILNET_PORT, isTailnetRequest, parseTailnetConfig, ptyRemoteNeeds, startTailnetListener } from './tailnet';
import { AccountsService } from '../accounts/service';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { hashPassword, parsePasswordHash } from '../remote/password';
import { PtyError, type PtyManager } from '../pty/manager';
import { tempDir } from '../test/fixtures';
import { createApiHandler, sendJson } from './app';
import { createRequestGuard } from './guard';
import { createPtyRoutes } from './pty';
import { CONFIRM_MS, COOKIE, createRemoteGate, isRemoteRequest, LoginThrottle, readCookie, RemoteSessions, type RemoteConfig, type RemoteFeature } from './remote';
import { Hub } from './sse';
import { TerminalStreams } from './terminal';
import { createHermesIngest } from '../hermes/http';
import type { HermesEvent } from '../sources/hermes/source';

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
    // Pelo Funnel (internet pública), nunca, mesmo com o usuário certo.
    expect(await status({ 'Tailscale-User-Login': 'ana@example.com', 'Tailscale-Funnel-Request': '?1' })).toBe(403);
    expect(marked).toEqual([true]);
  });

  it('ptyRemoteNeeds: a lista não pede nada; teclas, tamanho e fechar pedem o terminal ser da sessão; o resto, a senha', () => {
    expect(ptyRemoteNeeds('GET', '/api/pty')).toBeNull();
    expect(ptyRemoteNeeds('POST', '/api/pty/p1/input')).toEqual({ owner: 'p1' });
    expect(ptyRemoteNeeds('POST', '/api/pty/a%3Ab/resize')).toEqual({ owner: 'a:b' });
    expect(ptyRemoteNeeds('POST', '/api/pty/p1/close')).toEqual({ owner: 'p1' });
    for (const [m, p] of [
      ['POST', '/api/pty'],
      ['POST', '/api/agents/acc%3A1/takeover'],
      ['POST', '/api/agents/acc%3A1/stop'],
      ['GET', '/api/pty/p1/stream'],
      // Variantes do caminho: falha fechado (pedem a senha).
      ['POST', '/api/pty/'],
      ['POST', '/api/pty//'],
      ['GET', '/api/pty/p1/stream/'],
      ['GET', '/api/pty//p1/stream'],
      ['GET', '/api/pty/p1/stream/x'],
      ['GET', '/api/pty/'],
      ['HEAD', '/api/pty'],
      ['POST', '/api/pty/p1/input/'],
      ['POST', '/api/pty//p1/input'],
      ['GET', '/api/pty/p1/input'],
      ['POST', '/api/pty/%E0%A4%A/input'],
    ]) expect(ptyRemoteNeeds(m, p), `${m} ${p}`).toBe('confirm');
  });
});

const SECRET = Buffer.alloc(32, 9);
const PASSWORD = 'senha do terminal';
const HASH_TEXT = await hashPassword(PASSWORD, 10);
const CFG = { user: 'ana', passwordHash: parsePasswordHash(HASH_TEXT)!, passwordHashText: HASH_TEXT };
const TS_HOST = 'mac.tail.ts.net:8443';
const TS = { Host: TS_HOST, 'Tailscale-User-Login': 'ana@example.com' };
const HERMES_TOKEN = 'tok_'.padEnd(43, 'h');
const HERMES_HASH = createHash('sha256').update(HERMES_TOKEN).digest();
const HERMES_AUTH = { Authorization: `Bearer ${HERMES_TOKEN}` };
const HERMES_BODY = { v: 1, events: [{ profile: 'Íon', session: '0123456789abcdef', event: 'on_session_start', at: 1_800_000_000_000 }] };

/**
 * Porta do celular na rede (LAN) e porta da tailnet sobre a MESMA API e as mesmas sessões, como no server/index.ts; o
 * freio do login é um por porta (o da tailnet vem de createTailnetRemoteGate).
 */
/** PtyManager de mentira para o roteador de verdade (createPtyRoutes): m1 e m2 foram abertos no Mac. */
function fakePtys(calls: string[]): PtyManager {
  const known = new Set(['m1', 'm2']);
  let n = 0;
  const get = (id: string) => {
    if (!known.has(id)) throw new PtyError(404, 'terminal não encontrado');
  };
  return {
    status: () => ({ enabled: true }),
    list: () => [...known].map((id) => ({ id })),
    create: () => {
      const id = `p${++n}`;
      known.add(id);
      calls.push(`create ${id}`);
      return { id };
    },
    takeover: async (agentId: string) => {
      const id = `p${++n}`;
      known.add(id);
      calls.push(`takeover ${agentId} ${id}`);
      return { id };
    },
    stop: async (agentId: string) => void calls.push(`stop ${agentId}`),
    attach: (id: string, _req: http.IncomingMessage, res: http.ServerResponse) => {
      get(id);
      calls.push(`attach ${id}`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('retry: 2000\n\n');
    },
    input: (id: string) => (get(id), void calls.push(`input ${id}`)),
    resize: (id: string) => (get(id), void calls.push(`resize ${id}`)),
    close: (id: string) => (get(id), void calls.push(`close ${id}`)),
  } as unknown as PtyManager;
}

async function start(allow: RemoteFeature[], opts: { realPty?: boolean; caFile?: string } = {}) {
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
    pty: opts.realPty
      ? createPtyRoutes(fakePtys(ptyCalls), { tailnet: isTailnetRequest, claim: (req, id) => void sessions.claim(readCookie(req.headers.cookie, COOKIE), id) })
      : (req, res, path) => {
          ptyCalls.push(`${req.method} ${path}`);
          ok(req, res);
        },
    remote: {
      is: isRemoteRequest,
      allows: (f) => allowSet.has(f),
      tailnet: isTailnetRequest,
      confirmed: (req) => sessions.confirmedWithin(readCookie(req.headers.cookie, COOKIE), CONFIRM_MS),
      owns: (req, id) => sessions.owns(readCookie(req.headers.cookie, COOKIE), id),
    },
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['mac.tail.ts.net']) });
  const lanGate = createRemoteGate({ config: CFG, sessions, secure: false, throttle, caFile: opts.caFile });
  // Como no index.ts: a configuração remota inteira (com a CA da rede local, se houver).
  const remote: Pick<RemoteConfig, 'user' | 'passwordHash' | 'tls'> = { ...CFG, tls: opts.caFile ? { dir: '', keyFile: '', certFile: '', caFile: opts.caFile } : undefined };
  const tsGate = createTailnetRemoteGate(remote, sessions);
  const tailnetGate = createTailnetGate({ user: 'ana@example.com' });
  const page = (res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Habblaud</title>');
  };
  // Eventos do Hermes: como no index.ts, só no listener da tailnet, depois do usuário do Tailscale e antes do login.
  const hermesApplied: HermesEvent[] = [];
  const hermesIngest = createHermesIngest({ tokenHash: HERMES_HASH, apply: (evs) => void hermesApplied.push(...evs) });
  // A porta local (4747): só o guard e a API, como no index.ts.
  const local = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) page(res);
  });
  local.listen(0, '127.0.0.1');
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
      if (hermesIngest(req, res, url)) return;
      if (tsGate(req, res, url)) return;
      if (!api(req, res, url)) page(res);
    },
    { error: () => {} },
  );
  const localBase = await listen(local);
  const lanBase = await listen(lan);
  const tsBase = await listen(tailnet);
  closers.push(async () => {
    terminals.stop();
    hub.stop();
    tmp.cleanup();
  });
  return { localBase, lanBase, tsBase, ptyCalls, hermesApplied, advance: (ms: number) => void (clock += ms) };
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

  it('senha conferida há mais de 10 min: abrir, assumir, encerrar, a tela e digitar num terminal que não é da sessão pedem a senha (401 reauth); a lista não; confirmar libera', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    s.advance(CONFIRM_MS + 1);
    const stale: Array<[string, string]> = [
      PTY_ROUTES[1],
      PTY_ROUTES[2],
      PTY_ROUTES[3],
      PTY_ROUTES[4],
      PTY_ROUTES[5],
      // Variantes do caminho não pulam a senha.
      ['POST', '/api/pty/'],
      ['POST', '/api/pty//'],
      ['GET', '/api/pty/p1/stream/'],
      ['GET', '/api/pty//p1/stream'],
      ['GET', '/api/pty/p1/stream/x'],
    ];
    for (const r of stale) {
      const res = await call(s.tsBase, r, h);
      expect(res.status, r.join(' ')).toBe(401);
      expect(JSON.parse(res.body).code, r.join(' ')).toBe('reauth');
    }
    expect(s.ptyCalls).toEqual([]);
    expect((await call(s.tsBase, PTY_ROUTES[0], h)).status).toBe(200);
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

  it('freio próprio na tailnet: senhas erradas na LAN (4748) não travam a senha de novo pela tailnet', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    s.advance(CONFIRM_MS + 1);
    let lan = 0;
    for (let i = 0; i < 8 && lan !== 429; i++) {
      lan = (await request(s.lanBase, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: 'errada' } })).status;
    }
    expect(lan).toBe(429);
    expect((await request(s.tsBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD }, headers: h })).status).toBe(200);
  });

  it('tailnet: sem o link nem o download da CA da rede local (o certificado do .ts.net é público)', async () => {
    const tmp = tempDir();
    const caFile = join(tmp.dir, 'ca.crt');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    closers.push(async () => tmp.cleanup());
    const s = await start(['permissions'], { caFile });
    expect((await request(s.lanBase, '/login')).body).toContain('/remote/ca.crt');
    expect((await request(s.tsBase, '/login', { headers: TS })).body).not.toContain('/remote/ca.crt');
    expect((await request(s.tsBase, '/remote/ca.crt', { headers: TS })).status).toBe(404);
  });

  it('tailnet: Origin de outro site é barrado pelo guard antes de tudo', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const r = await request(s.tsBase, '/api/pty', { method: 'POST', body: {}, headers: { ...TS, Cookie: cookie, Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(s.ptyCalls).toEqual([]);
  });
});

describe('terminal interativo pela tailnet com o roteador de verdade (createPtyRoutes)', () => {
  it('senha vencida: nenhuma variante do caminho chega ao terminal; com a senha recente, as variantes dão 404', async () => {
    const s = await start(['permissions', 'terminal', 'pty'], { realPty: true });
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    const variants: Array<[string, string]> = [
      ['POST', '/api/pty/'],
      ['POST', '/api/pty//'],
      ['GET', '/api/pty/m1/stream/'],
      ['GET', '/api/pty//m1/stream'],
      ['GET', '/api/pty/m1/stream/x'],
      ['POST', '/api/pty/m1/input/'],
      ['POST', '/api/pty//m1/input'],
      ['POST', '/api/pty/m1'],
    ];
    for (const r of variants) expect((await call(s.tsBase, r, h)).status, `fresca ${r.join(' ')}`).toBe(404);
    s.advance(CONFIRM_MS + 1);
    for (const r of variants) {
      const res = await call(s.tsBase, r, h);
      expect(res.status, `vencida ${r.join(' ')}`).toBe(401);
      expect(JSON.parse(res.body).code).toBe('reauth');
    }
    expect(s.ptyCalls).toEqual([]);
  });

  it('senha vencida: teclas, tamanho e fechar só nos terminais que esta sessão abriu, assumiu ou ligou com a senha recente', async () => {
    const s = await start(['permissions', 'terminal', 'pty'], { realPty: true });
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    const created = await call(s.tsBase, ['POST', '/api/pty'], h);
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body).id).toBe('p1');
    expect((await call(s.tsBase, ['POST', '/api/agents/a1/takeover'], h)).status).toBe(201);
    expect((await call(s.tsBase, ['GET', '/api/pty/m1/stream'], h)).status).toBe(200);
    s.advance(CONFIRM_MS + 1);
    for (const id of ['p1', 'p2', 'm1']) {
      for (const act of ['input', 'resize']) expect((await call(s.tsBase, ['POST', `/api/pty/${id}/${act}`], h)).status, `${id} ${act}`).toBe(204);
    }
    // m2 foi aberto no Mac e esta sessão nunca o ligou: sem a senha recente, nem digitar, nem fechar.
    for (const act of ['input', 'resize', 'close']) {
      const res = await call(s.tsBase, ['POST', `/api/pty/m2/${act}`], h);
      expect(res.status, `m2 ${act}`).toBe(401);
      expect(JSON.parse(res.body).code).toBe('reauth');
    }
    expect((await call(s.tsBase, ['GET', '/api/pty'], h)).status).toBe(200);
    expect((await call(s.tsBase, ['POST', '/api/pty/p1/close'], h)).status).toBe(204);
    expect(s.ptyCalls.filter((c) => c.includes('m2'))).toEqual([]);

    // Outra sessão (login pela LAN, outro token) não herda os terminais desta.
    const other = { ...TS, Cookie: (await login(s.lanBase)).cookie };
    s.advance(CONFIRM_MS + 1);
    expect((await call(s.tsBase, ['POST', '/api/pty/p2/input'], other)).status).toBe(401);
    // Sair encerra o token e os terminais dele.
    expect((await request(s.tsBase, '/api/remote/logout', { method: 'POST', body: {}, headers: h })).status).toBe(200);
    expect((await call(s.tsBase, ['POST', '/api/pty/p2/input'], h)).status).toBe(401);
  });

  it('origem errada com a senha vencida: 403 (a origem é conferida antes de pedir a senha)', async () => {
    const s = await start(['permissions', 'terminal', 'pty'], { realPty: true });
    const { cookie } = await login(s.tsBase, TS);
    s.advance(CONFIRM_MS + 1);
    const h = { ...TS, Cookie: cookie };
    // A 443 (outra origem, liberada no guard) não manda no terminal da 8443.
    expect((await call(s.tsBase, ['POST', '/api/pty'], { ...h, Origin: 'https://mac.tail.ts.net' })).status).toBe(403);
    expect((await call(s.tsBase, ['GET', '/api/pty/m1/stream'], { ...h, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(s.tsBase, ['GET', '/api/pty/m1/stream'], { ...h, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(s.ptyCalls).toEqual([]);
  });
});

describe('eventos do Hermes: só pela porta da tailnet, com o usuário do Tailscale e o token, sem login', () => {
  it('tailnet com o usuário do Tailscale e o token, sem login: 200 e o evento chega à fonte', async () => {
    const s = await start(['permissions']);
    const r = await request(s.tsBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { ...TS, ...HERMES_AUTH } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, n: 1 });
    expect(s.hermesApplied).toHaveLength(1);
  });

  it('tailnet sem o cabeçalho do Tailscale ou pelo Funnel: 403 antes do token; token errado: 401; nada chega à fonte', async () => {
    const s = await start(['permissions']);
    const post = (headers: Record<string, string>) => request(s.tsBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers });
    expect((await post({ Host: TS_HOST, ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS, 'Tailscale-User-Login': 'bob@example.com', ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS, 'Tailscale-Funnel-Request': '?1', ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS })).status).toBe(401);
    expect((await post({ ...TS, Authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401);
    expect((await post({ ...TS, ...HERMES_AUTH, Origin: 'https://evil.example' })).status).toBe(403);
    expect(s.hermesApplied).toEqual([]);
  });

  it('o token do Hermes não abre mais nada: as outras rotas da tailnet continuam pedindo login (401)', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    for (const [method, path] of [['GET', '/api/snapshot'], ['GET', '/api/pty'], ['POST', '/api/hermes/events/'], ['POST', '/api/hermes']] as const) {
      const r = await request(s.tsBase, path, { method, headers: { ...TS, ...HERMES_AUTH }, ...(method === 'POST' ? { body: HERMES_BODY } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(s.hermesApplied).toEqual([]);
  });

  it('portas 4747 (local) e 4748 (celular na rede, mesmo logado): a rota não existe (404)', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn', 'pty']);
    const local = await request(s.localBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { Host: '127.0.0.1', ...HERMES_AUTH } });
    expect(local.status).toBe(404);
    const { cookie } = await login(s.lanBase);
    const lan = await request(s.lanBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { Cookie: cookie, ...HERMES_AUTH } });
    expect(lan.status).toBe(404);
    expect(s.hermesApplied).toEqual([]);
  });
});
