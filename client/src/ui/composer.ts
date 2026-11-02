// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. O clipe anexa fotos e arquivos (no iPhone:
// câmera, fotos ou arquivos): sobem um a um em POST /api/attachments e a mensagem leva os ids. A lógica pura está em
// ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider } from '../../../shared/types';
import {
  attachmentsLocked,
  canSend,
  composerMode,
  composerTip,
  enterSends,
  isSettled,
  LOST_ERROR,
  messageText,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pickAttachments,
  pollDelay,
  transferFiles,
  sendStatusText,
  staleAttachmentIds,
  timeoutError,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { fileToBase64 } from './spawn';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

interface PendingFile {
  file: File;
  url?: string;
  el: HTMLElement;
  remove: HTMLButtonElement;
  /** Id do anexo já enviado ao servidor: a nova tentativa não o envia de novo. */
  id?: string;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Agente da caixa (ou a chave da conversa, no terminal do histórico). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Rascunho por agente: é ele que manda no conteúdo da caixa. */
  private drafts = new Map<string, string>();
  /** Último envio de cada agente (a linha de situação). */
  private states = new Map<string, SendState>();
  /** Ferramenta de cada agente que recebeu mensagem (o texto da entrega e do prazo muda no Codex). */
  private providers = new Map<string, Provider>();
  /** Ferramenta do agente da caixa. */
  private provider: Provider = 'claude';
  /** O que a caixa mostra agora ("<agente>|<pronta>"): ao mudar, o conteúdo vem do rascunho. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  private attachBtn: HTMLButtonElement;
  private fileList: HTMLElement;
  /** Recusa do último arquivo escolhido (não mexe na situação do envio: o envio em andamento segue o seu curso). */
  private fileNote: HTMLElement;
  /** Anexos por agente (como os rascunhos): sobrevivem a trocar de agente e a ele ficar fora do ar por um instante. */
  private filesBy = new Map<string, PendingFile[]>();
  /** Anexos do agente da caixa. */
  private get files(): PendingFile[] {
    let list = this.filesBy.get(this.agentId);
    if (!list) this.filesBy.set(this.agentId, (list = []));
    return list;
  }
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Linha do ditado (gravando, transcrevendo, idioma, erro). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rascunho que recebe o ditado em andamento (o agente pode mudar enquanto o Mac transcreve). */
  private dictKey = '';
  private canDictate = false;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
    });
    this.box.addEventListener('focus', () => this.resize());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    // Colar (⌘V no Mac, "Colar" no iPhone) qualquer arquivo vira anexo, como o clipe. O texto que vier junto cola
    // normalmente; só um colar sem texto deixa de ir para a caixa.
    this.box.addEventListener('paste', (e) => {
      const files = transferFiles(e.clipboardData);
      if (!files.length || this.attachBtn.hidden) return;
      if (!e.clipboardData?.types.includes('text/plain')) e.preventDefault();
      this.addFiles(files);
    });
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Mandar (Enter)'),
        attrs: { 'aria-label': tr('Mandar a mensagem') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Enviar'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    this.attachBtn = iconButton(ICONS.attach, tr('Anexar foto ou arquivo'), () => this.fileInput.click(), 'ui-msg__attach');
    this.fileList = h('ul', { class: 'ui-spawn__files ui-msg__files', attrs: { 'aria-label': tr('Anexos') } });
    this.fileNote = h('p', { class: 'ui-msg__status is-error', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.attachBtn, this.dictate.el, this.sendBtn);
    // Clique na "linha do prompt" (fora do botão) põe o cursor na caixa, como num terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.row, this.fileList, this.fileNote, this.fileInput, this.dictStatus, this.status, this.tip);
    // Arrastar arquivos do Finder para a caixa também anexa.
    this.el.addEventListener('dragover', (e) => {
      if (!this.attachBtn.hidden && e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.el.addEventListener('drop', (e) => {
      const files = transferFiles(e.dataTransfer);
      if (!files.length || this.attachBtn.hidden) return;
      e.preventDefault();
      this.addFiles(files);
    });
  }

  /**
   * Atualiza a caixa para `agent` (undefined = nenhum: sessão do histórico ou agente que saiu); `key` identifica o
   * rascunho. Devolve o modo: a gaveta esconde a seção quando é 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Troca de agente (ou a caixa passou a valer/deixou de valer): o conteúdo vem do rascunho guardado.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Gravando para outro agente: para sem transcrever (a fala era para aquele).
      this.dictate.cancel();
      this.shown = shown;
      // Os anexos seguem o agente, não o "pronto": só trocar de agente muda a lista (e quem saiu de vez perde os seus).
      if (key !== this.agentId) this.showFiles(key);
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
    }
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('o agente');
    const placeholder = ready ? (term ? tr('Mensagem para {0} (Enter manda, Shift+Enter quebra a linha)', [name]) : tr('Mensagem para {0}…', [name])) : mode.text;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Mensagem para {0}', [name]) : mode.text);
    setTitle(this.box, ready ? '' : mode.text);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    setHidden(this.attachBtn, !ready || store.mock);
    // Consulta em cache (30 s): o Mac pode instalar o Whisper ou parar o auxiliar com a página aberta.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcrevendo: o botão fica até o texto chegar (ele vai para o rascunho de quem ditou).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // Na gaveta, a dica do plugin entra no lugar da caixa; no terminal ela já está no lugar do texto.
    setHidden(this.row, !term && !ready);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internos

  answerDesktopQuestion(agentId: string, questionId: string, option: number): void {
    if (agentId === this.agentId) void this.send({ questionId, option });
  }

  private onKey(e: KeyboardEvent): void {
    // Os atalhos globais (F, T, P, /, setas...) não valem dentro da caixa. Com Ctrl/⌘ a tecla segue adiante
    // (Ctrl/⌘+F busca na conversa do terminal; os atalhos globais ignoram essas combinações).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (e.key === 'Escape') {
      // Esc só sai da caixa (o próximo fecha o terminal ou a gaveta).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /** Texto ditado: no cursor, se a caixa ainda é a de quem ditou; senão, no fim do rascunho daquele agente. */
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Avisos de sucesso somem sozinhos; "Gravando…" e "Transcrevendo…" ficam até a próxima mudança.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    const sending = this.states.get(this.agentId)?.phase === 'sending';
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !canSend(this.box.value, this.files.length) || sending;
    // Enviando, os anexos ficam como estão (o envio já os levou).
    this.attachBtn.disabled = attachmentsLocked(this.states.get(this.agentId)?.phase);
    for (const f of this.files) f.remove.disabled = this.attachBtn.disabled;
  }

  private addFiles(list: File[]): void {
    if (attachmentsLocked(this.states.get(this.agentId)?.phase)) return;
    const { accepted, problem } = pickAttachments(list, this.files.length);
    this.sayFile(problem);
    for (const i of accepted) {
      const file = list[i]!;
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const el = h('li', { class: 'ui-spawn__file' });
      const thumb = url
        ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } })
        : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('ARQ') });
      const remove = iconButton(ICONS.close, tr('Tirar {0}', [file.name]), () => {
        if (!attachmentsLocked(this.states.get(this.agentId)?.phase)) this.removeFile(item);
      }, 'ui-icon-btn--sm ui-spawn__file-x');
      const item: PendingFile = { file, url, el, remove };
      el.append(thumb, h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }), remove);
      this.files.push(item);
      this.fileList.append(el);
    }
    this.syncButton();
  }

  private sayFile(text = ''): void {
    setText(this.fileNote, text);
    setHidden(this.fileNote, !text);
  }

  /** Tira um anexo de `key` (o agente da caixa, ou o que enviou: a caixa pode ter mudado de agente no meio do envio). */
  private removeFile(item: PendingFile, key = this.agentId): void {
    if (item.url) URL.revokeObjectURL(item.url);
    item.el.remove();
    this.filesBy.set(key, (this.filesBy.get(key) ?? []).filter((f) => f !== item));
    this.sayFile();
    this.syncButton();
  }

  /** A caixa passa a `key`: mostra os anexos dele e descarta os de agentes que já não estão no escritório. */
  private showFiles(key: string): void {
    const live = new Set((this.ctx.store.snapshot?.agents ?? []).map((a) => a.id));
    for (const [k, list] of [...this.filesBy]) {
      if (k === key || live.has(k)) continue;
      for (const f of list) if (f.url) URL.revokeObjectURL(f.url);
      this.filesBy.delete(k);
    }
    this.fileList.replaceChildren(...(this.filesBy.get(key) ?? []).map((f) => f.el));
    this.sayFile();
  }

  /** Cresce com o texto até o limite do CSS (~6 linhas; depois rola). Escondida, mede quando aparecer. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  private async send(choice?: { questionId: string; option: number }): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || (!choice && !canSend(raw, this.files.length)) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    const files = choice ? [] : [...this.files];
    let r: { message: OutboxMessage } | { error: string; status?: number } | undefined;
    try {
      for (const f of files) {
        if (f.id) continue; // já subiu numa tentativa anterior
        const up = await this.ctx.store.uploadAttachment(f.file.name, f.file.type, await fileToBase64(f.file));
        if ('error' in up) {
          r = up;
          break;
        }
        f.id = up.id;
      }
      r ??= await this.ctx.store.sendMessage(agentId, choice ? '' : messageText(raw), choice, files.map((f) => f.id!));
      // O servidor não aceitou os anexos (venceram ou ele não os conhece): a próxima tentativa envia tudo de novo.
      if ('error' in r && staleAttachmentIds(r.status)) for (const f of files) f.id = undefined;
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: a caixa esvazia (a não ser que você tenha continuado a escrever enquanto o envio ia).
    if (!choice && (this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    for (const f of files) this.removeFile(f, agentId);
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Consulta a situação até ela se resolver (ou o prazo acabar). Para quando outro envio toma a linha de situação. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // Sem conexão agora: tenta de novo na próxima volta.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
