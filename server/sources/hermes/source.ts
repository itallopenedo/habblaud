// Fonte do Hermes (Fase 6): as sessões do Hermes Agent da VPS, vistas pelos eventos que o plugin habblaud-observer
// manda para POST /api/hermes/events (server/hermes/http.ts). Só observa. Nada de texto de mensagem, argumento,
// resultado, comando ou id de quem falou chega aqui: só o perfil, a plataforma, um hash da sessão, o evento, o nome da
// ferramenta, se deu certo, a duração, o horário e o modelo. Um agente por sessão, numa sala por perfil
// ("hermes:/<perfil>", fora das pastas sugeridas no Novo agente por não ser caminho absoluto); sem transcript (o
// terminal fica vazio) e sem tokens (stats zerados). Agentes do Hermes nunca vão ao Habblaud World
// (shared/world/projection.ts só aceita claude e codex).
import { SPECIAL, type ActivityDescription } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { Activity, Provider, SourceInfo } from '../../../shared/types';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

/** Os ganchos do Hermes que o plugin manda, com os nomes do próprio Hermes. */
export const HERMES_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
] as const;
export type HermesEventName = (typeof HERMES_EVENTS)[number];

/** Um evento já validado (server/hermes/http.ts, parseHermesBatch). */
export interface HermesEvent {
  profile: string;
  platform?: string;
  /** 16 hex: sha256 do perfil + id da sessão, cortada (o id cru nunca sai da VPS). */
  session: string;
  event: HermesEventName;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  /** Epoch ms no relógio da VPS. */
  at: number;
  model?: string;
}

/** Conta (AgentInfo.account) de todos os agentes do Hermes: não há conta local, o chip mostra "H". */
export const HERMES_ACCOUNT = 'hermes';
/** Trabalhando sem notícia por este tempo (o post_llm_call se perdeu): volta a "à toa". */
export const HERMES_QUIET_MS = 5 * 60_000;
/** Sem nenhum evento por este tempo (gateway parado, VPS fora): a sessão sai do escritório. */
export const HERMES_STALE_MS = 6 * 60 * 60_000;
/** Teto de sessões vivas: com o token, ninguém enche o escritório de agentes. A sessão nova além dele é descartada. */
export const HERMES_MAX_SESSIONS = 50;
/** Plataformas de sessão de uma conversa só (não há "à toa" para voltar): o fim da conversa tira o agente. */
const ONE_SHOT_PLATFORMS: ReadonlySet<string> = new Set(['cron', 'subagent']);

export function hermesAgentId(session: string): string {
  return `hermes:${session}`;
}

/** Atividade de uma ferramenta do Hermes só pelo nome (os argumentos nunca chegam). */
export function describeHermesTool(name: string): ActivityDescription {
  const n = name.toLowerCase();
  if (n === 'terminal' || n === 'process' || n === 'execute_code') return { kind: 'run', icon: '🖥️', text: tr('Rodando um comando') };
  if (n === 'read_file') return { kind: 'read', icon: '📖', text: tr('Lendo arquivo') };
  if (n === 'write_file') return { kind: 'write', icon: '📝', text: tr('Escrevendo arquivo') };
  if (n === 'patch') return { kind: 'edit', icon: '✏️', text: tr('Editando arquivo') };
  if (n === 'search_files') return { kind: 'search', icon: '🔎', text: tr('Buscando nos arquivos') };
  if (n === 'web_search') return { kind: 'web', icon: '🌐', text: tr('Pesquisando na web') };
  if (n === 'web_extract') return { kind: 'web', icon: '🌐', text: tr('Lendo uma página') };
  if (n.startsWith('browser_')) return { kind: 'browser', icon: '🧭', text: tr('Navegando no navegador') };
  if (n === 'delegate_task') return { kind: 'delegate', icon: '👥', text: tr('Delegando a um subagente') };
  if (n === 'todo') return { kind: 'plan', icon: '📋', text: tr('Atualizando as tarefas') };
  if (n.startsWith('skill')) return { kind: 'skill', icon: '🧩', text: tr('Usando uma skill') };
  if (n === 'send_message') return { kind: 'communicate', icon: '✉️', text: tr('Mandando uma mensagem') };
  if (n === 'clarify') return { kind: 'ask', icon: '❓', text: tr('Perguntando ao usuário') };
  if (n.startsWith('mcp_')) return { kind: 'mcp', icon: '🔌', text: tr('Usando {0}', [name]) };
  return { kind: 'other', icon: '🔧', text: tr('Usando {0}', [name]) };
}

interface Session {
  id: string;
  title: string;
  lastAt: number;
  platform?: string;
  toolCalls: number;
  model?: string;
}

export interface HermesSourceOptions {
  office: Office;
  now?: () => number;
  /** Intervalo do relógio que põe à toa e tira as sessões paradas (padrão 10 s). */
  tickMs?: number;
}

export class HermesSource implements AgentSource {
  readonly provider: Provider = 'hermes';
  private readonly sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly o: HermesSourceOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Sem boot: o Hermes não deixa nada para reler; a sessão aparece no próximo evento dela. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return [{ label: HERMES_ACCOUNT, provider: 'hermes', path: 'tailnet', sessions: this.sessions.size, ok: true }];
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Aplica um lote, na ordem. Um evento que falha não derruba os outros (vai para o log). */
  apply(events: readonly HermesEvent[]): void {
    for (const ev of events) {
      try {
        this.applyOne(ev);
      } catch (err) {
        log.warnOnce('hermes-event', tr('Eventos do Hermes: falha ao aplicar um evento ({0}).', [errMsg(err)]));
      }
    }
  }

