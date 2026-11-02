// Aba Arquivos: o que o agente escreveu ou editou na sessão, lido do transcript (linhas sintéticas).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { L, tempDir, writeLines } from '../test/fixtures';
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
      const files = new AgentFiles({ transcriptPathOf: (id) => (id === 'a1' ? file : undefined), cwdOf: () => '/p/loja' });
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
});
