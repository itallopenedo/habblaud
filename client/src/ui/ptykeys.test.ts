import { describe, expect, it } from 'vitest';
import { keyboardInset, keySequence, withCtrl } from './ptykeys';

describe('teclas do terminal no celular', () => {
  it('Esc, Tab e setas (normal e "application cursor")', () => {
    expect(keySequence('esc', false)).toBe('\x1b');
    expect(keySequence('tab', true)).toBe('\t');
    expect(keySequence('up', false)).toBe('\x1b[A');
    expect(keySequence('down', false)).toBe('\x1b[B');
    expect(keySequence('right', false)).toBe('\x1b[C');
    expect(keySequence('left', false)).toBe('\x1b[D');
    expect(keySequence('up', true)).toBe('\x1bOA');
    expect(keySequence('left', true)).toBe('\x1bOD');
  });

  it('Ctrl: letras (qualquer caixa) e os especiais; o resto passa igual', () => {
    expect(withCtrl('c')).toBe('\x03');
    expect(withCtrl('C')).toBe('\x03');
    expect(withCtrl('d')).toBe('\x04');
    expect(withCtrl('a')).toBe('\x01');
    expect(withCtrl('z')).toBe('\x1a');
    expect(withCtrl('[')).toBe('\x1b');
    expect(withCtrl(' ')).toBe('\x00');
    expect(withCtrl('1')).toBe('1');
    expect(withCtrl('ab')).toBe('ab');
  });

  it('teclado na tela: quanto do fundo ele cobre', () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardInset(800, { height: 500, offsetTop: 20 })).toBe(280);
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, null)).toBe(0);
  });
});
