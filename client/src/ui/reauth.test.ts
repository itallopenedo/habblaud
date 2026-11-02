import { describe, expect, it } from 'vitest';
import { confirmedRecently, confirmPassword, isReauth, ReauthError, withReauth } from './reauth';

const reply = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('senha de novo (terminal pelo celular)', () => {
  it('isReauth: só o 401 com code reauth', () => {
    expect(isReauth(401, { code: 'reauth' })).toBe(true);
    expect(isReauth(401, { error: 'faça login' })).toBe(false);
    expect(isReauth(403, { code: 'reauth' })).toBe(false);
    expect(isReauth(401, null)).toBe(false);
  });

  it('withReauth: pede a senha e tenta mais uma vez; cancelou = undefined; outro erro passa', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new ReauthError('confirme');
      return 'ok';
    };
    expect(await withReauth(fn, async () => true)).toBe('ok');
    expect(calls).toBe(2);
    calls = 0;
    expect(await withReauth(fn, async () => false)).toBeUndefined();
    expect(calls).toBe(1);
    await expect(withReauth(async () => Promise.reject(new Error('rede')), async () => true)).rejects.toThrow('rede');
  });

  it('confirmPassword: aceita, senha errada (mensagem do servidor), sem rede', async () => {
    expect(await confirmPassword('x', reply(200, { ok: true }))).toBe('');
    expect(await confirmPassword('x', reply(401, { error: 'Senha incorreta.' }))).toBe('Senha incorreta.');
    expect(await confirmPassword('x', (() => Promise.reject(new Error('rede'))) as unknown as typeof fetch)).toBe('o Habblaud não respondeu');
  });

  it('confirmedRecently: só com fresh true', async () => {
    expect(await confirmedRecently(reply(200, { fresh: true }))).toBe(true);
    expect(await confirmedRecently(reply(200, { fresh: false }))).toBe(false);
    expect(await confirmedRecently(reply(401, {}))).toBe(false);
  });
});
