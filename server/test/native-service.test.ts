import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLaunchctlPrint, plistFile, reloadCommand, renderPlist, SERVICE_LABEL, serviceLang, servicePath, waitForRestart } from '../../scripts/native-service';
import { tempDir } from './fixtures';

const spec = { root: '/Users/ana/habblaud', home: '/Users/ana', node: '/Users/ana/.local/share/fnm/node-versions/v24.21.0/installation/bin/node' };

describe('serviço nativo (LaunchAgent)', () => {
  it('plist: Node absoluto, .env lido pelo próprio Node, HABBLAUD_PTY=1, KeepAlive e logs em ~/.habblaud/logs', () => {
    const p = renderPlist(spec);
    expect(p).toContain(`<key>Label</key><string>${SERVICE_LABEL}</string>`);
    expect(p).toContain(
      `<array><string>${spec.node}</string><string>--env-file-if-exists=/Users/ana/habblaud/.env</string><string>/Users/ana/habblaud/dist/server/index.js</string></array>`,
    );
    expect(p).toContain('<key>WorkingDirectory</key><string>/Users/ana/habblaud</string>');
    expect(p).toContain('<key>HABBLAUD_PTY</key><string>1</string>');
    expect(p).toContain('<key>HOME</key><string>/Users/ana</string>');
    // Sem isto o launchd sobe no locale C e o terminal interativo perde acentos e emojis.
    expect(p).toContain('<key>LANG</key><string>en_US.UTF-8</string>');
    expect(p).toContain('<key>LC_CTYPE</key><string>en_US.UTF-8</string>');
    expect(p).toContain('<key>RunAtLoad</key><true/>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('<string>/Users/ana/.habblaud/logs/habblaud.log</string>');
    expect(p).toContain('<string>/Users/ana/.habblaud/logs/habblaud.error.log</string>');
    // Segredos e opções ficam no .env, nunca no plist.
    expect(p).not.toMatch(/PASSWORD|REMOTE_USER|TAILNET/);
  });

  it('idioma do serviço: o LANG de quem instalou quando termina em .UTF-8 e o locale existe, senão en_US.UTF-8', () => {
    const exists = (l: string) => ['pt_BR.UTF-8', 'fr_FR.UTF-8', 'en_US.UTF-8'].includes(l);
    expect(serviceLang('pt_BR.UTF-8', exists)).toBe('pt_BR.UTF-8');
    expect(serviceLang('fr_FR.UTF-8', exists)).toBe('fr_FR.UTF-8');
    // en_BR.UTF-8 tem cara de locale mas não existe: o launchd voltaria ao locale C.
    for (const bad of [undefined, '', 'C', 'POSIX', 'pt_BR.ISO8859-1', 'pt_BR.UTF-8; rm -rf /', '<x>.UTF-8', 'en_BR.UTF-8', '../etc.UTF-8']) expect(serviceLang(bad, exists)).toBe('en_US.UTF-8');
    const p = renderPlist({ ...spec, lang: 'pt_BR.UTF-8' }, exists);
    expect(p).toContain('<key>LANG</key><string>pt_BR.UTF-8</string>');
    expect(p).toContain('<key>LC_CTYPE</key><string>pt_BR.UTF-8</string>');
    expect(renderPlist({ ...spec, lang: 'C' }, exists)).toContain('<key>LANG</key><string>en_US.UTF-8</string>');
    expect(renderPlist({ ...spec, lang: 'en_BR.UTF-8' }, exists)).toContain('<key>LANG</key><string>en_US.UTF-8</string>');
  });

  it('PATH: a pasta do Node primeiro, depois ~/.local/bin (claude, codex) e o Homebrew (whisper-cli, ffmpeg)', () => {
    expect(servicePath(spec).split(':')).toEqual([
      '/Users/ana/.local/share/fnm/node-versions/v24.21.0/installation/bin',
      '/Users/ana/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]);
  });

  it('escapa XML nos caminhos', () => {
    expect(renderPlist({ ...spec, root: '/Users/ana/a&b<c>' })).toContain('/Users/ana/a&amp;b&lt;c&gt;/dist/server/index.js');
  });

  it('plist em ~/Library/LaunchAgents', () => {
    expect(plistFile('/Users/ana')).toBe(`/Users/ana/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
  });

  describe('reinstalação num processo à parte (sobrevive ao servidor cair e ao terminal fechar)', () => {
    /** launchctl de mentira: registra as chamadas; `print` acha o serviço `printOk` vezes; `bootstrap` falha `bootFail` vezes. */
    function fakeLaunchctl(printOk: number, bootFail: number) {
      const tmp = tempDir();
      const log = join(tmp.dir, 'calls.log');
      const bin = join(tmp.dir, 'launchctl');
      writeFileSync(
        bin,
        `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  print) n=$(grep -c '^print' '${log}'); [ "$n" -le ${printOk} ] && exit 0; exit 113 ;;
  bootstrap) n=$(grep -c '^bootstrap' '${log}'); [ "$n" -le ${bootFail} ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }; exit 0 ;;
esac
exit 0
`,
      );
      chmodSync(bin, 0o755);
      // sleep de mentira (a pasta do launchctl vem primeiro no PATH): as esperas de 1 s não atrasam o teste.
      writeFileSync(join(tmp.dir, 'sleep'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(tmp.dir, 'sleep'), 0o755);
      const run = (tries: number) => {
        const [cmd, args] = reloadCommand('gui/501', '/p/x y.plist', join(tmp.dir, 'err.log'), tries);
        const r = spawnSync(cmd, args, { env: { PATH: `${tmp.dir}:/usr/bin:/bin` }, encoding: 'utf8' });
        return { status: r.status, calls: readFileSync(log, 'utf8').trim().split('\n'), err: readFileSync(join(tmp.dir, 'err.log'), 'utf8') };
      };
      return { run, cleanup: tmp.cleanup };
    }

    it('bootout, espera o serviço sumir e só então bootstrap (tenta de novo no "Input/output error")', () => {
      const f = fakeLaunchctl(2, 1);
      const r = f.run(20);
      f.cleanup();
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([
        `bootout gui/501/${SERVICE_LABEL}`,
        `print gui/501/${SERVICE_LABEL}`,
        `print gui/501/${SERVICE_LABEL}`,
        `print gui/501/${SERVICE_LABEL}`,
        'bootstrap gui/501 /p/x y.plist',
        'bootstrap gui/501 /p/x y.plist',
      ]);
      expect(r.err).toMatch(/Input\/output error/);
      // Subiu: nenhum aviso de falha no log.
      expect(r.err).not.toMatch(/native:install/);
    });

    it('a espera tem limite: com o serviço que não some, tenta o bootstrap mesmo assim; falhando sempre, sai com erro', () => {
      const f = fakeLaunchctl(1_000, 1_000);
      const r = f.run(2);
      f.cleanup();
      expect(r.status).not.toBe(0);
      expect(r.calls.filter((c) => c.startsWith('print'))).toHaveLength(2);
      // 10 tentativas de bootstrap (1 s entre elas) e, esgotadas, uma linha com data no log de erro.
      expect(r.calls.filter((c) => c.startsWith('bootstrap'))).toHaveLength(10);
      const last = r.err.trim().split('\n').pop();
      expect(last).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\S* native:install: não deu para religar o serviço; rode npm run native:install de novo$/);
    });

    it('a linha de aviso sai inteira mesmo com barras e % no texto (printf, não echo)', () => {
      const [cmd, args] = reloadCommand('gui/501', '/p/x.plist', '/dev/null');
      expect(cmd).toBe('/bin/sh');
      expect(args[1]).toContain("printf '%s %s\\n'");
      expect(args[1]).not.toMatch(/\becho\b/);
    });

    it('o bootstrap que dá certo na última tentativa (a 10ª) ainda vale', () => {
      const f = fakeLaunchctl(0, 9);
      const r = f.run(2);
      f.cleanup();
      expect(r.status).toBe(0);
      expect(r.calls.filter((c) => c.startsWith('bootstrap'))).toHaveLength(10);
      expect(r.err).not.toMatch(/native:install/);
    });

    it('só aceita o servidor que subiu depois da reinstalação (outro processo na porta não conta)', async () => {
      const sleeps: number[] = [];
      const sleep = async (ms: number) => void sleeps.push(ms);
      let answers: Array<number | undefined> = [undefined, 900, 900];
      expect(await waitForRestart({ startedAt: async () => answers.shift(), sleep }, 1_000, 3)).toBe(false);
      expect(sleeps).toEqual([1_000, 1_000, 1_000]);
      answers = [900, undefined, 1_000];
      expect(await waitForRestart({ startedAt: async () => answers.shift(), sleep }, 1_000, 5)).toBe(true);
    });
  });

  it('launchctl print: rodando com pid, ou parado', () => {
    expect(parseLaunchctlPrint(`gui/501/${SERVICE_LABEL} = {\n\tstate = running\n\tpid = 4242\n}`)).toEqual({ running: true, pid: 4242 });
    expect(parseLaunchctlPrint('\tstate = not running\n')).toEqual({ running: false });
    expect(parseLaunchctlPrint('')).toEqual({ running: false });
  });
});
