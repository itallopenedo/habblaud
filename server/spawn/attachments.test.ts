import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { symlinkOrSkip, tempDir } from '../test/fixtures';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_SPAWN, AttachmentStore, parseAttachment, promptWithAttachments, safeFileName, writeAttachments, writeMessageAttachments } from './attachments';
import { ATTACHMENT_KEEP_MS, cleanOldAttachments } from './attachments';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('anexos do Novo agente', () => {
  it('nome seguro: sem caminho, controles nem ponto no começo', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\x\\foto 1.jpg')).toBe('foto 1.jpg');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('a\u0000b:c?.png')).toBe('a_b_c_.png');
    expect(safeFileName('')).toBe('arquivo');
    const long = safeFileName(`${'x'.repeat(300)}.jpeg`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.jpeg')).toBe(true);
  });

  it('parseAttachment: base64 válido, não vazio e no limite', () => {
    expect(parseAttachment({ name: 'a.png', type: 'image/png', data: b64('oi') })).toMatchObject({ name: 'a.png', type: 'image/png' });
    expect(parseAttachment({ name: 'a', type: 'bad type', data: b64('oi') })).toMatchObject({ type: 'application/octet-stream' });
    expect(parseAttachment({ name: 'a', data: '' })).toHaveProperty('error');
    expect(parseAttachment({ name: 'a', data: 'não é base64!' })).toHaveProperty('error');
    expect(parseAttachment({ name: 'a', data: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString('base64') })).toHaveProperty('error');
  });

  it('o depósito entrega cada anexo uma vez, expira e limita a quantidade', () => {
    let now = 0;
    let n = 0;
    const store = new AttachmentStore(() => now, () => `id${++n}`);
    const a = store.put({ name: 'a.txt', type: 'text/plain', data: Buffer.from('a') });
    const b = store.put({ name: 'b.txt', type: 'text/plain', data: Buffer.from('b') });
    expect(a).toEqual({ id: 'id1' });
    expect(store.take(['id1', 'id2'])).toHaveLength(2);
    expect(store.take(['id1'])).toHaveProperty('error');
    expect(b).toEqual({ id: 'id2' });
    store.put({ name: 'c', type: 't/t', data: Buffer.from('c') });
    now += 31 * 60_000;
    expect(store.take(['id3'])).toHaveProperty('error');
    expect(store.take(undefined)).toEqual([]);
    expect(store.take('id1')).toHaveProperty('error');
    expect(store.take(Array.from({ length: ATTACHMENTS_PER_SPAWN + 1 }, (_, i) => `x${i}`))).toHaveProperty('error');
  });

  it('grava numa pasta nova (700, arquivos 600) com nomes únicos', () => {
    const root = tempDir().dir;
    const files = [
      { name: 'foto.jpg', type: 'image/jpeg', data: Buffer.from('1') },
      { name: 'foto.jpg', type: 'image/jpeg', data: Buffer.from('2') },
      { name: '../nota.txt', type: 'text/plain', data: Buffer.from('3') },
    ];
    const paths = writeAttachments(root, 'abcdef12-3456', files, new Date(2026, 9, 12, 13, 5, 9));
    expect(paths.map((p) => p.split('/').slice(-2).join('/'))).toEqual(['20261012-130509-abcdef12/foto.jpg', '20261012-130509-abcdef12/foto-2.jpg', '20261012-130509-abcdef12/nota.txt']);
    const dir = join(root, '20261012-130509-abcdef12');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths[0]).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths[1], 'utf8')).toBe('2');
    expect(readdirSync(dir)).toHaveLength(3);
    expect(writeAttachments(root, 'x', [])).toEqual([]);
  });

  it('anexos de mensagens: duas fotos image.jpg no mesmo segundo vão para pastas diferentes', () => {
    const root = tempDir().dir;
    const photo = [{ name: 'image.jpg', type: 'image/jpeg', data: Buffer.from('x') }];
    const [a] = writeMessageAttachments(root, photo);
    const [b] = writeMessageAttachments(root, photo);
    expect(a).not.toBe(b);
    expect(readdirSync(root)).toHaveLength(2);
  });

  it('o pedido ganha a lista dos caminhos', () => {
    expect(promptWithAttachments('Corrija o layout', ['/h/.habblaud/attachments/x/print.png'])).toBe(
      'Corrija o layout\n\nAnexo enviado pelo Habblaud (leia antes de começar):\n- /h/.habblaud/attachments/x/print.png',
    );
    expect(promptWithAttachments('', ['/a', '/b'])).toBe('Anexos enviados pelo Habblaud (leia antes de começar):\n- /a\n- /b');
    expect(promptWithAttachments('só texto', [])).toBe('só texto');
  });

  it('teto de memória: conta também os anexos já tirados por pedidos na fila, até serem soltos', () => {
    let n = 0;
    const store = new AttachmentStore(Date.now, () => `a${++n}`, 10);
    const file = (size: number) => ({ name: 'x.png', type: 'image/png', data: Buffer.alloc(size, 1) });
    expect(store.put(file(6))).toEqual({ id: 'a1' });
    const taken = store.take(['a1']);
    expect(Array.isArray(taken) && taken.length).toBe(1);
    // Os 6 bytes saíram do depósito, mas seguem na memória (pedido na fila): 6 + 6 passa do teto.
    expect(store.put(file(6))).toHaveProperty('error');
    store.release(6);
    expect(store.put(file(6))).toEqual({ id: 'a2' });
  });
});

