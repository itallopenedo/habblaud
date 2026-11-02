// Rota dos eventos do Hermes (server/hermes/http.ts) e o token (server/hermes/token.ts): formato estrito (nenhuma chave
// a mais passa, então nenhum texto entra por engano), token só pela hash, 64 KB, freio e só POST. A recusa nas portas
// 4747 e 4748 e a ordem dentro da porta da tailnet estão em server/http/tailnet.test.ts. Dados sintéticos.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../http/app';
import { setQuiet } from '../log';
import type { HermesEvent } from '../sources/hermes/source';
import { createHermesIngest, FixedWindowLimiter, HERMES_BATCH_MAX, parseHermesBatch } from './http';
import { bearerMatches, parseHermesTokenHash } from './token';

setQuiet(true);

const TOKEN = 'tok_'.padEnd(43, 'x');
const HASH = createHash('sha256').update(TOKEN).digest();
const EV = { profile: 'Íon', platform: 'telegram', session: '0123456789abcdef', event: 'pre_tool_call', tool: 'terminal', at: 1_800_000_000_000 };

const status400 = (raw: unknown) => {
  try {
    parseHermesBatch(raw);
    return 'passou';
  } catch (err) {
    return err instanceof HttpError ? err.status : 'outro erro';
  }
};

describe('token do Hermes', () => {
  it('hash: só sha256:<64 hex>', () => {
    expect(parseHermesTokenHash(`sha256:${HASH.toString('hex')}`)).toEqual(HASH);
    expect(parseHermesTokenHash(` SHA256:${HASH.toString('hex').toUpperCase()} `)).toEqual(HASH);
    for (const raw of [undefined, '', HASH.toString('hex'), 'sha256:abc', `scrypt:${HASH.toString('hex')}`]) expect(parseHermesTokenHash(raw), String(raw)).toBeUndefined();
  });
  it('hash com tamanho errado: false, sem lançar', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, HASH.subarray(0, 31))).toBe(false);
  });
  it('Bearer: o token certo passa; errado, ausente, curto ou sem "Bearer" não', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, HASH)).toBe(true);
    for (const h of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, 'Bearer curto', `Bearer ${TOKEN} `]) expect(bearerMatches(h, HASH), String(h)).toBe(false);
  });
});

describe('parseHermesBatch', () => {
  it('aceita o formato do plugin e devolve duration_ms como durationMs', () => {
    expect(parseHermesBatch({ v: 1, events: [EV, { ...EV, event: 'post_tool_call', ok: false, duration_ms: 1500, model: 'gpt-6-luna' }] })).toEqual([
      EV,
      { ...EV, event: 'post_tool_call', ok: false, durationMs: 1500, model: 'gpt-6-luna' },
    ]);
  });
  it('recusa (400) envelope errado, lote vazio ou grande demais', () => {
    for (const raw of [null, [], {}, { v: 2, events: [EV] }, { v: 1, events: [] }, { v: 1, events: Array(HERMES_BATCH_MAX + 1).fill(EV) }, { v: 1, events: [EV], extra: 1 }]) {
      expect(status400(raw), JSON.stringify(raw)?.slice(0, 60)).toBe(400);
    }
  });
  it('recusa (400) qualquer chave a mais: texto de mensagem, argumentos, resultado, comando, remetente', () => {
    for (const k of ['user_message', 'assistant_response', 'args', 'result', 'command', 'sender_id', 'session_id', 'description']) {
      expect(status400({ v: 1, events: [{ ...EV, [k]: 'CANARIO' }] }), k).toBe(400);
    }
  });
  it('chave a mais: __proto__ é 400 e o nome ecoado é cortado em 40 caracteres', () => {
    expect(status400(JSON.parse(`{"v":1,"events":[{"__proto__":{"x":1},"profile":"a","session":"0123456789abcdef","event":"pre_tool_call","at":1800000000000}]}`))).toBe(400);
    try {
      parseHermesBatch({ v: 1, events: [{ ...EV, ['k'.repeat(500)]: 1 }] });
    } catch (err) {
      expect((err as HttpError).message.length).toBeLessThan(150);
    }
  });
  it('recusa (400) campo fora do formato', () => {
    const bad: Array<Record<string, unknown>> = [
      { session: '0123456789ABCDEF' },
      { session: 'sessao-crua-do-telegram' },
      { event: 'on_message' },
      { profile: '' },
      { profile: 'a'.repeat(41) },
      { profile: 'íon\n' },
      { platform: 'Telegram Group 123' },
      { tool: 'rm -rf /' },
      { tool: 'x'.repeat(65) },
      { ok: 'false' },
      { duration_ms: -1 },
      { duration_ms: 1.5 },
      { at: '2026-11-01' },
      { at: 0 },
      { model: 'gpt 6' },
    ];
    for (const b of bad) expect(status400({ v: 1, events: [{ ...EV, ...b }] }), JSON.stringify(b)).toBe(400);
  });
});

