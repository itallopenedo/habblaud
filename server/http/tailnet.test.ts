import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { createTailnetGate, DEFAULT_TAILNET_PORT, isTailnetRequest, parseTailnetConfig, ptyNeedsConfirm, startTailnetListener } from './tailnet';

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
