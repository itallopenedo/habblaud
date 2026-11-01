// Uso do Fable por conta, lido das transcrições locais (<configDir>/projects/<projeto>/*.jsonl).
// O Fable não tem limite semanal, então não há % para mostrar: somam-se os tokens de hoje e dos últimos
// 7 dias (hoje incluído). Só lê arquivos, nunca credenciais, e relê apenas o que mudou (tamanho e data).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FableUsage, TokenTotals } from '../../shared/types';

/** Arquivos parados há mais que isto não têm registros dos últimos 7 dias. */
const MAX_AGE_MS = 8 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

interface FableRecord {
  /** Chave da resposta (requestId + id da mensagem): o Claude Code grava a mesma resposta em mais de uma linha. */
  key: string;
  /** Dia local AAAA-MM-DD. */
  day: string;
  tokens: TokenTotals;
}

interface FileCache {
  size: number;
  mtimeMs: number;
  records: FableRecord[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Dia local (do host, o mesmo fuso que o usuário vê no relógio) no formato AAAA-MM-DD. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Registros do Fable de um arquivo .jsonl (linhas inválidas são ignoradas). */
export function parseFableRecords(text: string): FableRecord[] {
  const out: FableRecord[] = [];
  for (const line of text.split('\n')) {
    if (!/fable/i.test(line)) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message as Record<string, unknown> | undefined;
    const usage = m?.usage as Record<string, unknown> | undefined;
    if (!m || !usage || typeof m.model !== 'string' || !/fable/i.test(m.model)) continue;
    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : Number.NaN;
    const id = typeof m.id === 'string' ? m.id : typeof d.uuid === 'string' ? d.uuid : '';
    if (!Number.isFinite(ts) || !id) continue;
    out.push({
      key: `${typeof d.requestId === 'string' ? d.requestId : ''}|${id}`,
      day: dayOf(ts),
      tokens: {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
      },
    });
  }
  return out;
}

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function add(t: TokenTotals, r: TokenTotals): void {
  t.input += r.input;
  t.output += r.output;
  t.cacheWrite += r.cacheWrite;
  t.cacheRead += r.cacheRead;
}

/** Lê e soma os registros de uma pasta de projetos do Claude Code, com cache por arquivo. */
export class FableUsageReader {
  private files = new Map<string, FileCache>();

  read(projectsDir: string, now: number): FableUsage | undefined {
    const seen = new Set<string>();
    const records: FableRecord[] = [];
    for (const path of this.jsonlFiles(projectsDir)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > MAX_AGE_MS) continue;
      seen.add(path);
      const cached = this.files.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        records.push(...cached.records);
        continue;
      }
      let parsed: FableRecord[];
      try {
        parsed = parseFableRecords(readFileSync(path, 'utf8'));
      } catch {
        continue; // sumiu entre o stat e a leitura
      }
      this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, records: parsed });
      records.push(...parsed);
    }
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);

    const today = dayOf(now);
    const weekStart = dayOf(now - 6 * DAY_MS);
    const dedupe = new Set<string>();
    const out: FableUsage = { today: zero(), week: zero() };
    let any = false;
    for (const r of records) {
      if (r.day < weekStart || r.day > today || dedupe.has(r.key)) continue;
      dedupe.add(r.key);
      any = true;
      add(out.week, r.tokens);
      if (r.day === today) add(out.today, r.tokens);
    }
    return any ? out : undefined;
  }

  private jsonlFiles(projectsDir: string): string[] {
    const out: string[] = [];
    let projects: string[];
    try {
      projects = readdirSync(projectsDir);
    } catch {
      return out; // pasta ainda não existe
    }
    for (const project of projects) {
      const dir = join(projectsDir, project);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) if (name.endsWith('.jsonl')) out.push(join(dir, name));
    }
    return out;
  }
}