describe('limpeza dos anexos antigos', () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = Date.UTC(2026, 10, 1);
  /** Pasta falsa: nome, idade em dias e se é diretório comum (links e arquivos soltos não são). */
  const entry = (name: string, days: number, dir = true) => ({ name, days, dir });
  const run = (entries: ReturnType<typeof entry>[]) => {
    const removed: string[] = [];
    const n = cleanOldAttachments('/h/attachments', {
      now: NOW,
      fs: {
        readdir: () => entries.map((e) => ({ name: e.name, isDirectory: () => e.dir })),
        mtimeMs: (p) => NOW - entries.find((e) => p.endsWith(`/${e.name}`))!.days * DAY,
        rm: (p) => void removed.push(p),
      },
    });
    return { n, removed };
  };

  it(`apaga só as pastas do formato do Habblaud com mais de ${ATTACHMENT_KEEP_MS / DAY} dias`, () => {
    const { n, removed } = run([
      entry('20261001-101500-ab12cd34', 30),
      entry('20261020-101500-pedido', 8),
      entry('20261029-101500-ab12cd34', 3),
      entry('20261001-101500-ab12cd34x9', 30),
      entry('minhas-fotos', 90),
      entry('20260101-000000-ab12cd34', 90, false),
    ]);
    expect(removed).toEqual(['/h/attachments/20261001-101500-ab12cd34', '/h/attachments/20261020-101500-pedido']);
    expect(n).toBe(2);
  });

  it('um erro numa pasta não impede as outras; conta só as apagadas', () => {
    const removed: string[] = [];
    const n = cleanOldAttachments('/h/a', {
      now: NOW,
      fs: {
        readdir: () => ['20260101-000000-aaaa', '20260101-000000-bbbb'].map((name) => ({ name, isDirectory: () => true })),
        mtimeMs: () => 0,
        rm: (p) => {
          if (p.endsWith('aaaa')) throw new Error('EACCES');
          removed.push(p);
        },
      },
    });
    expect([n, removed]).toEqual([1, ['/h/a/20260101-000000-bbbb']]);
  });

  it('pasta de anexos inexistente: 0, sem erro', () => {
    expect(cleanOldAttachments(join(tempDir().dir, 'nao-existe'))).toBe(0);
  });

  it('no disco: apaga a pasta velha com o conteúdo e deixa o link e a recente', (ctx) => {
    const tmp = tempDir();
    try {
      const old = join(tmp.dir, '20260101-000000-ab12cd34');
      writeAttachments(tmp.dir, 'ab12cd34', [{ name: 'a.png', type: 'image/png', data: Buffer.from('x') }], new Date(2026, 0, 1));
      const fresh = join(tmp.dir, '20261101-000000-ee');
      mkdirSync(fresh);
      const alvo = join(tmp.dir, 'fora');
      mkdirSync(alvo);
      writeFileSync(join(alvo, 'precioso.txt'), 'x');
      symlinkOrSkip(ctx.skip, alvo, join(tmp.dir, '20250101-000000-link'));
      utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
      utimesSync(join(tmp.dir, '20250101-000000-link'), new Date(2025, 0, 1), new Date(2025, 0, 1));
      expect(cleanOldAttachments(tmp.dir, { now: Date.now() })).toBe(1);
      expect(readdirSync(tmp.dir).sort()).toEqual(['20250101-000000-link', '20261101-000000-ee', 'fora']);
      expect(readdirSync(alvo)).toEqual(['precioso.txt']);
    } finally {
      tmp.cleanup();
    }
  });
});