describe('FixedWindowLimiter', () => {
  it('max por janela; a janela seguinte zera', () => {
    let t = 0;
    const l = new FixedWindowLimiter(2, 1000, () => t);
    expect([l.take(), l.take(), l.take()]).toEqual([true, true, false]);
    t = 1000;
    expect(l.take()).toBe(true);
  });
  it('relógio que volta: a janela reinicia em vez de congelar', () => {
    let t = 10_000;
    const l = new FixedWindowLimiter(1, 1000, () => t);
    expect([l.take(), l.take()]).toEqual([true, false]);
    t = 5_000;
    expect(l.take()).toBe(true);
  });
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(limiter?: FixedWindowLimiter) {
  const applied: HermesEvent[][] = [];
  const ingest = createHermesIngest({ tokenHash: HASH, apply: (evs) => void applied.push([...evs]), limiter });
  const server = http.createServer((req, res) => {
    if (!ingest(req, res, new URL(req.url ?? '/', 'http://x'))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () => new Promise((ok) => server.close(() => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}, path = '/api/hermes/events', method = 'POST') =>
    fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { applied, post };
}

describe('createHermesIngest', () => {
  it('token certo e corpo válido: 200 {ok, n} e os eventos vão para a fonte', async () => {
    const s = await serve();
    const r = await s.post({ v: 1, events: [EV] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, n: 1 });
    expect(s.applied).toEqual([[EV]]);
  });
  it('token errado ou ausente: 401; corpo inválido: 400; JSON quebrado: 400; sem JSON: 415; acima de 64 KB: 413; GET: 405; nada aplicado', async () => {
    const s = await serve();
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: 'Bearer '.padEnd(50, 'y') })).status).toBe(401);
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: '' })).status).toBe(401);
    expect((await s.post({ v: 1, events: [{ ...EV, user_message: 'CANARIO' }] })).status).toBe(400);
    expect((await s.post('{"v":1,')).status).toBe(400);
    expect((await s.post({ v: 1, events: [EV] }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await s.post({ v: 1, events: [{ ...EV, model: 'x' }], pad: 'x'.repeat(70 * 1024) })).status).toBe(413);
    const get = await s.post(undefined, {}, '/api/hermes/events', 'GET');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(s.applied).toEqual([]);
  });
  it('token errado vence 415 e 413: 401, sem ler o corpo; recusa fecha a conexão', async () => {
    const s = await serve();
    const wrong = { Authorization: 'Bearer '.padEnd(50, 'y') };
    expect((await s.post({ v: 1, events: [EV] }, { ...wrong, 'Content-Type': 'text/plain' })).status).toBe(401);
    const big = await s.post({ v: 1, events: [EV], pad: 'x'.repeat(70 * 1024) }, wrong);
    expect(big.status).toBe(401);
    expect(big.headers.get('connection')).toBe('close');
    expect(s.applied).toEqual([]);
  });
  it('outro caminho (mesmo variante): não é da rota (segue para o login)', async () => {
    const s = await serve();
    expect((await s.post({ v: 1, events: [EV] }, {}, '/api/hermes/events/')).status).toBe(418);
    expect((await s.post({ v: 1, events: [EV] }, {}, '/api/hermes')).status).toBe(418);
    expect(s.applied).toEqual([]);
  });
  it('freio: acima do limite, 429 com Retry-After, antes até de conferir o token', async () => {
    const s = await serve(new FixedWindowLimiter(2, 60_000));
    expect((await s.post({ v: 1, events: [EV] })).status).toBe(200);
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: '' })).status).toBe(401);
    const r = await s.post({ v: 1, events: [EV] });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
    expect(s.applied).toHaveLength(1);
  });
});
