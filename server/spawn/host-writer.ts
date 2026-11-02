// Anexos das mensagens no Docker (Fase 4, D2): o container não grava no Mac, e o agente lê o anexo pelo caminho do Mac.
// Quem grava é o auxiliar do host (scripts/codex-bridge.ts), do mesmo jeito que os anexos do Novo agente (checkFiles +
// writeAttachments em ~/.habblaud/attachments/, pasta 700 e arquivos 600). O servidor deixa os arquivos aqui; o
// auxiliar busca em POST /api/host/attachments/poll (rodada com espera), grava e devolve os caminhos em
// POST /api/host/attachments/ack.
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import type { Attachment } from './attachments';

export const HOST_PRESENCE_MS = 10_000;
export const WRITE_TIMEOUT_MS = 20_000;
const MAX_PENDING = 8;
const PATH_MAX = 4_096;

export interface PolledWrite {
  id: string;
  files: Array<{ name: string; type: string; data: string }>;
}

interface Pending {
  id: string;
  files: readonly Attachment[];
  sent: boolean;
  done: (r: { paths: string[] } | { error: string }) => void;
}

export class HostFileWriter {
  private readonly pending = new Map<string, Pending>();
  private readonly host: HostWait;

  constructor(private readonly opts: { now?: () => number; newId?: () => string; timeoutMs?: number } = {}) {
    this.host = new HostWait(HOST_PRESENCE_MS, opts.now ?? Date.now);
  }

  /** Pede ao auxiliar que grave os arquivos: os caminhos no Mac, na ordem, ou a rejeição com o motivo. */
  write(files: readonly Attachment[]): Promise<string[]> {
    if (!this.host.present()) return Promise.reject(new Error(tr('o auxiliar do computador (npm run codex:bridge) não está rodando')));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error(tr('anexos demais sendo gravados: tente de novo')));
    return new Promise((ok, fail) => {
      const p: Pending = { id: this.opts.newId?.() ?? randomUUID(), files, sent: false, done: (r) => ('paths' in r ? ok(r.paths) : fail(new Error(r.error))) };
      this.pending.set(p.id, p);
      this.host.wake();
      setTimeout(() => {
        if (this.pending.delete(p.id)) p.done({ error: tr('o computador não gravou os anexos a tempo') });
      }, this.opts.timeoutMs ?? WRITE_TIMEOUT_MS).unref?.();
    });
  }

  /** Rodada do auxiliar: marca presença e entrega os arquivos ainda não buscados (base64). */
  poll(): PolledWrite[] {
    this.host.seen();
    const out: PolledWrite[] = [];
    for (const p of this.pending.values()) {
      if (p.sent) continue;
      p.sent = true;
      out.push({ id: p.id, files: p.files.map((f) => ({ name: f.name, type: f.type, data: f.data.toString('base64') })) });
    }
    return out;
  }

  /** Rodada com espera (?wait=1): sem nada pedido, fica parada até chegar um pedido ou passar `ms`. */
  pollWait(ms: number, signal?: AbortSignal): Promise<PolledWrite[]> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  /** {results: [{id, ok, paths?, error?}]}: um caminho absoluto por arquivo, sem quebra de linha (vão no texto). */
  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const p = typeof x.id === 'string' ? this.pending.get(x.id) : undefined;
      if (!p || !p.sent) continue;
      this.pending.delete(p.id);
      const paths = Array.isArray(x.paths) ? x.paths : [];
      const valid =
        x.ok === true &&
        paths.length === p.files.length &&
        paths.every((s) => typeof s === 'string' && s.startsWith('/') && s.length <= PATH_MAX && !/[\r\n\0]/.test(s));
      p.done(valid ? { paths: paths as string[] } : { error: typeof x.error === 'string' && x.error ? x.error.slice(0, 200) : tr('o computador não gravou os anexos') });
    }
  }
}
