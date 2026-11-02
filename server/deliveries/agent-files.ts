// Seção Arquivos da gaveta (Fase 4, D4): os arquivos que o agente escreveu ou editou na sessão (Write, Edit, MultiEdit,
// NotebookEdit; as edições de notebook entram na leitura, mas .ipynb não é um tipo visível, então nunca aparece na
// lista), lidos do fim do transcript, do mais recente para o mais antigo. Só entram os que dá para ver no
// escritório (mesmos tipos e mesma blocklist das entregas, deliveries/files.ts); quem lê o arquivo é o FileFetcher das
// entregas. Os ids são opacos e valem para a última listagem de cada agente.
import { createHash } from 'node:crypto';
import type { AgentFileInfo } from '../../shared/types';
import { FileTail } from '../sources/tail';
import { fileType, pathProblem } from './files';

/** Quanto do fim do transcript entra (como nas entregas). */
export const FILES_TAIL_BYTES = 6 * 1024 * 1024;
export const MAX_AGENT_FILES = 50;
/** Agentes com ids guardados (os das últimas listagens). */
const MAX_AGENTS = 16;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** Caminhos escritos ou editados nas linhas do transcript: sem repetir, do mais recente para o mais antigo. */
export function writtenFiles(lines: Iterable<string>): Array<{ path: string; at: number }> {
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let d: Rec | undefined;
    try {
      d = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const content = rec(d?.message)?.content;
    if (d?.type !== 'assistant' || !Array.isArray(content)) continue;
    const t = Date.parse(String(d.timestamp));
    const at = Number.isNaN(t) ? 0 : t;
    for (const b of content) {
      const r = rec(b);
      if (r?.type !== 'tool_use' || !WRITE_TOOLS.has(String(r.name))) continue;
      const input = rec(r.input);
      const p = typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : '';
      if (!p) continue;
      seen.delete(p);
      seen.set(p, at);
    }
  }
  return [...seen].reverse().map(([path, at]) => ({ path, at }));
}

export interface AgentFilesOptions {
  transcriptPathOf: (agentId: string) => string | undefined;
  /** Pasta do projeto do agente (para mostrar o caminho relativo). */
  cwdOf: (agentId: string) => string | undefined;
}

export class AgentFiles {
  private readonly ids = new Map<string, Map<string, string>>();

  constructor(private readonly opts: AgentFilesOptions) {}

  /** Arquivos de ver que o agente escreveu, mais recente primeiro; undefined = agente sem transcript conhecido. */
  list(agentId: string): AgentFileInfo[] | undefined {
    const transcript = this.opts.transcriptPathOf(agentId);
    if (!transcript) return undefined;
    const lines: string[] = [];
    let readable = true;
    try {
      const tail = new FileTail(transcript);
      tail.seekTail(FILES_TAIL_BYTES);
      for (let i = 0; i < 64; i++) {
        const r = tail.read();
        if (r.missing) readable = false;
        lines.push(...r.lines);
        if (!r.more) break;
      }
    } catch {
      readable = false;
    }
    const cwd = this.opts.cwdOf(agentId)?.replace(/\/+$/, '');
    const ids = new Map<string, string>();
    const out: AgentFileInfo[] = [];
    for (const f of writtenFiles(lines)) {
      if (out.length >= MAX_AGENT_FILES) break;
      const type = fileType(f.path);
      if (!type || pathProblem(f.path)) continue;
      const id = createHash('sha256').update(`${agentId}|${f.path}`).digest('hex').slice(0, 20);
      ids.set(id, f.path);
      const rel = cwd && f.path.startsWith(`${cwd}/`) ? f.path.slice(cwd.length + 1) : f.path;
      out.push({ id, name: f.path.split('/').pop() || f.path, path: rel, kind: type.kind, at: f.at });
    }
    // Transcript ilegível agora: lista vazia, mas os ids da última boa listagem continuam valendo.
    if (readable) {
      this.ids.delete(agentId);
      this.ids.set(agentId, ids);
      if (this.ids.size > MAX_AGENTS) this.ids.delete(this.ids.keys().next().value as string);
    }
    return out;
  }

  /** Caminho real de um id da última listagem do agente. */
  path(agentId: string, id: string): string | undefined {
    return this.ids.get(agentId)?.get(id);
  }
}
