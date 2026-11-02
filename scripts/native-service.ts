// npm run native:install | native:uninstall | native:status — o Habblaud como serviço do macOS (LaunchAgent), no lugar
// do Docker: `node --env-file-if-exists=<projeto>/.env dist/server/index.js`, com KeepAlive, o Node absoluto de quem
// instalou (o caminho real, não o atalho temporário do fnm), HABBLAUD_PTY=1 (terminal interativo) e logs em
// ~/.habblaud/logs/. O .env é lido pelo próprio Node a cada início: senha e opções não vão para o plist. Atualizar =
// rodar native:install de novo (faz o build e reinicia). A troca (bootout, esperar sumir, bootstrap) roda num processo
// à parte (reloadCommand), que sobrevive ao servidor cair e ao terminal do próprio Habblaud fechar. O Docker continua
// funcionando (npm run docker:up); só não rode os dois ao mesmo tempo (a porta é a mesma).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvValue } from '../server/remote/envfile';
import { ensureServerCert, remoteTargets, remoteTlsBase, tlsPaths } from '../server/remote/tls';
import { tr } from '../shared/i18n';

export const SERVICE_LABEL = 'com.pnd.habblaud';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || homedir();
const WAIT_S = 40;
const BOOTSTRAP_TRIES = 10;

export interface ServiceSpec {
  /** Pasta do projeto (package.json, .env e dist/). */
  root: string;
  home: string;
  /** Node absoluto (caminho real). */
  node: string;
  /** O LANG de quem instala (ver serviceLang). */
  lang?: string;
}

/** Idioma do serviço: o LANG de quem instalou, se for algo como pt_BR.UTF-8 (o launchd começa no locale C); senão en_US.UTF-8. */
export function serviceLang(lang: string | undefined): string {
  return lang && /^[A-Za-z]{2,3}(_[A-Za-z0-9]+)?\.UTF-8$/.test(lang) ? lang : 'en_US.UTF-8';
}

