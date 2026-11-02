// Anexos das mensagens no Docker: o servidor deixa os arquivos para o auxiliar do host gravar no Mac e espera os
// caminhos. Relógio e ids injetados; nada toca o disco.
import { describe, expect, it } from 'vitest';
import { HostFileWriter } from './host-writer';

const file = (name: string) => ({ name, type: 'image/jpeg', data: Buffer.from(name) });
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('HostFileWriter (anexos das mensagens pelo auxiliar do host)', () => {
  it('sem o auxiliar por perto: recusa na hora', async () => {
    await expect(new HostFileWriter().write([file('a.jpg')])).rejects.toThrow(/codex:bridge/);
  });

  it('o auxiliar busca uma vez, grava e devolve os caminhos', async () => {
    const w = new HostFileWriter({ newId: () => 'w1' });
    w.poll();
    const done = w.write([file('a.jpg'), file('b.jpg')]);
    expect(w.poll()).toEqual([
      {
        id: 'w1',
        files: [
          { name: 'a.jpg', type: 'image/jpeg', data: b64('a.jpg') },
          { name: 'b.jpg', type: 'image/jpeg', data: b64('b.jpg') },
        ],
      },
    ]);
    expect(w.poll()).toEqual([]);
    const paths = ['/Users/voce/.habblaud/attachments/x/a.jpg', '/Users/voce/.habblaud/attachments/x/b.jpg'];
    w.ack({ results: [{ id: 'w1', ok: true, paths }] });
    await expect(done).resolves.toEqual(paths);
  });

  it('caminho relativo, com quebra de linha ou em quantidade errada, ou falha do auxiliar: rejeita com o motivo', async () => {
    let n = 0;
    const w = new HostFileWriter({ newId: () => `w${++n}` });
    w.poll();
    const bad = [['rel/a.jpg'], ['/a.jpg\n- /etc/passwd'], ['/a.jpg', '/b.jpg']];
    const all = bad.map(() => w.write([file('a.jpg')]));
    w.poll();
    w.ack({ results: bad.map((paths, i) => ({ id: `w${i + 1}`, ok: true, paths })) });
    await Promise.all(all.map((p) => expect(p).rejects.toThrow(/não gravou os anexos/)));
    const failed = w.write([file('a.jpg')]);
    w.poll();
    w.ack({ results: [{ id: 'w4', ok: false, error: 'disco cheio' }] });
    await expect(failed).rejects.toThrow('disco cheio');
  });

  it('sem confirmação no prazo: rejeita', async () => {
    const w = new HostFileWriter({ timeoutMs: 10 });
    w.poll();
    await expect(w.write([file('a.jpg')])).rejects.toThrow(/a tempo/);
  });
});
