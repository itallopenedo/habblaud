// Aba Arquivos: o que o agente escreveu ou editou na sessão, lido do transcript (linhas sintéticas).
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { L, symlinkOrSkip, tempDir, writeLines } from '../test/fixtures';
import { AgentFiles, MAX_AGENT_FILES, writtenFiles } from './agent-files';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const wrote = (path: string, at: number, tool = 'Write') =>
  L.assistant([L.tool(`t${at}`, tool, tool === 'NotebookEdit' ? { notebook_path: path, new_source: 'x' } : { file_path: path, content: 'x' })], { at });

describe('aba Arquivos: o que o agente escreveu', () => {
  it('writtenFiles: Write/Edit/MultiEdit/NotebookEdit, sem repetir, do mais recente para o mais antigo', () => {
    const lines = [
      wrote('/p/loja/relatorio.md', T0),
      wrote('/p/loja/tela.png', T0 + 1_000, 'Edit'),
      L.assistant([L.tool('r1', 'Read', { file_path: '/p/loja/lido.md' })], { at: T0 + 2_000 }),
      wrote('/p/loja/relatorio.md', T0 + 3_000, 'MultiEdit'),
      wrote('/p/loja/analise.ipynb', T0 + 4_000, 'NotebookEdit'),
      'linha quebrada {',
    ];
    expect(writtenFiles(lines)).toEqual([
      { path: '/p/loja/analise.ipynb', at: T0 + 4_000 },
      { path: '/p/loja/relatorio.md', at: T0 + 3_000 },
      { path: '/p/loja/tela.png', at: T0 + 1_000 },
    ]);
  });

  it('lista só o que dá para ver aqui: nada de .env, chaves, pastas protegidas nem código; caminho relativo ao projeto', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 't.jsonl');
      writeLines(file, [
        wrote('/p/loja/.env', T0),
        wrote('/p/loja/server.key', T0 + 1),
        wrote('/Users/voce/.ssh/notas.md', T0 + 2),
        wrote('/p/loja/api-token.txt', T0 + 3),
        wrote('/p/loja/src/app.ts', T0 + 4),
        wrote('/p/loja/docs/relatorio.md', T0 + 5),
        wrote('/tmp/print.png', T0 + 6),
      ]);
      const files = new AgentFiles({ transcriptPathOf: (id) => (id === 'a1' ? file : undefined), cwdOf: () => '/p/loja', roots: ['/tmp'] });
      const list = files.list('a1')!;
      expect(list.map((f) => [f.name, f.path, f.kind, f.at])).toEqual([
        ['print.png', '/tmp/print.png', 'image', T0 + 6],
        ['relatorio.md', 'docs/relatorio.md', 'text', T0 + 5],
      ]);
      expect(files.path('a1', list[1].id)).toBe('/p/loja/docs/relatorio.md');
      expect(files.path('a2', list[1].id)).toBeUndefined();
      expect(files.list('a2')).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });

  it(`no máximo ${MAX_AGENT_FILES} arquivos, os mais recentes`, () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 't.jsonl');
      writeLines(file, Array.from({ length: MAX_AGENT_FILES + 10 }, (_, i) => wrote(`/p/loja/r${i}.md`, T0 + i)));
      const list = new AgentFiles({ transcriptPathOf: () => file, cwdOf: () => '/p/loja' }).list('a1')!;
      expect(list).toHaveLength(MAX_AGENT_FILES);
      expect(list[0].name).toBe(`r${MAX_AGENT_FILES + 9}.md`);
    } finally {
      tmp.cleanup();
    }
  });

  it('transcript ilegível na releitura: a lista vem vazia, mas os ids da última boa continuam abrindo', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 't.jsonl');
      writeLines(file, [wrote('/p/loja/docs/relatorio.md', T0)]);
      const files = new AgentFiles({ transcriptPathOf: () => file, cwdOf: () => '/p/loja' });
      const [first] = files.list('a1')!;
      rmSync(file);
      expect(files.list('a1')).toEqual([]);
      expect(files.path('a1', first.id)).toBe('/p/loja/docs/relatorio.md');
    } finally {
      tmp.cleanup();
    }
  });

  it('allows: só dentro da pasta do próprio agente (ou das raízes temporárias e de anexos), nunca a pasta de outro projeto', () => {
    const files = new AgentFiles({ transcriptPathOf: () => undefined, cwdOf: (id) => (id === 'a1' ? '/p/loja/' : undefined), roots: ['/tmp', '/x/anexos/'] });
    expect(files.allows('a1', '/p/loja/docs/relatorio.md')).toBe(true);
    expect(files.allows('a1', '/tmp/print.png')).toBe(true);
    expect(files.allows('a1', '/x/anexos/20260101-000000-ab/foto.png')).toBe(true);
    // Fora do cwd: outro projeto, o home, um nome que só começa igual.
    expect(files.allows('a1', '/p/outro/relatorio.md')).toBe(false);
    expect(files.allows('a1', '/p/loja2/relatorio.md')).toBe(false);
    expect(files.allows('a1', '/Users/voce/Documents/contrato.pdf')).toBe(false);
    // Agente sem pasta conhecida: só as raízes.
    expect(files.allows('a2', '/p/loja/docs/relatorio.md')).toBe(false);
    expect(files.allows('a2', '/tmp/print.png')).toBe(true);
  });

  it('allows: o caminho real também vale (a pasta do agente é um link, como /tmp no macOS)', (ctx) => {
    const tmp = tempDir();
    try {
      const real = join(tmp.dir, 'real');
      mkdirSync(join(real, 'docs'), { recursive: true });
      const link = join(tmp.dir, 'atalho');
      symlinkOrSkip(ctx.skip, real, link);
      const files = new AgentFiles({ transcriptPathOf: () => undefined, cwdOf: () => link });
      expect(files.allows('a1', join(link, 'docs', 'a.md'))).toBe(true);
      expect(files.allows('a1', join(realpathSync(real), 'docs', 'a.md'))).toBe(true);
      expect(files.allows('a1', join(tmp.dir, 'fora.md'))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it('allows: pasta raiz ou vazia não libera o disco inteiro', () => {
    for (const cwd of ['/', '//', '', '   ']) {
      const files = new AgentFiles({ transcriptPathOf: () => undefined, cwdOf: () => cwd });
      expect(files.allows('a1', '/Users/voce/Documents/contrato.pdf')).toBe(false);
    }
    // Uma raiz "/" configurada também não vale.
    expect(new AgentFiles({ transcriptPathOf: () => undefined, cwdOf: () => undefined, roots: ['/'] }).allows('a1', '/etc/x.md')).toBe(false);
  });

  it('list: não mostra o que o 403 recusaria ao abrir (fora da pasta do agente e das raízes)', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 't.jsonl');
      writeLines(file, [wrote('/p/loja/docs/relatorio.md', T0), wrote('/p/outro/segredo.md', T0 + 1), wrote('/tmp/print.png', T0 + 2)]);
      const files = new AgentFiles({ transcriptPathOf: () => file, cwdOf: () => '/p/loja', roots: ['/tmp'] });
      expect(files.list('a1')!.map((f) => f.name)).toEqual(['print.png', 'relatorio.md']);
    } finally {
      tmp.cleanup();
    }
  });
});
