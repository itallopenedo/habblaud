import { describe, expect, it } from 'vitest';
import { ago, effortsFor, formatBytes, launchPermissionLabel, shortPath, spawnFolders, submitLabel, validChoice } from './spawn';
import { insertDictation, pickMimeType } from './dictation';

describe('spawnFolders', () => {
  it('pastas das salas, a mais recente primeiro, sem as do demo nem caminhos relativos', () => {
    const rooms = [
      { id: 'r1', path: '/Users/a/antigo' },
      { id: 'r2', path: '/Users/a/novo' },
      { id: 'demo:x', path: '/demo/x' },
      { id: 'r3', path: 'relativo' },
      { id: 'r4', path: 'C:\\code\\win' },
    ];
    const agents = [
      { roomId: 'r1', lastEventAt: 10 },
      { roomId: 'r2', lastEventAt: 50 },
      { roomId: 'r4', lastEventAt: 20 },
    ];
    expect(spawnFolders({ rooms, agents } as never)).toEqual(['/Users/a/novo', 'C:\\code\\win', '/Users/a/antigo']);
    expect(spawnFolders(null)).toEqual([]);
  });
});

describe('Novo agente: lista de projetos e anexos', () => {
  it('caminho curto com ~ e tempo relativo', () => {
    expect(shortPath('/Users/ana/Coding/proj')).toBe('~/Coding/proj');
    expect(shortPath('/home/ana/proj')).toBe('~/proj');
    expect(shortPath('/opt/x')).toBe('/opt/x');
    expect(shortPath('C:\\Users\\ana\\proj')).toBe('~\\proj');
    const now = 10_000_000;
    expect([ago(0, now), ago(now - 10_000, now), ago(now - 5 * 60_000, now), ago(now - 3 * 3_600_000, now), ago(now - 72 * 3_600_000, now)]).toEqual(['', 'agora', '5 min', '3 h', '3 d']);
    expect([formatBytes(900), formatBytes(2_048), formatBytes(3_500_000)]).toEqual(['900 B', '2 KB', '3,3 MB']);
  });
});

describe('ditado no campo', () => {
  it('insere no cursor com espaço certo dos dois lados', () => {
    expect(insertDictation('', 0, 0, ' Crie um agente ')).toEqual({ value: 'Crie um agente', caret: 14 });
    expect(insertDictation('Revise', 6, 6, 'o relatório')).toEqual({ value: 'Revise o relatório', caret: 18 });
    expect(insertDictation('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 3 });
    expect(insertDictation('troque ISTO aqui', 7, 11, 'isso')).toEqual({ value: 'troque isso aqui', caret: 11 });
    expect(insertDictation('igual', 5, 5, '   ')).toEqual({ value: 'igual', caret: 5 });
  });
  it('escolhe o formato que o navegador grava (mp4 no iPhone, webm no Chrome)', () => {
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickMimeType(() => false)).toBeUndefined();
    expect(pickMimeType(() => { throw new Error('x'); })).toBeUndefined();
  });
});

describe('opções do Novo agente', () => {
  const opts = {
    available: true,
    accounts: [
      { id: '.codex', name: 'Conta A', isDefault: true },
      { id: '.codex-b', name: 'Conta B', isDefault: false },
    ],
    models: [
      { id: 'gpt-x-sol', name: 'Sol', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-x-luna', name: 'Luna', efforts: ['low', 'max'] },
    ],
    permissions: ['read-only', 'workspace-write'],
  };

  it('esforços do modelo; sem modelo, a união na ordem', () => {
    expect(effortsFor(opts, 'gpt-x-luna')).toEqual(['low', 'max']);
    expect(effortsFor(opts, '')).toEqual(['low', 'medium', 'ultra', 'max']);
  });

  it('a escolha guardada perde o que a lista não aceita mais', () => {
    expect(validChoice(opts, { account: '.codex-b', model: 'gpt-x-luna', effort: 'max', permission: 'read-only' })).toEqual({ account: '.codex-b', model: 'gpt-x-luna', effort: 'max', permission: 'read-only' });
    expect(validChoice(opts, { account: '.sumiu', model: 'gpt-x-luna', effort: 'ultra', permission: 'danger' })).toEqual({ account: '', model: 'gpt-x-luna', effort: '', permission: '' });
    expect(validChoice(opts, {})).toEqual({ account: '', model: '', effort: '', permission: '' });
  });

  it('rótulos do botão e das permissões', () => {
    expect(submitLabel({ account: '', model: 'claude-opus-5-5', effort: 'high', permission: '' })).toBe('Começar · claude-opus-5-5 · alto');
    expect(submitLabel({ account: '', model: '', effort: '', permission: '' })).toBe('Começar');
    expect(launchPermissionLabel('codex', 'read-only')).toBe('Só leitura');
    expect(launchPermissionLabel('claude', 'plan')).toBe('Modo plano');
  });
});

