// Barra de teclas do terminal interativo no celular (Fase 5, C2): Esc, Tab, Ctrl e setas, que o teclado do iPhone não
// tem. Fica embaixo da tela do terminal, logo acima do teclado; só aparece com tela de toque (CSS, pointer: coarse).
// Ctrl é de um toque: arma, e a próxima tecla digitada vai com Ctrl (Ctrl+C interrompe, Ctrl+D sai...).
import { tr } from '../../../shared/i18n';
import { h } from './dom';

export type PtyKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

const ARROWS: Record<'up' | 'down' | 'right' | 'left', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** O que a tecla manda ao terminal. Setas no modo "application cursor" (DECCKM, usado por TUIs) vão com ESC O. */
export function keySequence(key: PtyKey, appCursor: boolean): string {
  if (key === 'esc') return '\x1b';
  if (key === 'tab') return '\t';
  return `${appCursor ? '\x1bO' : '\x1b['}${ARROWS[key]}`;
}

const CTRL_SPECIAL: Record<string, string> = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f' };

/** Ctrl + o que foi digitado: letras viram o código de controle (Ctrl+C = \x03), e @ [ \ ] ^ _ e espaço também. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toLowerCase();
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  return CTRL_SPECIAL[c] ?? data;
}

/** Quanto do fundo da janela o teclado na tela cobre (visualViewport; sem ele, 0). */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number } | null | undefined): number {
  return vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
}

/** Eventos cujo preventDefault mantém o foco no terminal. Nunca `touchstart`: no iOS/WebKit ele cancela o `click`
 * sintetizado (as teclas ficariam mortas) e trava a rolagem horizontal da barra. */
export const KEEP_FOCUS_EVENTS = ['pointerdown', 'mousedown'];

/** Ctrl de um toque: arma, vale para a próxima tecla e desarma. */
export class CtrlLatch {
  private armed = false;

  toggle(): boolean {
    return (this.armed = !this.armed);
  }

  /** Consome: true se estava armado (e desarma). */
  take(): boolean {
    const was = this.armed;
    this.armed = false;
    return was;
  }

  reset(): boolean {
    return (this.armed = false);
  }
}

export class PtyKeys {
  readonly el: HTMLElement;
  private readonly latch = new CtrlLatch();
  private readonly ctrlBtn: HTMLButtonElement;

  constructor(
    private readonly send: (data: string) => void,
    private readonly appCursor: () => boolean,
    private readonly refocus: () => void,
  ) {
    const key = (label: string, aria: string, k: PtyKey) =>
      this.button(label, aria, () => {
        this.reset(); // Ctrl, ↑, c não vira Ctrl+C: tecla da barra desarma o Ctrl
        this.send(keySequence(k, this.appCursor()));
      });
    this.ctrlBtn = this.button('Ctrl', tr('Ctrl: a próxima tecla vai com Ctrl'), () => this.show(this.latch.toggle()));
    this.ctrlBtn.setAttribute('aria-pressed', 'false');
    this.el = h(
      'div',
      { class: 'ui-pty__keys', role: 'toolbar', attrs: { 'aria-label': tr('Teclas do terminal') } },
      key('Esc', 'Esc', 'esc'),
      key('Tab', 'Tab', 'tab'),
      this.ctrlBtn,
      key('←', tr('Seta para a esquerda'), 'left'),
      key('↑', tr('Seta para cima'), 'up'),
      key('↓', tr('Seta para baixo'), 'down'),
      key('→', tr('Seta para a direita'), 'right'),
    );
  }

  /** O que foi digitado, com o Ctrl armado aplicado (e desarmado). */
  apply(data: string): string {
    if (!this.latch.take()) return data;
    this.show(false);
    return withCtrl(data);
  }

  /** Desarma o Ctrl (troca de sessão, janela fechada): ele não vaza para outro terminal. */
  reset(): void {
    this.show(this.latch.reset());
  }

  private show(on: boolean): void {
    this.ctrlBtn.classList.toggle('is-on', on);
    this.ctrlBtn.setAttribute('aria-pressed', String(on));
  }

  private button(label: string, aria: string, act: () => void): HTMLButtonElement {
    const b = h('button', { class: 'ui-pty__key', type: 'button', text: label, attrs: { 'aria-label': aria } });
    // Sem tirar o foco do terminal: o teclado do iPhone não fecha a cada toque.
    for (const ev of KEEP_FOCUS_EVENTS) b.addEventListener(ev, (e) => e.preventDefault());
    b.addEventListener('click', () => {
      act();
      this.refocus();
    });
    return b;
  }
}
