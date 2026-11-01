// Traz as versões novas do upstream (marmottajr/habblaud) para o branch próprio. Roda no HOST, com tsx:
//   npm run upstream:sync                       -> origin/main -> main (só fast-forward) -> merge em meu-habblaud
//   npm run upstream:sync -- --branch outro     -> outro branch próprio
//   npm run upstream:sync -- --no-checks        -> sem typecheck/testes/i18n (não recomendado)
// O merge acontece num worktree temporário. Com conflito ou check vermelho, o worktree fica para resolver e
// meu-habblaud não anda (a main, que só espelha o upstream, pode ter avançado antes). Nunca faz push. Ver FORK.md.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CHECKS: string[][] = [['npm', 'run', 'typecheck'], ['npm', 'test'], ['npm', 'run', 'i18n:check']];

export interface SyncOptions {
  repo: string;
  upstream: string;
  base: string;
  branch: string;
  checks: string[][];
  worktreeDir: string;
  quiet?: boolean;
}

export type SyncResult =
  | { status: 'up-to-date' }
  | { status: 'merged'; from: string; to: string }
  | { status: 'conflict'; worktree: string; files: string[] }
  | { status: 'checks-failed'; worktree: string; check: string }
  | { status: 'refused'; reason: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

/** Pasta do worktree onde `branch` está em uso, ou undefined. */
export function checkedOutAt(repo: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/** O .gitignore pega `node_modules/` só como diretório; o link do worktree é arquivo, então ignora-se no exclude compartilhado. */
function excludeModules(wt: string): void {
  const file = resolve(wt, git(wt, 'rev-parse', '--git-path', 'info/exclude'));
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.split('\n').includes('/node_modules')) appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}/node_modules\n`);
}

/** Move `branch` para `sha`: por fast-forward no worktree onde ele está em uso, ou direto no ref. */
function advance(repo: string, branch: string, sha: string): void {
  const at = checkedOutAt(repo, branch);
  if (at) git(at, 'merge', '--ff-only', '--quiet', sha);
  else git(repo, 'update-ref', `refs/heads/${branch}`, sha);
}

export function upstreamSync(o: SyncOptions): SyncResult {
  for (const b of [o.base, o.branch]) {
    if (!gitOk(o.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`)) return { status: 'refused', reason: `o branch ${b} não existe` };
    const at = checkedOutAt(o.repo, b);
    if (at && git(at, 'status', '--porcelain')) return { status: 'refused', reason: `${b} tem mudanças não commitadas em ${at}` };
  }
  git(o.repo, 'fetch', '--quiet', o.upstream);
  const remote = `${o.upstream}/${o.base}`;
  if (!gitOk(o.repo, 'merge-base', '--is-ancestor', o.base, remote)) {
    return { status: 'refused', reason: `${o.base} tem commits que não estão em ${remote}: a ${o.base} só espelha o upstream` };
  }
  advance(o.repo, o.base, git(o.repo, 'rev-parse', remote));
  if (gitOk(o.repo, 'merge-base', '--is-ancestor', o.base, o.branch)) return { status: 'up-to-date' };

  const from = git(o.repo, 'rev-parse', o.branch);
  git(o.repo, 'worktree', 'add', '--quiet', '--detach', o.worktreeDir, o.branch);
  if (!gitOk(o.worktreeDir, 'merge', '--no-ff', '--no-edit', '-m', `Merge do upstream (${remote}) em ${o.branch}`, o.base)) {
    const files = git(o.worktreeDir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    excludeModules(o.worktreeDir);
    return { status: 'conflict', worktree: o.worktreeDir, files };
  }
  // Os checks usam as dependências já instaladas no checkout principal.
  const modules = join(o.repo, 'node_modules');
  if (existsSync(modules) && !existsSync(join(o.worktreeDir, 'node_modules'))) {
    symlinkSync(modules, join(o.worktreeDir, 'node_modules'));
    excludeModules(o.worktreeDir);
  }
  for (const check of o.checks) {
    try {
      execFileSync(check[0], check.slice(1), { cwd: o.worktreeDir, stdio: o.quiet ? 'ignore' : 'inherit' });
    } catch {
      return { status: 'checks-failed', worktree: o.worktreeDir, check: check.join(' ') };
    }
  }
  const to = git(o.worktreeDir, 'rev-parse', 'HEAD');
  advance(o.repo, o.branch, to);
  git(o.repo, 'worktree', 'remove', '--force', o.worktreeDir);
  return { status: 'merged', from, to };
}

export function parseSyncArgs(argv: string[]): { branch: string; checks: boolean; help: boolean } {
  const args = { branch: 'meu-habblaud', checks: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch' && argv[i + 1] && !argv[i + 1].startsWith('-')) args.branch = argv[++i];
    else if (a === '--no-checks') args.checks = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  return args;
}

/** Comandos que levam o merge commitado no worktree para `branch` e removem o worktree. Lidos depois do commit. */
export function recoveryHint(repo: string, branch: string, worktree: string): string {
  const sha = `$(git -C ${worktree} rev-parse HEAD)`;
  const at = checkedOutAt(repo, branch);
  const bring = at ? `git -C ${at} merge --ff-only ${sha}` : `git -C ${repo} branch -f ${branch} ${sha}`;
  return `${bring} && git -C ${repo} worktree remove ${worktree}`;
}

function summary(r: SyncResult, branch: string, repo: string): string {
  switch (r.status) {
    case 'up-to-date':
      return `✓ ${branch} já tem tudo do upstream.`;
    case 'merged':
      return `✓ ${branch}: ${r.from.slice(0, 7)} → ${r.to.slice(0, 7)}. Confira e, se quiser, git push fork ${branch}.`;
    case 'conflict':
      return `✗ Conflito em ${r.files.join(', ')}. Resolva em ${r.worktree} e commite lá (git -C ${r.worktree} commit --no-edit); rode os checks lá (ln -s ${repo}/node_modules ${r.worktree}/node_modules; npm run typecheck && npm test && npm run i18n:check). Depois: ${recoveryHint(repo, branch, r.worktree)}`;
    case 'checks-failed':
      return `✗ O check "${r.check}" falhou depois do merge; ${branch} não mudou. Corrija e commite em ${r.worktree}, rode os checks lá e depois: ${recoveryHint(repo, branch, r.worktree)}`;
    case 'refused':
      return `✗ Nada feito: ${r.reason}.`;
  }
}

function main(argv: string[]): void {
  const args = parseSyncArgs(argv);
  if (args.help) {
    console.log('npm run upstream:sync [-- --branch <branch>] [-- --no-checks]  (ver FORK.md)');
    return;
  }
  const r = upstreamSync({
    repo: ROOT,
    upstream: 'origin',
    base: 'main',
    branch: args.branch,
    checks: args.checks ? DEFAULT_CHECKS : [],
    worktreeDir: join(tmpdir(), `habblaud-sync-${Date.now()}`),
  });
  console.log(summary(r, args.branch, ROOT));
  if (r.status !== 'merged' && r.status !== 'up-to-date') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
