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

export class PtyKeys {
  readonly el: HTMLElement;
  private ctrl = false;
  private readonly ctrlBtn: HTMLButtonElement;

  constructor(
    private readonly send: (data: string) => void,
    private readonly appCursor: () => boolean,
    private readonly refocus: () => void,
  ) {
    const key = (label: string, aria: string, k: PtyKey) => this.button(label, aria, () => this.send(keySequence(k, this.appCursor())));
    this.ctrlBtn = this.button('Ctrl', tr('Ctrl: a próxima tecla vai com Ctrl'), () => this.setCtrl(!this.ctrl));
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
    if (!this.ctrl) return data;
    this.setCtrl(false);
    return withCtrl(data);
  }

  private setCtrl(on: boolean): void {
    this.ctrl = on;
    this.ctrlBtn.classList.toggle('is-on', on);
    this.ctrlBtn.setAttribute('aria-pressed', String(on));
  }

  private button(label: string, aria: string, act: () => void): HTMLButtonElement {
    const b = h('button', { class: 'ui-pty__key', type: 'button', text: label, attrs: { 'aria-label': aria } });
    // Sem tirar o foco do terminal: o teclado do iPhone não fecha a cada toque.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      act();
      this.refocus();
    });
    return b;
  }
}
