// Opções do Novo agente: catálogo do Codex, conferência das escolhas e argumentos do Codex. Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, codexArgs, parseChoice, parseCodexModels } from './options';

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
