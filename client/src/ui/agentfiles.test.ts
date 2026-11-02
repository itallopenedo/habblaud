import { describe, expect, it } from 'vitest';
import { agentFilesUrl, parseAgentFiles } from './agentfiles';

describe('seção Arquivos (peças puras)', () => {
  it('endereços da lista e do arquivo', () => {
    expect(agentFilesUrl('acc:1')).toBe('/api/agents/acc%3A1/files');
    expect(agentFilesUrl('acc:1', 'abc')).toBe('/api/agents/acc%3A1/files/abc');
  });

  it('parseAgentFiles: só itens válidos', () => {
    const ok = { id: 'a', name: 'r.md', path: 'docs/r.md', kind: 'text', at: 1 };
    expect(parseAgentFiles({ files: [ok, { id: 1 }, null, { ...ok, at: 'x' }] })).toEqual([ok]);
    expect(parseAgentFiles(null)).toEqual([]);
    expect(parseAgentFiles({ files: 'x' })).toEqual([]);
  });
});
