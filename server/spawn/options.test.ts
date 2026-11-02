// Opções do Novo agente: catálogo do Codex, conferência das escolhas e argumentos do Codex. Dados sintéticos.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_RETRY_MS, CLAUDE_MODELS, codexArgs, createCodexCatalog, parseChoice, parseCodexModels } from './options';

const catalog = {
  models: [
    { slug: 'gpt-x-sol', display_name: 'GPT-X Sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
    { slug: 'gpt-x-luna', display_name: '', visibility: 'list', default_reasoning_level: 'nada', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'escondido', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'com espaço', visibility: 'list' },
    'lixo',
  ],
};

describe('catálogo do Codex', () => {
  it('só os modelos listados, com os níveis de cada um e o padrão válido', () => {
    expect(parseCodexModels(catalog)).toEqual([
      { id: 'gpt-x-sol', name: 'GPT-X Sol', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-x-luna', name: 'gpt-x-luna', efforts: ['low', 'max'] },
    ]);
    expect(parseCodexModels(null)).toEqual([]);
    expect(parseCodexModels({ models: 'x' })).toEqual([]);
  });
});

describe('escolhas', () => {
  const codex = parseCodexModels(catalog);

  it('Codex: o esforço precisa valer para o modelo; sem modelo, para algum modelo', () => {
    expect(parseChoice('codex', { model: 'gpt-x-sol', effort: 'ultra', permission: 'read-only' }, codex)).toEqual({ model: 'gpt-x-sol', effort: 'ultra', permission: 'read-only' });
    expect(parseChoice('codex', { model: 'gpt-x-luna', effort: 'ultra' }, codex)).toHaveProperty('error');
    expect(parseChoice('codex', { effort: 'max' }, codex)).toEqual({ effort: 'max' });
    expect(parseChoice('codex', { model: 'escondido' }, codex)).toHaveProperty('error');
    expect(parseChoice('codex', { permission: 'danger-full-access' }, codex)).toHaveProperty('error');
    expect(parseChoice('codex', { permission: 'plan' }, codex)).toHaveProperty('error');
    expect(parseChoice('codex', {}, [])).toEqual({});
  });

  it('Claude: nomes completos e os modos sem bypassPermissions', () => {
    expect(parseChoice('claude', { model: 'claude-fable-5-1', effort: 'xhigh', permission: 'dontAsk' }, CLAUDE_MODELS)).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh', permission: 'dontAsk' });
    expect(parseChoice('claude', { model: 'opus' }, CLAUDE_MODELS)).toHaveProperty('error');
    expect(parseChoice('claude', { permission: 'bypassPermissions' }, CLAUDE_MODELS)).toHaveProperty('error');
    expect(parseChoice('claude', { effort: ['high'] }, CLAUDE_MODELS)).toHaveProperty('error');
  });
});

describe('argumentos do Codex', () => {
  it('pasta, modelo, esforço (-c com chave fixa), permissão e o pedido depois de `--`', () => {
    expect(codexArgs('/p', { model: 'gpt-x-sol', effort: 'low', permission: 'workspace-auto' }, '--help')).toEqual([
      '-C',
      '/p',
      '-m',
      'gpt-x-sol',
      '-c',
      'model_reasoning_effort="low"',
      '-s',
      'workspace-write',
      '-a',
      'never',
      '--',
      '--help',
    ]);
    expect(codexArgs('/p', {}, '  ')).toEqual(['-C', '/p']);
  });
});

describe('catálogo do Codex: cache', () => {
  it('lê com o CODEX_HOME da conta, guarda e, se falhar, só tenta de novo depois de um tempo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-catalog-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\necho "$CODEX_HOME $*" >> "${dir}/calls"\n[ -f "${dir}/ok" ] && echo '${JSON.stringify(catalog)}' || echo 'quebrado'\n`);
    chmodSync(bin, 0o755);
    let now = 0;
    const get = createCodexCatalog(bin, { now: () => now });
    expect(await get('/h/.codex')).toEqual([]);
    writeFileSync(join(dir, 'ok'), '');
    expect(await get('/h/.codex')).toEqual([]); // falhou há pouco: não roda de novo
    now += CATALOG_RETRY_MS + 1;
    expect((await get('/h/.codex')).map((m) => m.id)).toEqual(['gpt-x-sol', 'gpt-x-luna']);
    now += CATALOG_RETRY_MS + 1;
    await get('/h/.codex');
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toEqual(['/h/.codex debug models', '/h/.codex debug models']);
  });
});