  /** Trabalhando e quieto há HERMES_QUIET_MS: à toa. Sem evento há HERMES_STALE_MS (ou já fora do escritório): sai. */
  tick(): void {
    const now = this.now();
    for (const [session, s] of this.sessions) {
      const status = this.o.office.get(s.id)?.status;
      if (status === undefined || now - s.lastAt >= HERMES_STALE_MS) {
        this.sessions.delete(session);
        this.o.office.closeMain(s.id);
      } else if (status === 'working' && now - s.lastAt >= HERMES_QUIET_MS) this.o.office.setStatus(s.id, 'idle');
    }
  }

  private applyOne(ev: HermesEvent): void {
    const office = this.o.office;
    const id = hermesAgentId(ev.session);
    if (ev.event === 'on_session_finalize' || ev.event === 'on_session_reset') {
      this.sessions.delete(ev.session);
      office.closeMain(id);
      return;
    }
    // Fim de conversa tardio de sessão fechada (ou nunca vista): não cria nem revive o agente.
    if ((ev.event === 'post_llm_call' || ev.event === 'on_session_end') && !this.sessions.has(ev.session)) return;
    const s = this.ensure(ev, id);
    if (!s) return;
    // Cron e subagente acabam na primeira conversa: fechar aqui, senão ficam "à toa" como fantasmas até o HERMES_STALE_MS.
    if ((ev.event === 'post_llm_call' || ev.event === 'on_session_end') && s.platform && ONE_SHOT_PLATFORMS.has(s.platform)) {
      this.sessions.delete(ev.session);
      office.closeMain(id);
      return;
    }
    switch (ev.event) {
      case 'pre_llm_call':
        office.setStatus(id, 'working');
        // Início do turno no relógio daqui: não depende do relógio da VPS.
        this.activity(id, ev, { kind: 'prompt', icon: '💬', text: tr('Recebeu uma mensagem') }, undefined, this.now());
        break;
      case 'pre_tool_call':
        s.toolCalls++;
        office.setStatus(id, 'working');
        if (ev.tool) this.activity(id, ev, describeHermesTool(ev.tool), ev.tool);
        break;
      case 'post_tool_call':
        // Ferramenta mais longa que HERMES_QUIET_MS: o tick pôs à toa no meio do turno; nunca tira de "waiting".
        if (office.get(id)?.status === 'idle') office.setStatus(id, 'working');
        if (ev.ok === false) this.activity(id, ev, SPECIAL.error(ev.tool), ev.tool);
        break;
      case 'pre_approval_request':
        office.setStatus(id, 'waiting', tr('aprovar um comando'));
        break;
      case 'post_approval_response':
        office.setStatus(id, 'working');
        break;
      // O on_session_end do Hermes vem no fim de cada conversa (run_conversation), não quando a sessão fecha.
      case 'post_llm_call':
      case 'on_session_end':
        office.setStatus(id, 'idle');
        break;
      case 'on_session_start':
        break;
    }
    office.applyTranscript(id, {
      title: s.title,
      tasks: [],
      stats: { toolCalls: s.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 },
      model: s.model,
      lastAt: this.at(ev),
    });
  }

  /** A sessão (e o agente) deste evento; cria se for nova ou se o Habblaud reiniciou no meio dela. */
  private ensure(ev: HermesEvent, id: string): Session | undefined {
    const title = `Hermes · ${ev.profile}${ev.platform ? ` (${ev.platform})` : ''}`;
    let s = this.sessions.get(ev.session);
    if (!s) {
      if (this.sessions.size >= HERMES_MAX_SESSIONS) {
        log.warnOnce('hermes-cap', tr('Eventos do Hermes: muitas sessões vivas, as novas são ignoradas.'));
        return undefined;
      }
      s = { id, title, lastAt: this.now(), toolCalls: 0 };
      this.sessions.set(ev.session, s);
    }
    if (ev.platform) {
      s.title = title;
      s.platform = ev.platform;
    }
    if (ev.model) s.model = ev.model;
    s.lastAt = this.now();
    const cur = this.o.office.get(id);
    if (!cur || cur.status === 'offline') {
      this.o.office.addMain({
        id,
        provider: 'hermes',
        account: HERMES_ACCOUNT,
        sessionId: ev.session,
        cwd: `hermes:/${ev.profile}`,
        role: tr('Agente do Hermes'),
        startedAt: this.at(ev),
        status: 'idle',
      });
    }
    return s;
  }

  private activity(id: string, ev: HermesEvent, d: ActivityDescription, tool?: string, at = this.at(ev)): void {
    const act: Activity = { id: `${id}#h:${++this.seq}`, at, kind: d.kind, icon: d.icon, text: d.text };
    if (tool) act.tool = tool;
    if (ev.durationMs !== undefined) act.durationMs = ev.durationMs;
    this.o.office.addActivity(id, act, true);
  }

  /** O horário do evento, nunca no futuro do relógio daqui (o da VPS pode estar adiantado). */
  private at(ev: HermesEvent): number {
    return Math.min(ev.at, this.now());
  }
}
