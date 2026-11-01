// scripts/upstream-sync.ts: a main anda só por fast-forward, o merge acontece num worktree temporário e o branch
// próprio nunca anda com conflito, check vermelho ou mudança não commitada.
import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseSyncArgs, recoveryHint, upstreamSync, type SyncOptions } from '../../scripts/upstream-sync';

// Git isolado da configuração do Mac (assinatura de commit, identidade, hooks globais).
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'teste',
  GIT_AUTHOR_EMAIL: 'teste@exemplo.invalid',
  GIT_COMMITTER_NAME: 'teste',
  GIT_COMMITTER_EMAIL: 'teste@exemplo.invalid',
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function commit(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, 'commit', '-qm', file);
}

/** up = o upstream; repo = clone com main e meu-habblaud (um commit próprio em mine.txt), main em uso. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'habblaud-sync-test-'));
  dirs.push(root);
  const up = join(root, 'up');
  sh(root, 'init', '-q', '-b', 'main', up);
  commit(up, 'a.txt', 'um\n');
  const repo = join(root, 'repo');
  sh(root, 'clone', '-q', up, repo);
  sh(repo, 'switch', '-q', '-c', 'meu-habblaud');
  commit(repo, 'mine.txt', 'meu\n');
  sh(repo, 'switch', '-q', 'main');
  const opts = (over: Partial<SyncOptions> = {}): SyncOptions => ({
    repo, upstream: 'origin', base: 'main', branch: 'meu-habblaud', checks: [], worktreeDir: join(root, 'wt'), quiet: true, ...over,
  });
  return { root, up, repo, opts };
}

describe('upstreamSync', () => {
  it('nada novo no upstream: up-to-date e nada muda', () => {
    const { repo, opts } = setup();
    const before = sh(repo, 'rev-parse', 'meu-habblaud');
    expect(upstreamSync(opts())).toEqual({ status: 'up-to-date' });
    expect(sh(repo, 'rev-parse', 'meu-habblaud')).toBe(before);
  });

  it('versão nova: main avança por fast-forward e meu-habblaud recebe o merge sem perder o próprio commit', () => {
    const { up, repo, opts } = setup();
    commit(up, 'b.txt', 'novo\n');
    expect(upstreamSync(opts())).toMatchObject({ status: 'merged' });
    expect(sh(repo, 'rev-parse', 'main')).toBe(sh(up, 'rev-parse', 'main'));
    expect(sh(repo, 'show', 'meu-habblaud:b.txt')).toBe('novo');
    expect(sh(repo, 'show', 'meu-habblaud:mine.txt')).toBe('meu');
    expect(existsSync(opts().worktreeDir)).toBe(false);
  });

  it('meu-habblaud em uso num worktree limpo: anda lá, por fast-forward, e o worktree fica limpo', () => {
    const { root, up, repo, opts } = setup();
    const wt = join(root, 'meu');
    sh(repo, 'worktree', 'add', '-q', wt, 'meu-habblaud');
    commit(up, 'b.txt', 'novo\n');
    expect(upstreamSync(opts())).toMatchObject({ status: 'merged' });
    expect(readFileSync(join(wt, 'b.txt'), 'utf8')).toBe('novo\n');
    expect(sh(wt, 'status', '--porcelain')).toBe('');
  });

  it('conflito: devolve os arquivos, deixa o worktree e não move meu-habblaud', () => {
    const { up, repo, opts } = setup();
    sh(repo, 'switch', '-q', 'meu-habblaud');
    commit(repo, 'a.txt', 'meu um\n');
    sh(repo, 'switch', '-q', 'main');
    commit(up, 'a.txt', 'deles um\n');
    const before = sh(repo, 'rev-parse', 'meu-habblaud');
    expect(upstreamSync(opts())).toEqual({ status: 'conflict', worktree: opts().worktreeDir, files: ['a.txt'] });
    expect(sh(repo, 'rev-parse', 'meu-habblaud')).toBe(before);
    expect(existsSync(opts().worktreeDir)).toBe(true);
  });

  it('check vermelho: não move meu-habblaud e diz qual check falhou', () => {
    const { up, repo, opts } = setup();
    commit(up, 'b.txt', 'novo\n');
    const before = sh(repo, 'rev-parse', 'meu-habblaud');
    expect(upstreamSync(opts({ checks: [['false']] }))).toEqual({ status: 'checks-failed', worktree: opts().worktreeDir, check: 'false' });
    expect(sh(repo, 'rev-parse', 'meu-habblaud')).toBe(before);
  });

  it('main com commit próprio: recusa (a main só espelha o upstream)', () => {
    const { up, repo, opts } = setup();
    commit(repo, 'local.txt', 'x\n');
    commit(up, 'b.txt', 'novo\n');
    expect(upstreamSync(opts())).toMatchObject({ status: 'refused', reason: expect.stringMatching(/main tem commits/) });
  });

  it('mudança não commitada onde um dos branches está em uso: recusa antes do fetch', () => {
    const { up, repo, opts } = setup();
    writeFileSync(join(repo, 'a.txt'), 'sujo\n');
    commit(up, 'b.txt', 'novo\n');
    expect(upstreamSync(opts())).toMatchObject({ status: 'refused', reason: expect.stringMatching(/não commitadas/) });
    expect(sh(repo, 'rev-parse', 'origin/main')).not.toBe(sh(up, 'rev-parse', 'main'));
  });
});

describe('recoveryHint', () => {
  it('branch em uso num worktree: faz o ff nesse worktree e remove o worktree temporário', () => {
    const { root, repo, opts } = setup();
    const wt = join(root, 'meu');
    sh(repo, 'worktree', 'add', '-q', wt, 'meu-habblaud');
    const hint = recoveryHint(repo, 'meu-habblaud', opts().worktreeDir);
    expect(hint).toContain(`-C ${realpathSync(wt)} merge --ff-only`);
    expect(hint).toContain(`worktree remove ${opts().worktreeDir}`);
  });

  it('branch sem worktree em uso: branch -f', () => {
    const { repo, opts } = setup();
    const hint = recoveryHint(repo, 'meu-habblaud', opts().worktreeDir);
    expect(hint).toContain('branch -f meu-habblaud');
  });

  it('ponta a ponta: resolver e commitar no worktree, rodar a dica, e meu-habblaud traz os dois lados', () => {
    const { up, repo, opts } = setup();
    sh(repo, 'switch', '-q', 'meu-habblaud');
    commit(repo, 'a.txt', 'meu um\n');
    sh(repo, 'switch', '-q', 'main');
    commit(up, 'a.txt', 'deles um\n');
    const r = upstreamSync(opts());
    if (r.status !== 'conflict') throw new Error(`esperava conflito, veio ${r.status}`);
    writeFileSync(join(r.worktree, 'a.txt'), 'resolvido\n');
    sh(r.worktree, 'add', 'a.txt');
    sh(r.worktree, 'commit', '--no-edit');
    execSync(recoveryHint(repo, 'meu-habblaud', r.worktree), { shell: '/bin/sh', cwd: repo, stdio: 'ignore' });
    expect(sh(repo, 'show', 'meu-habblaud:mine.txt')).toBe('meu');
    expect(sh(repo, 'show', 'meu-habblaud:a.txt')).toBe('resolvido');
    expect(sh(repo, 'rev-list', '--parents', '-n1', 'meu-habblaud').split(' ')).toHaveLength(3);
    expect(existsSync(r.worktree)).toBe(false);
  });
});

describe('node_modules do worktree temporário', () => {
  it('o link de node_modules fica ignorado: checks vermelho deixa o worktree limpo e a dica o remove', () => {
    const { up, repo, opts } = setup();
    // No Mac, o .gitignore do repo pega node_modules/; fora dele, o mesmo efeito vem do exclude do próprio repo.
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'pacote.js'), 'x\n');
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n');
    commit(up, 'b.txt', 'novo\n');
    const o = opts({ checks: [['false']] });
    expect(upstreamSync(o)).toEqual({ status: 'checks-failed', worktree: o.worktreeDir, check: 'false' });
    expect(sh(o.worktreeDir, 'status', '--porcelain')).toBe('');
    writeFileSync(join(o.worktreeDir, 'fix.txt'), 'conserto\n');
    sh(o.worktreeDir, 'add', 'fix.txt');
    sh(o.worktreeDir, 'commit', '-qm', 'conserto');
    execSync(recoveryHint(repo, 'meu-habblaud', o.worktreeDir), { shell: '/bin/sh', stdio: 'ignore' });
    expect(sh(repo, 'show', 'meu-habblaud:fix.txt')).toBe('conserto');
    expect(sh(repo, 'show', 'meu-habblaud:b.txt')).toBe('novo');
    expect(existsSync(o.worktreeDir)).toBe(false);
  });
});

describe('parseSyncArgs', () => {
  it('padrão meu-habblaud com checks; --branch e --no-checks; opção desconhecida lança', () => {
    expect(parseSyncArgs([])).toEqual({ branch: 'meu-habblaud', checks: true, help: false });
    expect(parseSyncArgs(['--branch', 'outro', '--no-checks'])).toEqual({ branch: 'outro', checks: false, help: false });
    expect(parseSyncArgs(['-h'])).toMatchObject({ help: true });
    expect(() => parseSyncArgs(['--push'])).toThrow(/desconhecida/);
    expect(() => parseSyncArgs(['--branch'])).toThrow(/desconhecida|--branch/);
  });
});