/** PATH do serviço: o launchd começa quase vazio; o Node dele e onde ficam claude, codex, whisper-cli e ffmpeg. */
export function servicePath(spec: Pick<ServiceSpec, 'home' | 'node'>): string {
  return [dirname(spec.node), join(spec.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

export function logFiles(home: string): { out: string; err: string } {
  const dir = join(home, '.habblaud', 'logs');
  return { out: join(dir, 'habblaud.log'), err: join(dir, 'habblaud.error.log') };
}

export function plistFile(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPlist(spec: ServiceSpec): string {
  const logs = logFiles(spec.home);
  const args = [spec.node, `--env-file-if-exists=${join(spec.root, '.env')}`, join(spec.root, 'dist', 'server', 'index.js')];
  const env: Array<[string, string]> = [
    ['PATH', servicePath(spec)],
    ['HOME', spec.home],
    ['HABBLAUD_PTY', '1'],
    // O launchd começa no locale C: sem isto o terminal interativo perde acentos e emojis.
    ['LANG', serviceLang(spec.lang)],
    ['LC_CTYPE', serviceLang(spec.lang)],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>WorkingDirectory</key><string>${xml(spec.root)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${env.map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs.out)}</string>
  <key>StandardErrorPath</key><string>${xml(logs.err)}</string>
</dict>
</plist>
`;
}

/** Estado no `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(text: string): { running: boolean; pid?: number } {
  const state = /^\s*state = (\S+)/m.exec(text)?.[1];
  const pid = Number(/^\s*pid = (\d+)/m.exec(text)?.[1]);
  return { running: state === 'running', ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
}

/**
 * Troca o serviço num shell à parte: bootout, espera o `launchctl print` falhar (até `tries` × 0,5 s) e bootstrap, com
 * até 10 tentativas, 1 s entre elas (logo depois do bootout ele às vezes dá "Bootstrap failed: 5: Input/output error").
 * Os erros do bootstrap vão para `errLog`; se todas as tentativas falham, uma linha com a data diz o que fazer (o
 * instalador pode já ter saído: é o único aviso que sobra). Argumentos posicionais: nenhum caminho passa pela
 * interpretação do shell.
 */
export function reloadCommand(domain: string, plist: string, errLog: string, tries = 20): [string, string[]] {
  const script = [
    `launchctl bootout "$1/${SERVICE_LABEL}" >/dev/null 2>&1`,
    'i=0',
    `while [ "$i" -lt "$4" ] && launchctl print "$1/${SERVICE_LABEL}" >/dev/null 2>&1; do i=$((i+1)); sleep 0.5; done`,
    'n=0',
    `until launchctl bootstrap "$1" "$2" >/dev/null 2>>"$3"; do n=$((n+1)); if [ "$n" -ge ${BOOTSTRAP_TRIES} ]; then echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $5" >> "$3"; exit 1; fi; sleep 1; done`,
  ].join('\n');
  const failed = tr('native:install: não deu para religar o serviço; rode npm run native:install de novo');
  return ['/bin/sh', ['-c', script, 'habblaud-reload', domain, plist, errLog, String(tries), failed]];
}

/**
 * Espera o Habblaud que subiu depois de `since` (o `meta.startedAt` de quem responde na porta): o servidor antigo, ainda
 * de pé, ou outro processo na mesma porta não contam como sucesso.
 */
export async function waitForRestart(
  deps: { startedAt: () => Promise<number | undefined>; sleep: (ms: number) => Promise<void> },
  since: number,
  waitS: number,
): Promise<boolean> {
  for (let i = 0; i < waitS; i++) {
    const at = await deps.startedAt();
    if (at !== undefined && at >= since) return true;
    await deps.sleep(1_000);
  }
  return false;
}

async function startedAtOn(port: number): Promise<number | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(2_000) });
    const at = r.ok ? ((await r.json()) as { meta?: { startedAt?: unknown } }).meta?.startedAt : undefined;
    return typeof at === 'number' ? at : undefined;
  } catch {
    return undefined;
  }
}

interface Health {
  version?: string;
  docker?: boolean;
  pty?: boolean;
}

async function health(port: number): Promise<Health | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return r.ok ? ((await r.json()) as Health) : undefined;
  } catch {
    return undefined;
  }
}

function envText(): string {
  try {
    return readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return '';
  }
}

function portOf(env: string): number {
  const raw = Number.parseInt(process.env.HABBLAUD_PORT ?? readEnvValue(env, 'HABBLAUD_PORT') ?? '', 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 4747;
}

const target = () => `gui/${process.getuid?.() ?? userInfo().uid}`;
const launchctl = (...args: string[]) => spawnSync('launchctl', args, { encoding: 'utf8' });

/** Como no docker:up: com o acesso remoto ligado, refaz o certificado do servidor se o IP mudou ou se está perto de vencer. */
function renewRemoteCert(env: string): void {
  if (!readEnvValue(env, 'HABBLAUD_REMOTE_USER')) return;
  const paths = tlsPaths(remoteTlsBase(HOME));
  if (!existsSync(paths.caCert)) return;
  try {
    const r = ensureServerCert(paths, remoteTargets({ name: readEnvValue(env, 'HABBLAUD_REMOTE_NAME'), domain: readEnvValue(env, 'HABBLAUD_REMOTE_DOMAIN') }));
    if (r.issued) console.log(tr('Acesso remoto: certificado do servidor renovado ({0}).', [r.reason]));
  } catch (err) {
    console.warn(tr('acesso remoto: não consegui conferir o certificado ({0}).', [(err as Error).message]));
  }
}

async function install(): Promise<number> {
  const env = envText();
  const port = portOf(env);
  if (!existsSync(join(ROOT, 'dist', 'server', 'index.js'))) {
    console.error(tr('Falta o build (dist/server/index.js): rode npm run native:install, que faz o build antes.'));
    return 1;
  }
  if ((await health(port))?.docker) {
    console.error(tr('A porta {0} está com o Habblaud do Docker. Pare o container antes: docker stop habblaud', [port]));
    return 1;
  }
  renewRemoteCert(env);
  const spec: ServiceSpec = { root: ROOT, home: HOME, node: realpathSync(process.execPath), lang: process.env.LANG };
  const logs = logFiles(HOME);
  mkdirSync(dirname(logs.out), { recursive: true });
  mkdirSync(dirname(plistFile(HOME)), { recursive: true });
  writeFileSync(plistFile(HOME), renderPlist(spec), { mode: 0o644 });
  // Num processo à parte (sessão própria): o bootout derruba o servidor e, rodando no terminal do próprio Habblaud, este
  // processo junto; o bootstrap acontece mesmo assim.
  const since = Date.now();
  const [cmd, args] = reloadCommand(target(), plistFile(HOME), logs.err);
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  console.log(tr('Serviço {0} instalado ({1}). Esperando o Habblaud em http://127.0.0.1:{2}…', [SERVICE_LABEL, plistFile(HOME), port]));
  const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
  if (await waitForRestart({ startedAt: () => startedAtOn(port), sleep }, since, WAIT_S)) {
    const h = await health(port);
    console.log(tr('Habblaud {0} no ar; terminal interativo: {1}. Log: {2}', [h?.version ?? '?', h?.pty ? tr('ligado') : tr('desligado (veja o log)'), logs.out]));
    return 0;
  }
  console.error(tr('O Habblaud não respondeu em {0} s: veja {1}', [WAIT_S, logs.err]));
  return 1;
}

function uninstall(): number {
  launchctl('bootout', `${target()}/${SERVICE_LABEL}`);
  rmSync(plistFile(HOME), { force: true });
  console.log(tr('Serviço {0} removido. Para voltar ao Docker: npm run docker:up', [SERVICE_LABEL]));
  return 0;
}

async function status(): Promise<number> {
  if (!existsSync(plistFile(HOME))) {
    console.log(tr('Serviço {0}: não instalado (npm run native:install).', [SERVICE_LABEL]));
    return 1;
  }
  const st = parseLaunchctlPrint(launchctl('print', `${target()}/${SERVICE_LABEL}`).stdout ?? '');
  const h = await health(portOf(envText()));
  console.log(tr('Serviço {0}: {1}', [SERVICE_LABEL, st.running ? tr('rodando (pid {0})', [st.pid ?? '?']) : tr('parado')]));
  console.log(
    h
      ? tr('Habblaud {0}: Docker {1}, terminal interativo {2}.', [h.version ?? '?', h.docker ? tr('ligado') : tr('desligado'), h.pty ? tr('ligado') : tr('desligado')])
      : tr('o Habblaud não respondeu'),
  );
  console.log(tr('Log: {0}', [logFiles(HOME).out]));
  return st.running && h && !h.docker ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(tr('O serviço nativo (LaunchAgent) só existe no macOS; nos outros sistemas use npm start ou npm run docker:up.'));
    process.exitCode = 1;
    return;
  }
  const cmd = process.argv[2];
  if (cmd === 'install') process.exitCode = await install();
  else if (cmd === 'uninstall') process.exitCode = uninstall();
  else if (cmd === 'status') process.exitCode = await status();
  else {
    console.error('npm run native:install | native:uninstall | native:status');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
