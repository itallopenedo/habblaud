import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLaunchctlPrint, plistFile, reloadCommand, renderPlist, SERVICE_LABEL, servicePath, waitForRestart } from '../../scripts/native-service';
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
    });

    it('a espera tem limite: com o serviço que não some, tenta o bootstrap mesmo assim; falhando sempre, sai com erro', () => {
      const f = fakeLaunchctl(1_000, 1_000);
      const r = f.run(2);
      f.cleanup();
      expect(r.status).not.toBe(0);
      expect(r.calls.filter((c) => c.startsWith('print'))).toHaveLength(2);
      expect(r.calls.filter((c) => c.startsWith('bootstrap'))).toHaveLength(3);
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
