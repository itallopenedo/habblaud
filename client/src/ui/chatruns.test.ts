import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { chatRuns, runLabel } from './chatruns';
import { TerminalLog } from './terminal';

const user = (id: string): TerminalEntry => ({ kind: 'user', id, at: 1, text: 'oi' });
const said = (id: string): TerminalEntry => ({ kind: 'assistant', id, at: 1, text: 'feito' });
const think = (id: string): TerminalEntry => ({ kind: 'thinking', id, at: 1 });
const sys = (id: string): TerminalEntry => ({ kind: 'system', id, at: 1, text: 'compactou' });
const tool = (id: string, title = 'Bash(npm test)'): TerminalEntry => ({ kind: 'tool', id, at: 2, tool: 'Bash', title });
const result = (id: string, toolUseId: string): TerminalEntry => ({ kind: 'result', id, at: 3, toolUseId, text: 'ok' });

function runs(entries: TerminalEntry[]) {
  const log = new TerminalLog();
  log.push(entries);
  return chatRuns(log.values());
}

describe('chatRuns', () => {
  it('agrupa ferramentas e raciocínio entre duas mensagens', () => {
    const r = runs([user('u'), think('t'), tool('a'), result('ra', 'a'), tool('b'), result('rb', 'b'), said('s')]);
    expect(r).toEqual([{ key: 'thinking:t', keys: ['thinking:t', 'tool:a', 'tool:b'], tools: 2 }]);
  });

  it('prompt, resposta e aviso do sistema separam os grupos', () => {
    const r = runs([tool('a'), result('ra', 'a'), said('s1'), tool('b'), result('rb', 'b'), sys('x'), tool('c'), result('rc', 'c')]);
    expect(r.map((g) => g.keys)).toEqual([['tool:a'], ['tool:b'], ['tool:c']]);
  });

  it('só o grupo do fim mostra a ferramenta rodando', () => {
    const r = runs([tool('a', 'Read(x.ts)'), said('s'), tool('b', 'Edit(y.ts)'), result('rb', 'b'), tool('c', 'Bash(npm test)')]);
    expect(r[0].running).toBeUndefined();
    expect(r[1].running).toBe('Bash');
  });

  it('resultado órfão conta como ferramenta', () => {
    expect(runs([result('r', 'sumiu')])[0].tools).toBe(1);
  });

  it('rótulos', () => {
    expect(runLabel({ tools: 0 })).toBe('Pensou');
    expect(runLabel({ tools: 1 })).toBe('Usou 1 ferramenta');
    expect(runLabel({ tools: 5 })).toBe('Usou 5 ferramentas');
    expect(runLabel({ tools: 2, running: 'Bash' })).toBe('Usando Bash…');
  });
});
