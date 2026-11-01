import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOf, FableUsageReader, parseFableRecords } from './fable';

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(2026, 9, 30, 12).toISOString(),
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-fable-5-1',
      usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
    },
    ...over,
  });

describe('uso do Fable', () => {
  it('ignora outros modelos e linhas quebradas', () => {
    const other = line({ message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 5 } } });
    const text = [line(), other, '{quebrado', ''].join('\n');
    expect(parseFableRecords(text)).toHaveLength(1);
  });

  it('soma hoje e 7 dias sem contar a mesma resposta duas vezes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fable-'));
    const proj = join(dir, 'projects', 'p1');
    mkdirSync(proj, { recursive: true });
    const now = new Date(2026, 9, 30, 15).getTime();
    const old = new Date(2026, 9, 1, 12).toISOString();
    writeFileSync(join(proj, 's.jsonl'), [line(), line(), line({ timestamp: old, requestId: 'req_old', message: { id: 'x', model: 'claude-fable-5-1', usage: { input_tokens: 999 } } })].join('\n'));
    const r = new FableUsageReader().read(join(dir, 'projects'), now);
    expect(r?.today.output).toBe(10);
    expect(r?.week.input).toBe(2);
    expect(r?.week.cacheRead).toBe(1000);
    expect(dayOf(now)).toBe('2026-10-30');
  });
});
