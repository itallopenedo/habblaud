// POST /api/pty com agent "codex": as escolhas são conferidas contra o catálogo antes de abrir. Dados sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import type { PtyManager } from '../pty/manager';
import { createPtyRoutes } from './pty';

setQuiet(true);

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

async function serve(created: unknown[]): Promise<string> {
  const ptys = { create: (p: unknown) => (created.push(p), { id: 'p1' }) } as unknown as PtyManager;
  const routes = createPtyRoutes(ptys, { codexModels: async () => [{ id: 'gpt-x', name: 'X', efforts: ['low', 'high'] }] });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown) => fetch(`${base}/api/pty`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/pty: Codex', () => {
  it('passa as escolhas conferidas e o pedido; recusa modelo, esforço ou agente fora da lista', async () => {
    const created: unknown[] = [];
    const base = await serve(created);
    expect((await post(base, { agent: 'codex', cwd: '/p', model: 'gpt-x', effort: 'high', permission: 'read-only', prompt: 'oi  ' })).status).toBe(201);
    expect(created[0]).toMatchObject({ cwd: '/p', codex: { choice: { model: 'gpt-x', effort: 'high', permission: 'read-only' }, prompt: 'oi' } });
    expect((await post(base, { agent: 'codex', cwd: '/p' })).status).toBe(201);
    expect(created[1]).toMatchObject({ codex: { choice: {} } });
    expect(created[1]).not.toHaveProperty('codex.prompt');
    for (const bad of [{ model: 'gpt-y' }, { model: 'gpt-x', effort: 'max' }, { permission: 'danger-full-access' }, { prompt: 3 }]) {
      expect((await post(base, { agent: 'codex', cwd: '/p', ...bad })).status).toBe(400);
    }
    expect((await post(base, { agent: 'gemini', cwd: '/p' })).status).toBe(400);
    expect((await post(base, { cwd: '/p' })).status).toBe(201);
    expect(created[2]).not.toHaveProperty('codex');
    expect(created).toHaveLength(3);
  });
});
