import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import {
  attachmentProblem,
  attachmentsLocked,
  canSend,
  CODEX_BRIDGE_HINT,
  CODEX_TIMEOUT_ERROR,
  composerMode,
  composerTip,
  DELIVERED_SHOW_MS,
  enterSends,
  isSettled,
  MESSAGE_FILE_BYTES,
  MESSAGE_FILES_MAX,
  messageText,
  PLUGIN_HINT,
  pickAttachments,
  transferFiles,
  pollDelay,
  sendStatusText,
  staleAttachmentIds,
  timeoutError,
  TIMEOUT_ERROR,
  type ComposerEnv,
} from './composer-model';

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'acc:1',
    kind: 'main',
    roomId: 'r',
    name: 'Marina',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's-1',
    account: 'acc',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    canMessage: true,
    ...over,
  };
}

const ON: ComposerEnv = { enabled: true, local: true, replaying: false };

describe('caixa de mensagem (peças puras)', () => {
  it('composerMode: pronta só para principal presente com o plugin, recurso ligado e página local', () => {
    expect(composerMode(agent(), ON)).toEqual({ kind: 'ready' });
    for (const status of ['working', 'waiting', 'shell'] as const) expect(composerMode(agent({ status }), ON).kind).toBe('ready');
    // Recurso ligado, mas a sessão sem o plugin: a dica de instalação.
    expect(composerMode(agent({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: PLUGIN_HINT });
    expect(PLUGIN_HINT).toBe('Para mandar mensagens daqui: npm run mod:install (plugin habblaud-mensagens)');
  });

  it('composerMode: quando não dá, diz por quê (a gaveta esconde, o terminal mostra o motivo)', () => {
    const off = (a: AgentInfo | undefined, env: Partial<ComposerEnv> = {}) => {
      const m = composerMode(a, { ...ON, ...env });
      expect(m.kind).toBe('off');
      return m.kind === 'off' ? m.text : '';
    };
    expect(off(agent({ kind: 'sub', parentId: 'acc:1' }))).toMatch(/^Subagentes não recebem/);
    expect(off(agent({ kind: 'sub', status: 'done' }))).toMatch(/^Subagentes/);
    expect(off(agent({ status: 'offline' }))).toBe('Sessão encerrada');
    expect(off(undefined)).toBe('Sessão encerrada');
    expect(off(agent(), { enabled: false })).toMatch(/terminal do Claude Code/);
    expect(off(agent({ canMessage: undefined }), { enabled: false })).toMatch(/terminal do Claude Code/);
    expect(off(agent(), { local: false })).toMatch(/localhost/);
    expect(off(agent(), { replaying: true })).toMatch(/timelapse/);
    expect(off(agent({ provider: 'hermes', canMessage: true }))).toBe('O Hermes só é acompanhado aqui: responda no canal dele');
  });

  it('texto: sai sem os espaços do fim; vazio ou longo demais não manda', () => {
    expect(messageText('  oi\n  tudo bem?  \n\n')).toBe('  oi\n  tudo bem?');
    expect(canSend('oi')).toBe(true);
    expect(canSend(' \n\t ')).toBe(false);
    expect(canSend('x'.repeat(20_000))).toBe(true);
    expect(canSend('x'.repeat(20_001))).toBe(false);
    // Espaços no fim não contam para o limite (são cortados antes).
    expect(canSend(`${'x'.repeat(20_000)}\n\n`)).toBe(true);
  });

  it('Enter manda; Shift+Enter e Alt+Enter quebram a linha; Enter compondo acento (IME) não manda', () => {
    const k = (over: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>> = {}) =>
      enterSends({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, ...over });
    expect(k()).toBe(true);
    expect(k({ shiftKey: true })).toBe(false);
    expect(k({ altKey: true })).toBe(false);
    expect(k({ isComposing: true })).toBe(false);
    expect(k({ key: 'a' })).toBe(false);
  });

  it('linha de situação: enviando, na fila, entregando, entregue (some depois de um tempo) e os erros', () => {
    expect(sendStatusText(undefined, 0)).toBe('');
    expect(sendStatusText({ phase: 'sending', at: 0 }, 0)).toBe('Enviando…');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0)).toMatch(/^Na fila/);
    expect(sendStatusText({ phase: 'sent', at: 0 }, 0)).toMatch(/^Entregando/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000)).toMatch(/^Entregue ✓ \(se o agente estiver ocupado, entra quando ele terminar\)$/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS)).toBe('');
    expect(sendStatusText({ phase: 'rejected', error: 'já há 5 mensagens', at: 0 }, 0)).toBe('Não foi possível mandar: já há 5 mensagens');
    expect(sendStatusText({ phase: 'failed', error: 'a sessão não confirmou a entrega', at: 0 }, 99_999)).toBe('Não foi entregue: a sessão não confirmou a entrega');
    expect(['delivered', 'failed', 'rejected'].every((p) => isSettled(p as never))).toBe(true);
    expect(['sending', 'queued', 'sent'].some((p) => isSettled(p as never))).toBe(false);
  });

  it('Codex: com entregador, igual ao Claude Code; sem ele, a dica do codex:bridge; recurso desligado manda ao Codex', () => {
    const codex = (over: Partial<AgentInfo> = {}) => agent({ provider: 'codex', ...over });
    expect(composerMode(codex(), ON)).toEqual({ kind: 'ready' });
    expect(composerMode(codex({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: CODEX_BRIDGE_HINT });
    expect(CODEX_BRIDGE_HINT).toBe('Para mandar mensagens ao Codex: com o Habblaud no Docker, deixe npm run codex:bridge rodando; no modo Node funciona sozinho');
    expect(composerMode(codex(), { ...ON, enabled: false })).toEqual({ kind: 'off', text: 'Para responder, use o Codex' });
    expect(composerMode(codex({ kind: 'sub', parentId: 'acc:1' }), ON).kind).toBe('off');
    expect(composerMode(codex({ status: 'offline' }), ON)).toEqual({ kind: 'off', text: 'Sessão encerrada' });
  });

  it('Codex: "Entregue" é a fila da sessão; dica e prazo falam do Codex', () => {
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'codex')).toBe('Entregue ✓ na fila da sessão: entra quando o Codex terminar o que está fazendo (até ~10 s)');
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS, 'codex')).toBe('');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0, 'codex')).toBe('Na fila: entregando ao Codex…');
    // O Claude Code continua como antes.
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'claude')).toBe(sendStatusText({ phase: 'delivered', at: 0 }, 1_000));
    expect(composerTip('codex')).toMatch(/^Entra na fila da sessão e vira o próximo prompt quando o Codex terminar/);
    expect(composerTip()).toBe('Entra na sessão como se você tivesse digitado. Enter manda; Shift+Enter quebra a linha.');
    expect(timeoutError('codex')).toBe(CODEX_TIMEOUT_ERROR);
    expect(timeoutError()).toBe(TIMEOUT_ERROR);
  });

  it('consulta da entrega: rápida no começo, mais espaçada depois', () => {
    expect(pollDelay(0)).toBeLessThan(1_000);
    expect(pollDelay(20_000)).toBeGreaterThan(pollDelay(0));
    expect(pollDelay(60_000)).toBeGreaterThanOrEqual(pollDelay(20_000));
  });

  it('anexos: com arquivo a mensagem pode ir sem texto; limite de quantidade, vazio e tamanho', () => {
    expect(canSend('', 0)).toBe(false);
    expect(canSend('  ', 1)).toBe(true);
    expect(canSend('x'.repeat(20_001), 1)).toBe(false);
    expect(attachmentProblem({ name: 'a.jpg', size: 10 }, 0)).toBeUndefined();
    expect(attachmentProblem({ name: 'a.jpg', size: 10 }, MESSAGE_FILES_MAX)).toMatch(/No máximo 8/);
    expect(attachmentProblem({ name: 'a.jpg', size: 0 }, 0)).toMatch(/vazio/);
    expect(attachmentProblem({ name: 'a.jpg', size: MESSAGE_FILE_BYTES + 1 }, 0)).toMatch(/passa de 15 MB/);
  });

  it('anexos: travados enquanto o envio está em andamento', () => {
    expect(attachmentsLocked(undefined)).toBe(false);
    expect(attachmentsLocked('sending')).toBe(true);
    for (const p of ['queued', 'sent', 'delivered', 'failed', 'rejected'] as const) expect(attachmentsLocked(p)).toBe(false);
  });

  it('anexos: o que entra de uma seleção e o primeiro motivo de recusa', () => {
    const f = (name: string, size = 10) => ({ name, size });
    expect(pickAttachments([f('a'), f('b')], 0)).toEqual({ accepted: [0, 1], problem: undefined });
    // Vários ruins: mostra o primeiro, os bons entram.
    const r = pickAttachments([f('vazio', 0), f('ok'), f('outro', 0)], 0);
    expect(r.accepted).toEqual([1]);
    expect(r.problem).toMatch(/vazio/);
    expect(r.problem).not.toMatch(/outro/);
    // Passou do limite: o resto da seleção não entra, com o aviso de quantidade.
    const many = pickAttachments([f('a'), f('b'), f('c')], MESSAGE_FILES_MAX - 1);
    expect(many.accepted).toEqual([0]);
    expect(many.problem).toMatch(/No máximo 8/);
  });

  it('anexos: ids já enviados só se perdem quando o servidor diz que o anexo não vale (400)', () => {
    expect(staleAttachmentIds(400)).toBe(true);
    for (const s of [undefined, 403, 404, 409, 429, 500]) expect(staleAttachmentIds(s)).toBe(false);
  });

  it('colar ou arrastar: qualquer tipo de arquivo; usa `files` e, sem ele, os itens do tipo arquivo; texto puro não vira anexo', () => {
    const foto = new File(['x'], 'image.png', { type: 'image/png' });
    const video = new File(['y'], 'video.mov', { type: 'video/quicktime' });
    const pdf = new File(['z'], 'nota.pdf', { type: 'application/pdf' });
    expect(transferFiles({ files: [foto, video], items: [] })).toEqual([foto, video]);
    const item = (f: File | null, kind = 'file') => ({ kind, getAsFile: () => f });
    expect(transferFiles({ files: [], items: [item(pdf), item(null, 'string'), item(null)] })).toEqual([pdf]);
    expect(transferFiles({ files: [], items: [item(null, 'string')] })).toEqual([]);
    expect(transferFiles(null)).toEqual([]);
  });
});
