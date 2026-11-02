// Eventos do Hermes (Fase 6): o plugin habblaud-observer, na VPS, manda o que o Hermes está fazendo para
// POST /api/hermes/events na porta da tailnet (http/tailnet.ts). É a ÚNICA rota dessa porta que não pede o login
// remoto. Antes dela já passaram o guard (Host .ts.net, Origin, JSON) e o usuário do Tailscale (a VPS é do mesmo dono,
// então o tailscale serve põe o cabeçalho); aqui ela pede um freio de requisições, o token Bearer (só a sha256 no .env,
// server/hermes/token.ts), corpo JSON até 64 KB e o formato exato (chave a mais = 400: nenhum texto entra por engano).
// Nas portas 4747 e 4748 a rota não existe (404): quem a trata é só o listener da tailnet, no server/index.ts.
//
//   POST /api/hermes/events  (Bearer)  {v: 1, events: [{profile, platform?, session, event, tool?, ok?, duration_ms?, at, model?}]}
//                                       → 200 {ok: true, n}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { HERMES_EVENTS, type HermesEvent, type HermesEventName } from '../sources/hermes/source';
import { bearerMatches } from './token';

export const HERMES_EVENTS_PATH = '/api/hermes/events';
export const HERMES_BODY_MAX = 64 * 1024;
export const HERMES_BATCH_MAX = 100;

const PROFILE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const PLATFORM = /^[a-z0-9_-]{1,20}$/;
const SESSION = /^[0-9a-f]{16}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{1,80}$/;
const KEYS = new Set(['profile', 'platform', 'session', 'event', 'tool', 'ok', 'duration_ms', 'at', 'model']);
const DAY_MS = 86_400_000;

function bad(what: string): never {
  throw new HttpError(400, tr('evento do Hermes inválido ({0})', [what]));
}

/** Corpo de POST /api/hermes/events, campo a campo; qualquer coisa fora do formato: HttpError 400. */
export function parseHermesBatch(raw: unknown): HermesEvent[] {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const events = r?.events;
  if (!r || r.v !== 1 || !Array.isArray(events) || !events.length || events.length > HERMES_BATCH_MAX || Object.keys(r).some((k) => k !== 'v' && k !== 'events')) {
    throw new HttpError(400, tr('esperado {v: 1, events: [1 a {0} eventos do Hermes]}', [HERMES_BATCH_MAX]));
  }
  return events.map(parseEvent);
}

function parseEvent(raw: unknown): HermesEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('objeto');
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!KEYS.has(k)) bad(k);
  const { profile, platform, session, event, tool, ok, duration_ms: duration, at, model } = e;
  if (typeof profile !== 'string' || !PROFILE.test(profile)) bad('profile');
  if (typeof session !== 'string' || !SESSION.test(session)) bad('session');
  if (typeof event !== 'string' || !(HERMES_EVENTS as readonly string[]).includes(event)) bad('event');
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) bad('at');
  const out: HermesEvent = { profile, session, event: event as HermesEventName, at };
  if (platform !== undefined) {
    if (typeof platform !== 'string' || !PLATFORM.test(platform)) bad('platform');
    out.platform = platform;
  }
  if (tool !== undefined) {
    if (typeof tool !== 'string' || !TOOL.test(tool)) bad('tool');
    out.tool = tool;
  }
  if (ok !== undefined) {
    if (typeof ok !== 'boolean') bad('ok');
    out.ok = ok;
  }
  if (duration !== undefined) {
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0 || duration > DAY_MS) bad('duration_ms');
    out.durationMs = duration;
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || !MODEL.test(model)) bad('model');
    out.model = model;
  }
  return out;
}

/** Freio simples: no máximo `max` requisições por janela fixa de `windowMs`. */
export class FixedWindowLimiter {
  private start = -Infinity;
  private n = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(): boolean {
    const t = this.now();
    if (t - this.start >= this.windowMs) {
      this.start = t;
      this.n = 0;
    }
    return ++this.n <= this.max;
  }
}

export interface HermesIngestOptions {
  /** sha256 do token (parseHermesTokenHash). */
  tokenHash: Buffer;
  /** Quem recebe os eventos válidos (HermesSource.apply). */
  apply: (events: readonly HermesEvent[]) => void;
  /** Padrão: 60 requisições a cada 10 s (o plugin junta até 50 eventos por requisição). */
  limiter?: FixedWindowLimiter;
}

/**
 * Trata POST /api/hermes/events no listener da tailnet, ANTES do login (o guard e o usuário do Tailscale já passaram).
 * Devolve false para qualquer outro caminho (inclusive variantes como "/api/hermes/events/"), que segue para o login.
 */
export function createHermesIngest(o: HermesIngestOptions): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const limiter = o.limiter ?? new FixedWindowLimiter(60, 10_000);
  return (req, res, url) => {
    if (url.pathname !== HERMES_EVENTS_PATH) return false;
    const refuse = (status: number, error: string, headers: Record<string, string> = {}) => {
      req.resume();
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      sendJson(res, status, { error });
    };
    if (req.method !== 'POST') refuse(405, tr('método não permitido'), { Allow: 'POST' });
    else if (!limiter.take()) refuse(429, tr('muitos eventos do Hermes: tente de novo em instantes'), { 'Retry-After': '10' });
    else if (!bearerMatches(req.headers.authorization, o.tokenHash)) refuse(401, tr('token do Hermes inválido'));
    else {
      readJson(req, HERMES_BODY_MAX)
        .then((body) => {
          const events = parseHermesBatch(body);
          o.apply(events);
          sendJson(res, 200, { ok: true, n: events.length });
        })
        .catch((err) => {
          if (res.headersSent) return void res.destroy();
          if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
          else sendJson(res, 500, { error: tr('erro interno') });
        });
    }
    return true;
  };
}
