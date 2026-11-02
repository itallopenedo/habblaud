// Opções do Novo agente: modelo, esforço e modo de permissão do Claude Code e do Codex. O servidor só aceita valores
// destas listas (nenhum texto livre vira argumento dos CLIs). Claude: lista fixa (o `claude` não lista modelos).
// Codex: o catálogo de `codex debug models` (JSON), só os modelos com visibility "list", com os níveis de esforço de
// cada um. As opções que tiram todas as travas (bypassPermissions no Claude, danger-full-access no Codex) ficam de
// fora: quem usa isso na configuração do CLI escolhe "Padrão" (nenhuma opção vai para o CLI).
// Node puro e sem dependências.
import { execFile } from 'node:child_process';
import { tr } from '../../shared/i18n';
import type { LaunchModel } from '../../shared/types';

export type LaunchAgent = 'claude' | 'codex';

export type ModelOption = LaunchModel;

/** Escolhas da folha; ausente = padrão do CLI. */
export interface LaunchChoice {
  model?: string;
  effort?: string;
  permission?: string;
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', efforts: CLAUDE_EFFORTS },
];

/** `claude --permission-mode` (sem bypassPermissions). */
export const CLAUDE_PERMISSIONS = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

/** Modos do Codex: sandbox (-s) e política de aprovação (-a), sem danger-full-access. */
export const CODEX_PERMISSIONS: Record<string, { sandbox: string; approval: string }> = {
  'read-only': { sandbox: 'read-only', approval: 'on-request' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'on-request' },
  'workspace-auto': { sandbox: 'workspace-write', approval: 'never' },
};

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
export const CATALOG_TIMEOUT_MS = 15_000;
export const CATALOG_TTL_MS = 10 * 60_000;
/** Catálogo que falhou: espera este tempo antes de rodar o `codex debug models` de novo. */
export const CATALOG_RETRY_MS = 60_000;

/** Lê a saída de `codex debug models`: só os modelos listados, com os níveis de esforço que eles aceitam. */
export function parseCodexModels(raw: unknown): ModelOption[] {
  const models = raw && typeof raw === 'object' ? (raw as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  const out: ModelOption[] = [];
  for (const m of models) {
    const r = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    if (r.visibility !== 'list' || typeof r.slug !== 'string' || !ID.test(r.slug)) continue;
    const levels = Array.isArray(r.supported_reasoning_levels) ? r.supported_reasoning_levels : [];
    const efforts = levels.map((l) => (l && typeof l === 'object' ? (l as { effort?: unknown }).effort : undefined)).filter((e): e is string => typeof e === 'string' && ID.test(e));
    const name = typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name.trim().slice(0, 60) : r.slug;
    const def = typeof r.default_reasoning_level === 'string' && efforts.includes(r.default_reasoning_level) ? r.default_reasoning_level : undefined;
    out.push({ id: r.slug, name, efforts, ...(def ? { defaultEffort: def } : {}) });
  }
  return out;
}

export type CodexCatalog = (codexHome?: string) => Promise<ModelOption[]>;

/** Catálogo do Codex por CODEX_HOME, em cache por CATALOG_TTL_MS; falha = lista vazia (e tenta de novo na próxima). */
export function createCodexCatalog(bin: string, opts: { env?: NodeJS.ProcessEnv; now?: () => number; ttlMs?: number } = {}): CodexCatalog {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;
  const cache = new Map<string, { at: number; list: Promise<ModelOption[]>; failed?: boolean }>();
  return (codexHome) => {
    const key = codexHome ?? '';
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.failed ? CATALOG_RETRY_MS : ttl)) return hit.list;
    const env = { ...(opts.env ?? process.env) };
    if (codexHome) env.CODEX_HOME = codexHome;
    const list = new Promise<ModelOption[]>((ok) => {
      execFile(bin, ['debug', 'models'], { env, timeout: CATALOG_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
        let parsed: ModelOption[] = [];
        try {
          parsed = err ? [] : parseCodexModels(JSON.parse(out));
        } catch {
          parsed = [];
        }
        if (!parsed.length) entry.failed = true;
        ok(parsed);
      });
    });
    const entry: { at: number; list: Promise<ModelOption[]>; failed?: boolean } = { at: now(), list };
    cache.set(key, entry);
    return list;
  };
}

/**
 * Confere modelo, esforço e permissão contra as listas. Sem modelo, o esforço vale se algum modelo da lista o
 * aceita (o CLI usa o modelo padrão dele).
 */
export function parseChoice(agent: LaunchAgent, raw: unknown, models: readonly ModelOption[]): LaunchChoice | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (k: string): string | undefined | null => {
    const v = r[k];
    if (v === undefined || v === null || v === '') return undefined;
    return typeof v === 'string' ? v : null;
  };
  const model = pick('model');
  const effort = pick('effort');
  const permission = pick('permission');
  if (model === null || effort === null || permission === null) return { error: tr('opção inválida') };
  const m = model === undefined ? undefined : models.find((x) => x.id === model);
  if (model !== undefined && !m) return { error: tr('modelo desconhecido: {0}', [model.slice(0, 80)]) };
  if (effort !== undefined && !(m ? m.efforts : models.flatMap((x) => x.efforts)).includes(effort)) {
    return { error: tr('esforço não aceito: {0}', [effort.slice(0, 40)]) };
  }
  const perms = agent === 'claude' ? CLAUDE_PERMISSIONS : Object.keys(CODEX_PERMISSIONS);
  if (permission !== undefined && !perms.includes(permission)) return { error: tr('modo de permissão desconhecido: {0}', [permission.slice(0, 40)]) };
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permission ? { permission } : {}) };
}

/** Argumentos do Codex interativo: pasta, escolhas e o pedido depois de `--`. */
export function codexArgs(cwd: string, choice: LaunchChoice, prompt?: string): string[] {
  const args = ['-C', cwd];
  if (choice.model) args.push('-m', choice.model);
  if (choice.effort) args.push('-c', `model_reasoning_effort="${choice.effort}"`);
  const perm = choice.permission ? CODEX_PERMISSIONS[choice.permission] : undefined;
  if (perm) args.push('-s', perm.sandbox, '-a', perm.approval);
  if (prompt?.trim()) args.push('--', prompt);
  return args;
}
