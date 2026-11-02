import { describe, expect, it } from 'vitest';
import { parseLaunchctlPrint, plistFile, renderPlist, SERVICE_LABEL, servicePath } from '../../scripts/native-service';

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

  it('launchctl print: rodando com pid, ou parado', () => {
    expect(parseLaunchctlPrint(`gui/501/${SERVICE_LABEL} = {\n\tstate = running\n\tpid = 4242\n}`)).toEqual({ running: true, pid: 4242 });
    expect(parseLaunchctlPrint('\tstate = not running\n')).toEqual({ running: false });
    expect(parseLaunchctlPrint('')).toEqual({ running: false });
  });
});
