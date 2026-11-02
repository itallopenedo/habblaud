# Fase 5 — Terminal completo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodar o Habblaud nativo no Mac como serviço (C1, com o terminal interativo ligado) e usar esse terminal
interativo no iPhone, só pela tailnet, com login, usuário do Tailscale conferido, capacidade `pty` e senha de novo a
cada 10 min (C2).

**Architecture:** C1: um script novo (`npm run native:install|uninstall|status`) escreve o LaunchAgent
`com.pnd.habblaud` que roda `node --env-file-if-exists=<projeto>/.env dist/server/index.js` com o Node absoluto,
`HABBLAUD_PTY=1`, KeepAlive e logs em `~/.habblaud/logs/`; o `.env` continua sendo a única fonte de configuração (o
próprio Node o lê, nada de segredo no plist) e o caminho do Docker não muda. C2: um terceiro listener HTTP só em
`127.0.0.1:4749` (`HABBLAUD_TAILNET_PORT`), publicado pelo `tailscale serve --https=8443`, passa por guard → cabeçalho
`Tailscale-User-Login` igual a `HABBLAUD_TAILNET_USER` → o mesmo login da porta do celular (sessões e freio
compartilhados) → API. As requisições dele são "remotas" (tudo o que é só do computador continua recusado) e, além
disso, "da tailnet": só elas passam no bloco do PTY, com `pty` em `HABBLAUD_REMOTE_ALLOW`, e abrir/assumir/encerrar/o
stream pedem a senha conferida há menos de 10 min (401 `{code: 'reauth'}`, `POST /api/remote/confirm`). No cliente, o
acesso ganha `pty`, o terminal pede a senha num `<dialog>` quando o servidor manda, e o celular ganha a barra de teclas
(Esc, Tab, Ctrl, setas). Antes de tudo, os arquivos do agente no modo Node passam a seguir a mesma regra de pastas do
auxiliar do Docker.

**Tech Stack:** Node 24 + TypeScript (tsx), Vitest, cliente em TypeScript puro (Vite) com xterm.js, launchd
(LaunchAgent), Tailscale (`tailscale serve`). Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-11-01-meu-habblaud-design.md` (Fase 5 — Terminal completo (C)). Mudanças e
decisões registradas em relação ao spec:

- **C1, `.env`:** o servidor não lê `.env` sozinho (só o Compose lê). O serviço usa `node --env-file-if-exists` (Node
  22.9+, o projeto exige 22.12): o mesmo `~/habblaud/.env` vale para Docker e nativo, editar o `.env` + reiniciar o
  serviço aplica, e a hash da senha não vai para `~/Library/LaunchAgents`. `HABBLAUD_PTY=1` fica no plist (no `.env`
  ligaria também o Novo agente no Docker, num rollback).
- **C1, migração:** o README não tem seção "vindo do Docker para o Node". O volume `habblaud_habblaud-data` tem hoje
  `names.json`, `remote-secret`, `stats/`, `timeline/` e `updates.json` (conferido em 2026-11-01); nada disso existe em
  `~/.habblaud`. A Task 10 copia o volume com `docker cp` para um backup e dele para `~/.habblaud` sem sobrescrever
  nada. Copiar o `remote-secret` mantém o iPhone logado (a chave das sessões é segredo + usuário + hash). O volume e o
  container parado ficam para o rollback. O `FORK.md` documenta (Task 2).
- **C1, auxiliar do host:** no modo Node o servidor já faz sozinho o que o `codex-bridge` faz no Docker (`codex queue`
  com `findCodexBin`, ditado com `findWhisper`, Novo agente com `runnableClaudeBin`, arquivos `direct`, anexos por
  `writeMessageAttachments`; com `codex.run` o registry nem entrega ao auxiliar). O LaunchAgent
  `com.pnd.habblaud-codex-bridge` é desligado (`launchctl bootout` + `launchctl disable`), com o plist mantido para o
  rollback.
- **C2, o que é "abrir":** `POST /api/pty` (sessão nova), `POST /api/agents/:id/takeover`, `POST /api/agents/:id/stop`
  e `GET /api/pty/:id/stream` pedem a senha conferida há menos de 10 min. `GET /api/pty`, `input`, `resize` e `close`
  só pedem login + cabeçalho + `pty` (senão o terminal pararia de aceitar teclas no meio do uso). O login conta como
  conferência. As conferências ficam só em memória: reiniciar o Habblaud pede a senha de novo.
- **C2, página inteira na 8443:** o listener da tailnet serve o app todo (não só o PTY), com as mesmas travas da
  porta do celular. Cookies não separam portas: o login feito na 443 vale na 8443 e vice-versa (mesmas sessões). O app
  da Tela de Início pode passar a ser o da 8443 (a 443 continua igual, sem PTY).
- **Segurança (follow-up da Fase 4):** no modo Node, `GET /api/agents/:id/files/:fileId` e as entregas liam qualquer
  caminho que passasse no `checkFile`; o auxiliar do Docker já restringe a pastas de projeto conhecidas
  (`insideKnownFolder`). A Task 1 põe a mesma regra no `FileFetcher` (um lugar só, que serve aos dois).

### Fatos conferidos (2026-11-01, HEAD `230c2bc`)

- `server/http/app.ts`: `trusted(req, feature)`; bloco do PTY recusa `isRemote(req)` (403); `/api/health` e
  `/api/access` dizem `pty: !!deps.pty && !remote` / não têm `pty`. `isLocalOnlyPath` barra `/api/host/*`,
  `/api/codex/*`, `/api/permissions` (registro e wait) e `/api/mod/inbox*` para remoto; `/api/world/*` e `POST
  /api/demo` também recusam remoto.
- `server/http/pty.ts`: `ptyRequestProblem` exige socket loopback, Host loopback e Origin da mesma origem.
- `server/http/remote.ts`: `RemoteFeature = 'permissions' | 'messages' | 'terminal' | 'spawn'`; `RemoteSessions`
  (token `v1.<exp>.<sig>` HMAC, `revoke`), `LoginThrottle`, `createRemoteGate` (login/logout/CA/login page, marca
  `remoteRequests`), cookie `habblaud_remote` `HttpOnly; SameSite=Strict` (+ `Secure` com `secure: true`).
- `server/index.ts`: cria `RemoteSessions` dentro do bloco da porta remota (linhas ~455-490); cadeia do PTY
  (`HABBLAUD_PTY`, Docker recusado, trava do terminal, `claude`, `loadPty`) nas linhas ~300-336.
- `server/deliveries/fetcher.ts`: `readLocal` só passa pelo `checkFile`; `insideKnownFolder(path, {accountDirs, roots})`
  e `tempRoots()` em `server/deliveries/files.ts`, usados só em `scripts/codex-bridge.ts`.
- Mac: Docker `habblaud` (healthy, `127.0.0.1:4747`, `0.0.0.0:4748`), `.env` em `~/habblaud` com
  `HABBLAUD_REMOTE_USER/PASSWORD_HASH/BIND/PORT/NAME/DOMAIN/ALLOW` e `HABBLAUD_ALLOWED_HOSTS` (já com
  `macbook-pro-de-itallo.taile846b7.ts.net`); certificado em `~/.habblaud/remote-tls/server/` (o padrão do modo Node);
  LaunchAgents `com.pnd.habblaud-codex-bridge` (PATH com o Node do fnm, `~/.local/bin` e `/opt/homebrew/bin`),
  `com.pnd.habblaud-phone-notify`, `com.habblaud.remote-mdns`, `com.pnd.docker-login`; `node-pty` (prebuild
  darwin-arm64), `@xterm/headless` e `@xterm/addon-serialize` instalados em `~/habblaud/node_modules`; `~/habblaud` sem
  `dist/`. `claude`/`codex` em `~/.local/bin`, `whisper-cli`/`ffmpeg` em `/opt/homebrew/bin`.

## Global Constraints

- Branch `fase-5-terminal` a partir de `meu-habblaud` (`230c2bc`) → PR para `meu-habblaud` no fork `itallopenedo/habblaud`.
- `shared/world/` e `server/world/`: não mexer. Nada desta fase muda o que vai ao Habblaud World.
- PTY nunca pela porta do celular na rede (4748): só pelo listener da tailnet, em `127.0.0.1` apenas (porta
  `HABBLAUD_TAILNET_PORT`, padrão 4749), HTTP puro; o TLS é do `tailscale serve --bg --https=8443 http://127.0.0.1:4749`.
  A 443 da tailnet continua em `https+insecure://127.0.0.1:4748`. A 4747 nunca é publicada.
- No listener da tailnet toda requisição precisa do cabeçalho `Tailscale-User-Login` igual a `HABBLAUD_TAILNET_USER`
  (comparação sem caixa) e do login remoto válido; o PTY precisa também de `pty` em `HABBLAUD_REMOTE_ALLOW`; abrir,
  assumir, encerrar e o stream precisam da senha conferida há menos de 10 min (`CONFIRM_MS = 600_000`), senão 401
  `{error, code: 'reauth'}`.
- Rotas só do computador (`/api/host/*`, hooks, caixa do plugin, eventos do Codex, `/api/world/*`, `POST /api/demo`)
  continuam recusadas no listener da tailnet: as requisições dele são marcadas como remotas.
- Serviço nativo: LaunchAgent `com.pnd.habblaud`, KeepAlive, Node absoluto (caminho real), `HABBLAUD_PTY=1`, logs em
  `~/.habblaud/logs/habblaud.log` e `habblaud.error.log`, `.env` lido pelo Node (`--env-file-if-exists`). O caminho do
  Docker (`npm run docker:up`, `docker-compose.yml`) continua funcionando sem mudança.
- Rodadas de teste do servidor (`npm run dev`) sempre com `HABBLAUD_DATA_DIR` temporário, `HABBLAUD_WORLD=0`,
  `HABBLAUD_UPDATE_CHECK=0` e portas diferentes de 4747/4748/4749.
- Texto visível (interface, erros, logs, saída de scripts) passa por `tr()` com traduções em
  `shared/locales/{en,es,fr}.ts` (bloco `// Fase 5 — terminal` no fim de cada arquivo); `npm run i18n:check` verde.
  Antes de acrescentar uma chave, `grep -n '^\s*"<texto>":' shared/locales/en.ts`: se já existir, não repita (chave
  duplicada quebra o typecheck). Já existem: `"Cancelar"`, `"Confirmar"`, `"Senha"`, `"ligado"`, `"desligado"`,
  `"parado"`, `"o Habblaud não respondeu"`, `"erro {0}"`, `"não consegui ligar o serviço: {0}"`, `"Acesso remoto:
  certificado do servidor renovado ({0})."`, `"acesso remoto: não consegui conferir o certificado ({0})."`.
- Mudança visível entra em `## [Não lançado]` do `CHANGELOG.md` (`### Adicionado` ou `### Corrigido`).
- Arquivos novos em vez de reescrever arquivos do upstream sempre que possível.
- Commits terminam com `Co-Authored-By:` do modelo que escreveu. Nunca `git add -A`: arquivos explícitos.
- Antes do PR: `npm run typecheck`, `npm test`, `npm run i18n:check`, `npm run build`, `git diff --check` verdes.
- **Operação no Mac** (parar Docker, LaunchAgents, `.env`, `tailscale serve`, push/PR/merge, reiniciar o Mac): cada
  passo marcado "pedir OK do Itallo" só roda depois do OK no chat, com os comandos exatos, a conferência e o rollback
  (`npm run native:uninstall` ou `launchctl bootout gui/$(id -u)/com.pnd.habblaud`, depois `npm run docker:up`).

---

## Parte A — Código (testável, revisável)

### Task 1: Arquivos do agente no modo Node só das pastas de projeto

**Files:**
- Modify: `server/deliveries/fetcher.ts` (`FileFetcherOptions`, `readLocal`)
- Modify: `server/index.ts` (criação do `deliveryFiles`, ~linhas 217-228)
- Test: `server/deliveries/fetcher.test.ts`
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `insideKnownFolder(path, { accountDirs, roots })` e `tempRoots()` de `server/deliveries/files.ts`;
  `attachmentsRoot()` de `server/spawn/attachments.ts`; `config.claudeDirs`.
- Produces: `FileFetcherOptions.inside?: (realPath: string) => boolean` — só vale com `direct: true`; recusa vira
  `{ error: 'fora das pastas de projeto', status: 403 }`.

- [ ] **Step 1: Teste (falhando)** — em `server/deliveries/fetcher.test.ts`, dentro do `describe('FileFetcher')`:

```ts
  it('Node: com `inside`, recusa (403) o que está fora das pastas de projeto, pelo caminho real', async () => {
    const seen: string[] = [];
    const f = new FileFetcher({
      direct: true,
      // Um link dentro do projeto que aponta para fora: o checkFile devolve o caminho real.
      check: (p) => ({ path: p === '/proj/link.png' ? '/Users/a/Documents/extrato.png' : p, size: 3 }),
      read: () => Buffer.from('abc'),
      inside: (p) => (seen.push(p), p.startsWith('/proj/')),
    });
    expect(await f.get('/proj/x.png')).toEqual({ data: Buffer.from('abc') });
    expect(await f.get('/Users/a/Documents/extrato.png')).toEqual({ error: 'fora das pastas de projeto', status: 403 });
    expect(await f.get('/proj/link.png')).toEqual({ error: 'fora das pastas de projeto', status: 403 });
    expect(seen).toEqual(['/proj/x.png', '/Users/a/Documents/extrato.png', '/Users/a/Documents/extrato.png']);
  });

  it('Docker: `inside` não se aplica às pastas montadas (quem restringe lá é o auxiliar do host)', async () => {
    const f = new FileFetcher({ mapHostPath: (p) => `/claude${p}`, check: (p) => ({ path: p, size: 3 }), read: () => Buffer.from('m'), inside: () => false });
    expect(await f.get('/h/.claude/projects/x/print.png')).toEqual({ data: Buffer.from('m') });
  });
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/deliveries/fetcher.test.ts` → o primeiro teste falha (lê
  `/Users/a/Documents/extrato.png`); o typecheck do teste reclama de `inside`.

- [ ] **Step 3: Implementação** — em `server/deliveries/fetcher.ts`, no `FileFetcherOptions`, depois de `direct`:

```ts
  /**
   * Modo Node: só lê o arquivo (caminho real, depois do checkFile) que estiver numa pasta de projeto conhecida, numa
   * temporária ou nos anexos — a mesma regra do auxiliar do host no Docker (insideKnownFolder). Ausente = sem restrição.
   */
  inside?: (realPath: string) => boolean;
```

e em `readLocal`, logo depois do `if ('error' in c) ...`:

```ts
    if (this.opts.direct && this.opts.inside && !this.opts.inside(c.path)) return { error: tr('fora das pastas de projeto'), status: 403 };
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/deliveries/fetcher.test.ts` → verde.

- [ ] **Step 5: Ligar no servidor** — em `server/index.ts`: `import { insideKnownFolder, tempRoots } from './deliveries/files';`
  e trocar a criação do `deliveryFiles` por:

```ts
// Pastas que o leitor do modo Node pode abrir: as de projeto que alguma conta do Claude Code conhece, as temporárias e
// os anexos (a mesma regra do auxiliar do host no Docker, scripts/codex-bridge.ts).
const fileRoots = [...tempRoots(), attachmentsRoot()];
const deliveryFiles = deliveries
  ? new FileFetcher({
      direct: !config.inDocker,
      inside: config.inDocker ? undefined : (p) => insideKnownFolder(p, { accountDirs: config.claudeDirs, roots: fileRoots }),
      mapHostPath: (p) => {
        for (const e of accounts.entries()) {
          const host = e.detected.configDir.replace(/\/+$/, '');
          if (host && p.startsWith(`${host}/`)) return `${e.dir.replace(/\/+$/, '')}${p.slice(host.length)}`;
        }
        return undefined;
      },
    })
  : undefined;
```

- [ ] **Step 6: Traduções** (bloco `// Fase 5 — terminal`):
  - en: `"fora das pastas de projeto": "outside the project folders",`
  - es: `"fora das pastas de projeto": "fuera de las carpetas de proyecto",`
  - fr: `"fora das pastas de projeto": "hors des dossiers de projet",`

- [ ] **Step 7: CHANGELOG** — `### Corrigido`:

```md
- **Arquivos do agente no modo Node só das pastas de projeto.** Sem o Docker, a seção Arquivos e as entregas abriam
  qualquer arquivo de ver que o agente citasse; agora valem só as pastas de projeto que o Claude Code conhece, as
  temporárias e os anexos do Habblaud, a mesma regra que o auxiliar do host já seguia no Docker.
```

- [ ] **Step 8: Conferir** — `npx vitest run server/deliveries && npm run typecheck && npm run i18n:check` → verdes.

- [ ] **Step 9: Commit**

```bash
git add server/deliveries/fetcher.ts server/deliveries/fetcher.test.ts server/index.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts CHANGELOG.md
git commit -m "Arquivos do agente no modo Node: só pastas de projeto, como no Docker"
```

---

### Task 2: C1 — `npm run native:install|uninstall|status` (LaunchAgent)

**Files:**
- Create: `scripts/native-service.ts`
- Test: `server/test/native-service.test.ts`
- Modify: `package.json` (scripts), `server/tsconfig.json` (`include` ganha `"../scripts/native-service.ts"`)
- Modify: `FORK.md`, `CHANGELOG.md`, `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `readEnvValue` (`server/remote/envfile.ts`); `ensureServerCert`, `remoteTargets`, `remoteTlsBase`,
  `tlsPaths` (`server/remote/tls.ts`); `tr`.
- Produces (`scripts/native-service.ts`): `SERVICE_LABEL = 'com.pnd.habblaud'`;
  `interface ServiceSpec { root: string; home: string; node: string }`; `servicePath(spec: Pick<ServiceSpec, 'home' | 'node'>): string`;
  `logFiles(home: string): { out: string; err: string }`; `plistFile(home: string): string`;
  `renderPlist(spec: ServiceSpec): string`; `parseLaunchctlPrint(text: string): { running: boolean; pid?: number }`.
  Comandos: `npm run native:install` (build + plist + `launchctl bootstrap` + espera o `/api/health`),
  `npm run native:uninstall` (`bootout` + apaga o plist), `npm run native:status`.

- [ ] **Step 1: Teste (falhando)** — `server/test/native-service.test.ts`:

```ts
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
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/test/native-service.test.ts` → falha (módulo não existe).

- [ ] **Step 3: `scripts/native-service.ts`**

```ts
// npm run native:install | native:uninstall | native:status — o Habblaud como serviço do macOS (LaunchAgent), no lugar
// do Docker: `node --env-file-if-exists=<projeto>/.env dist/server/index.js`, com KeepAlive, o Node absoluto de quem
// instalou (o caminho real, não o atalho temporário do fnm), HABBLAUD_PTY=1 (terminal interativo) e logs em
// ~/.habblaud/logs/. O .env é lido pelo próprio Node a cada início: senha e opções não vão para o plist. Atualizar =
// rodar native:install de novo (faz o build e reinicia). O Docker continua funcionando (npm run docker:up); só não
// rode os dois ao mesmo tempo (a porta é a mesma).
import { spawnSync } from 'node:child_process';
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
const WAIT_S = 30;

export interface ServiceSpec {
  /** Pasta do projeto (package.json, .env e dist/). */
  root: string;
  home: string;
  /** Node absoluto (caminho real). */
  node: string;
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
  const spec: ServiceSpec = { root: ROOT, home: HOME, node: realpathSync(process.execPath) };
  const logs = logFiles(HOME);
  mkdirSync(dirname(logs.out), { recursive: true });
  mkdirSync(dirname(plistFile(HOME)), { recursive: true });
  writeFileSync(plistFile(HOME), renderPlist(spec), { mode: 0o644 });
  launchctl('bootout', `${target()}/${SERVICE_LABEL}`);
  const r = launchctl('bootstrap', target(), plistFile(HOME));
  if (r.status !== 0) {
    console.error(tr('não consegui ligar o serviço: {0}', [String(r.stderr).trim()]));
    return 1;
  }
  console.log(tr('Serviço {0} instalado ({1}). Esperando o Habblaud em http://127.0.0.1:{2}…', [SERVICE_LABEL, plistFile(HOME), port]));
  for (let i = 0; i < WAIT_S; i++) {
    const h = await health(port);
    if (h && !h.docker) {
      console.log(tr('Habblaud {0} no ar; terminal interativo: {1}. Log: {2}', [h.version ?? '?', h.pty ? tr('ligado') : tr('desligado (veja o log)'), logs.out]));
      return 0;
    }
    await new Promise((ok) => setTimeout(ok, 1_000));
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
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/test/native-service.test.ts` → verde.

- [ ] **Step 5: Scripts e typecheck** — em `package.json`, depois de `"docker:logs"`:

```json
    "native:install": "npm run build && tsx scripts/native-service.ts install",
    "native:uninstall": "tsx scripts/native-service.ts uninstall",
    "native:status": "tsx scripts/native-service.ts status",
```

  e em `server/tsconfig.json`, no `include`, acrescentar `"../scripts/native-service.ts"` depois de
  `"../scripts/remote-mdns.ts"`.

- [ ] **Step 6: plist válido (sem instalar nada)**

```bash
P=$(mktemp -t habblaud-plist)
npx tsx -e "import('./scripts/native-service.ts').then((m) => process.stdout.write(m.renderPlist({ root: process.cwd(), home: process.env.HOME, node: process.execPath })))" > "$P" && plutil -lint "$P"; rm -f "$P"
```

  Esperado: `<arquivo>: OK`. Conferir também `node --env-file-if-exists=/nao/existe -e "console.log('ok')"` → `ok`
  (a opção existe no Node do Mac).

- [ ] **Step 7: Traduções** (bloco `// Fase 5 — terminal`):
  - en:
    - `"Falta o build (dist/server/index.js): rode npm run native:install, que faz o build antes.": "The build is missing (dist/server/index.js): run npm run native:install, which builds first.",`
    - `"A porta {0} está com o Habblaud do Docker. Pare o container antes: docker stop habblaud": "Port {0} is taken by the Docker Habblaud. Stop the container first: docker stop habblaud",`
    - `"Serviço {0} instalado ({1}). Esperando o Habblaud em http://127.0.0.1:{2}…": "Service {0} installed ({1}). Waiting for Habblaud at http://127.0.0.1:{2}…",`
    - `"Habblaud {0} no ar; terminal interativo: {1}. Log: {2}": "Habblaud {0} is up; interactive terminal: {1}. Log: {2}",`
    - `"desligado (veja o log)": "off (see the log)",`
    - `"O Habblaud não respondeu em {0} s: veja {1}": "Habblaud didn't answer within {0} s: see {1}",`
    - `"Serviço {0} removido. Para voltar ao Docker: npm run docker:up": "Service {0} removed. To go back to Docker: npm run docker:up",`
    - `"Serviço {0}: não instalado (npm run native:install).": "Service {0}: not installed (npm run native:install).",`
    - `"Serviço {0}: {1}": "Service {0}: {1}",`
    - `"rodando (pid {0})": "running (pid {0})",`
    - `"Habblaud {0}: Docker {1}, terminal interativo {2}.": "Habblaud {0}: Docker {1}, interactive terminal {2}.",`
    - `"Log: {0}": "Log: {0}",`
    - `"O serviço nativo (LaunchAgent) só existe no macOS; nos outros sistemas use npm start ou npm run docker:up.": "The native service (LaunchAgent) only exists on macOS; on other systems use npm start or npm run docker:up.",`
  - es:
    - `"Falta o build (dist/server/index.js): rode npm run native:install, que faz o build antes.": "Falta el build (dist/server/index.js): ejecuta npm run native:install, que hace el build antes.",`
    - `"A porta {0} está com o Habblaud do Docker. Pare o container antes: docker stop habblaud": "El puerto {0} lo usa el Habblaud de Docker. Detén el contenedor antes: docker stop habblaud",`
    - `"Serviço {0} instalado ({1}). Esperando o Habblaud em http://127.0.0.1:{2}…": "Servicio {0} instalado ({1}). Esperando a Habblaud en http://127.0.0.1:{2}…",`
    - `"Habblaud {0} no ar; terminal interativo: {1}. Log: {2}": "Habblaud {0} en marcha; terminal interactiva: {1}. Log: {2}",`
    - `"desligado (veja o log)": "desactivado (mira el log)",`
    - `"O Habblaud não respondeu em {0} s: veja {1}": "Habblaud no respondió en {0} s: mira {1}",`
    - `"Serviço {0} removido. Para voltar ao Docker: npm run docker:up": "Servicio {0} eliminado. Para volver a Docker: npm run docker:up",`
    - `"Serviço {0}: não instalado (npm run native:install).": "Servicio {0}: no instalado (npm run native:install).",`
    - `"Serviço {0}: {1}": "Servicio {0}: {1}",`
    - `"rodando (pid {0})": "en ejecución (pid {0})",`
    - `"Habblaud {0}: Docker {1}, terminal interativo {2}.": "Habblaud {0}: Docker {1}, terminal interactiva {2}.",`
    - `"Log: {0}": "Log: {0}",`
    - `"O serviço nativo (LaunchAgent) só existe no macOS; nos outros sistemas use npm start ou npm run docker:up.": "El servicio nativo (LaunchAgent) solo existe en macOS; en otros sistemas usa npm start o npm run docker:up.",`
  - fr:
    - `"Falta o build (dist/server/index.js): rode npm run native:install, que faz o build antes.": "Le build manque (dist/server/index.js) : lancez npm run native:install, qui fait le build avant.",`
    - `"A porta {0} está com o Habblaud do Docker. Pare o container antes: docker stop habblaud": "Le port {0} est pris par le Habblaud de Docker. Arrêtez d'abord le conteneur : docker stop habblaud",`
    - `"Serviço {0} instalado ({1}). Esperando o Habblaud em http://127.0.0.1:{2}…": "Service {0} installé ({1}). Attente de Habblaud sur http://127.0.0.1:{2}…",`
    - `"Habblaud {0} no ar; terminal interativo: {1}. Log: {2}": "Habblaud {0} est lancé ; terminal interactif : {1}. Journal : {2}",`
    - `"desligado (veja o log)": "désactivé (voir le journal)",`
    - `"O Habblaud não respondeu em {0} s: veja {1}": "Habblaud n'a pas répondu en {0} s : voir {1}",`
    - `"Serviço {0} removido. Para voltar ao Docker: npm run docker:up": "Service {0} supprimé. Pour revenir à Docker : npm run docker:up",`
    - `"Serviço {0}: não instalado (npm run native:install).": "Service {0} : non installé (npm run native:install).",`
    - `"Serviço {0}: {1}": "Service {0} : {1}",`
    - `"rodando (pid {0})": "en cours (pid {0})",`
    - `"Habblaud {0}: Docker {1}, terminal interativo {2}.": "Habblaud {0} : Docker {1}, terminal interactif {2}.",`
    - `"Log: {0}": "Journal : {0}",`
    - `"O serviço nativo (LaunchAgent) só existe no macOS; nos outros sistemas use npm start ou npm run docker:up.": "Le service natif (LaunchAgent) n'existe que sur macOS ; sur les autres systèmes, utilisez npm start ou npm run docker:up.",`

- [ ] **Step 8: FORK.md** — acrescentar no fim (e trocar a última frase "`npm run docker:up` (ou o serviço nativo, a partir
  da Fase 5)" por "`npm run native:install` (ou `npm run docker:up`, no Docker)"):

```md
## Habblaud nativo (sem Docker)

Neste Mac o Habblaud roda como serviço do macOS, não no Docker (o terminal interativo só existe fora do container):

    npm run native:install     # build + LaunchAgent com.pnd.habblaud (KeepAlive, HABBLAUD_PTY=1); também serve para atualizar
    npm run native:status      # serviço, versão e se o terminal interativo está ligado
    npm run native:uninstall   # tira o serviço (para voltar ao Docker: npm run docker:up)

O serviço lê o mesmo `.env` do projeto (`node --env-file-if-exists`); logs em `~/.habblaud/logs/habblaud.log` e
`habblaud.error.log`. Não rode o Docker e o serviço ao mesmo tempo (mesma porta). Dados: `~/.habblaud` (no Docker, o
volume `habblaud_habblaud-data`; a migração copiou o volume para `~/.habblaud` e deixou um backup em
`~/.habblaud/docker-data-backup-<data>`). O `npm run codex:bridge` não é necessário no modo nativo.
```

- [ ] **Step 9: CHANGELOG** — `### Adicionado`:

```md
- **Habblaud como serviço no macOS (`npm run native:install`).** Faz o build e instala um LaunchAgent que mantém o
  Habblaud rodando sem o Docker, com o terminal interativo ligado (`HABBLAUD_PTY=1`), o mesmo `.env` do projeto e logs
  em `~/.habblaud/logs/`. `npm run native:status` mostra o estado e `npm run native:uninstall` tira o serviço (o Docker
  continua funcionando com `npm run docker:up`).
```

- [ ] **Step 10: Conferir** — `npx vitest run server/test/native-service.test.ts && npm run typecheck && npm run i18n:check` → verdes.

- [ ] **Step 11: Commit**

```bash
git add scripts/native-service.ts server/test/native-service.test.ts package.json server/tsconfig.json FORK.md CHANGELOG.md shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Serviço nativo no macOS: npm run native:install|uninstall|status"
```

---

### Task 3: C2 — capacidade `pty` e senha conferida há pouco (`/api/remote/confirm`)

**Files:**
- Modify: `server/http/remote.ts` (`RemoteFeature`, `FEATURES`, `RemoteSessions`, `createRemoteGate`)
- Test: `server/http/remote.test.ts`
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Produces (`server/http/remote.ts`):
  `RemoteFeature` ganha `'pty'`; `export const CONFIRM_MS = 10 * 60 * 1000`;
  `RemoteSessions.confirm(token: string | undefined): boolean` (renova a conferência de um token válido);
  `RemoteSessions.confirmedWithin(token: string | undefined, ms: number): boolean`; `issue()` passa a contar como
  conferência. Rotas no gate: `GET /api/remote/confirm` → 200 `{ fresh: boolean }` (fresh = conferida há menos de
  `CONFIRM_MS`); `POST /api/remote/confirm {password}` → 200 `{ok: true}` | 401 `{error}` | 429; sem login → 401;
  outro método → 405. Usa o mesmo `LoginThrottle` do login.

- [ ] **Step 1: Testes (falhando)** — em `server/http/remote.test.ts`: acrescentar `CONFIRM_MS` ao import de `./remote`;
  no `describe('parseRemoteConfig')`, no teste do `HABBLAUD_REMOTE_ALLOW`, a linha
  `expect([...parseAllow('terminal,pty')]).toEqual(['terminal', 'pty']);`; e no fim do arquivo:

```ts
describe('RemoteSessions — senha conferida há pouco (terminal pelo celular)', () => {
  it('o login conta como conferência; vence em CONFIRM_MS; confirm renova; token inválido ou encerrado não', () => {
    let now = 1_800_000_000_000;
    const s = new RemoteSessions(SECRET, CFG, () => now);
    const { token } = s.issue();
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(true);
    now += CONFIRM_MS;
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(false);
    expect(s.confirm(token)).toBe(true);
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(true);
    expect(s.confirm('v1.1800000000000.x')).toBe(false);
    expect(s.confirmedWithin(undefined, CONFIRM_MS)).toBe(false);
    s.revoke(token);
    expect(s.confirm(token)).toBe(false);
    expect(s.confirmedWithin(token, CONFIRM_MS)).toBe(false);
  });

  it('cada token tem a sua conferência (outro aparelho não herda)', () => {
    let now = 1_800_000_000_000;
    const s = new RemoteSessions(SECRET, CFG, () => now);
    const a = s.issue().token;
    now += 1_000;
    const b = s.issue().token;
    now += CONFIRM_MS - 500;
    expect(s.confirmedWithin(a, CONFIRM_MS)).toBe(false);
    expect(s.confirmedWithin(b, CONFIRM_MS)).toBe(true);
  });
});

describe('/api/remote/confirm (senha de novo)', () => {
  it('sem login 401; logado: GET diz se está em dia, senha errada 401, certa 200, outro método 405', async () => {
    const s = await start();
    expect((await request(s.remoteBase, '/api/remote/confirm')).status).toBe(401);
    expect((await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD } })).status).toBe(401);
    const cookie = await login(s.remoteBase);
    const fresh = await request(s.remoteBase, '/api/remote/confirm', { headers: { Cookie: cookie } });
    expect(fresh.status).toBe(200);
    expect(JSON.parse(fresh.body)).toEqual({ fresh: true });
    const wrong = await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: 'errada' }, headers: { Cookie: cookie } });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body).error).toBe('Senha incorreta.');
    const ok = await request(s.remoteBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD }, headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect((await request(s.remoteBase, '/api/remote/confirm', { method: 'PUT', body: {}, headers: { Cookie: cookie } })).status).toBe(405);
  });
});
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/http/remote.test.ts` → falha (`CONFIRM_MS`, `confirm`,
  `confirmedWithin` não existem; `parseAllow` ignora `pty`; a rota cai no 401/404).

- [ ] **Step 3: Implementação** — em `server/http/remote.ts`:

  1. Tipo e lista (e o comentário do cabeçalho: `HABBLAUD_REMOTE_ALLOW ... permissions, messages, terminal, spawn, pty
     (o terminal interativo, só pela porta da tailnet: http/tailnet.ts)`):

```ts
export type RemoteFeature = 'permissions' | 'messages' | 'terminal' | 'spawn' | 'pty';

const FEATURES: readonly RemoteFeature[] = ['permissions', 'messages', 'terminal', 'spawn', 'pty'];
```

  2. Depois de `SESSION_MS`:

```ts
/** Abrir, assumir ou encerrar um terminal interativo pelo celular pede a senha conferida há menos disto. */
export const CONFIRM_MS = 10 * 60 * 1000;
```

  3. Em `RemoteSessions`, um campo novo e os métodos (o `issue` passa a registrar a conferência):

```ts
  /** Assinatura -> quando a senha foi conferida pela última vez com este token (login ou /api/remote/confirm). Só em memória. */
  private readonly confirmed = new Map<string, number>();

  issue(): { token: string; maxAgeS: number } {
    const exp = this.now() + SESSION_MS;
    const payload = `v1.${exp}`;
    const sig = this.sign(payload);
    this.markConfirmed(sig);
    return { token: `${payload}.${sig}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  /** A senha acabou de ser conferida de novo com este token (válido e não encerrado). */
  confirm(token: string | undefined): boolean {
    const parsed = this.parse(token);
    if (!parsed || this.revoked.has(parsed.sig)) return false;
    this.markConfirmed(parsed.sig);
    return true;
  }

  /** A última conferência da senha com este token foi há menos de `ms`. */
  confirmedWithin(token: string | undefined, ms: number): boolean {
    const parsed = this.parse(token);
    if (!parsed || this.revoked.has(parsed.sig)) return false;
    const at = this.confirmed.get(parsed.sig);
    return at !== undefined && this.now() - at < ms;
  }

  private markConfirmed(sig: string): void {
    const now = this.now();
    for (const [s, at] of this.confirmed) if (now - at >= CONFIRM_MS) this.confirmed.delete(s);
    this.confirmed.set(sig, now);
  }
```

  4. Em `createRemoteGate`, logo depois do bloco de `/api/remote/logout`:

```ts
    if (path === '/api/remote/confirm') {
      // Senha de novo (terminal interativo pelo celular): só com login; mesmo freio do login.
      const token = readCookie(req.headers.cookie, COOKIE);
      if (!authed) {
        req.resume();
        sendJson(res, 401, { error: tr('faça login: abra o Habblaud por esta porta no navegador e entre com usuário e senha') });
        return true;
      }
      if (method === 'GET' || method === 'HEAD') {
        req.resume();
        sendJson(res, 200, { fresh: deps.sessions.confirmedWithin(token, CONFIRM_MS) });
        return true;
      }
      if (method !== 'POST') {
        req.resume();
        sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'GET, POST' });
        return true;
      }
      const tooMany = () => {
        const wait = Math.max(1, throttle.retryAfter());
        sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em {0} s.', [wait]) }, { 'Retry-After': String(wait) });
      };
      if (throttle.retryAfter() > 0) {
        req.resume();
        tooMany();
        return true;
      }
      let begun = false;
      let ok = false;
      readBody(req)
        .then(async (raw) => {
          if (!throttle.begin()) return tooMany();
          begun = true;
          let body: { password?: unknown } = {};
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            // corpo inválido: senha vazia, recusada abaixo
          }
          const password = typeof body.password === 'string' ? body.password : '';
          if (!(await verify(password, deps.config.passwordHash))) return sendJson(res, 401, { error: tr('Senha incorreta.') });
          ok = deps.sessions.confirm(token);
          if (ok) sendJson(res, 200, { ok: true });
          else sendJson(res, 401, { error: tr('sessão encerrada: entre de novo') });
        })
        .catch(() => {
          if (!res.headersSent) sendJson(res, 400, { error: tr('requisição inválida') });
        })
        .finally(() => {
          if (begun) throttle.end(ok);
        });
      return true;
    }
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/http/remote.test.ts` → verde (os testes antigos também).

- [ ] **Step 5: Traduções**:
  - en: `"Senha incorreta.": "Wrong password.",` · `"sessão encerrada: entre de novo": "session ended: sign in again",`
  - es: `"Senha incorreta.": "Contraseña incorrecta.",` · `"sessão encerrada: entre de novo": "sesión cerrada: entra de nuevo",`
  - fr: `"Senha incorreta.": "Mot de passe incorrect.",` · `"sessão encerrada: entre de novo": "session terminée : reconnectez-vous",`

- [ ] **Step 6: Conferir** — `npx vitest run server/http && npm run typecheck && npm run i18n:check` → verdes.

- [ ] **Step 7: Commit**

```bash
git add server/http/remote.ts server/http/remote.test.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Acesso remoto: capacidade pty e senha conferida há pouco (/api/remote/confirm)"
```

---

### Task 4: C2 — listener da tailnet (`server/http/tailnet.ts`)

**Files:**
- Create: `server/http/tailnet.ts`
- Test: `server/http/tailnet.test.ts`
- Modify: `server/config.ts` (`ServerConfig.tailnet`, `tailnetWarning`)
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `safeEqual` de `server/http/remote.ts`.
- Produces (`server/http/tailnet.ts`):
  `DEFAULT_TAILNET_PORT = 4749`; `TAILNET_HOST = '127.0.0.1'`; `interface TailnetConfig { port: number; user: string }`
  (user em minúsculas); `parseTailnetConfig(env: NodeJS.ProcessEnv, inDocker: boolean, remoteOn: boolean): { config?: TailnetConfig; warning?: string }`;
  `isTailnetRequest(req: IncomingMessage): boolean`; `createTailnetGate(cfg: Pick<TailnetConfig, 'user'>): (req, res) => boolean`
  (true = já respondeu 403); `startTailnetListener(port: number, onRequest, log: { error(m: string): void }): http.Server`;
  `ptyNeedsConfirm(method: string, path: string): boolean`.
- Produces (`server/config.ts`): `ServerConfig.tailnet?: TailnetConfig`, `ServerConfig.tailnetWarning?: string`.

- [ ] **Step 1: Testes (falhando)** — `server/http/tailnet.test.ts` (a Task 5 acrescenta mais casos neste arquivo):

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { createTailnetGate, DEFAULT_TAILNET_PORT, isTailnetRequest, parseTailnetConfig, ptyNeedsConfirm, startTailnetListener } from './tailnet';

setQuiet(true);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function listen(server: http.Server): Promise<string> {
  return new Promise((ok) => {
    const done = () => {
      closers.push(() => new Promise<void>((c) => server.close(() => c())));
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    };
    if (server.listening) done();
    else server.once('listening', done);
  });
}

describe('porta da tailnet: configuração', () => {
  it('desligada sem HABBLAUD_TAILNET_USER', () => {
    expect(parseTailnetConfig({}, false, true)).toEqual({});
  });
  it('liga com o usuário (em minúsculas) e a porta padrão; porta inválida volta ao padrão', () => {
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: ' Ana@Example.com ' }, false, true)).toEqual({ config: { port: DEFAULT_TAILNET_PORT, user: 'ana@example.com' } });
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_TAILNET_PORT: '5000' }, false, true).config?.port).toBe(5000);
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_TAILNET_PORT: '99999' }, false, true).config?.port).toBe(DEFAULT_TAILNET_PORT);
  });
  it('no Docker e sem o acesso remoto com login: desligada, com o motivo', () => {
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b' }, true, true)).toEqual({ warning: expect.stringMatching(/Docker/) });
    expect(parseTailnetConfig({ HABBLAUD_TAILNET_USER: 'a@b' }, false, false)).toEqual({ warning: expect.stringMatching(/remote:setup/) });
  });
});

describe('porta da tailnet: escuta e cabeçalho do Tailscale', () => {
  it('escuta só em 127.0.0.1; sem o cabeçalho ou com outro usuário: 403; o usuário certo (qualquer caixa) passa e fica marcado', async () => {
    const gate = createTailnetGate({ user: 'ana@example.com' });
    const marked: boolean[] = [];
    const server = startTailnetListener(
      0,
      (req, res) => {
        if (gate(req, res)) return;
        marked.push(isTailnetRequest(req));
        res.writeHead(200);
        res.end('ok');
      },
      { error: () => {} },
    );
    const base = await listen(server);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    const status = (headers: Record<string, string>) => fetch(`${base}/api/health`, { headers }).then((r) => r.status);
    expect(await status({})).toBe(403);
    expect(await status({ 'Tailscale-User-Login': 'bob@example.com' })).toBe(403);
    expect(await status({ 'Tailscale-User-Login': '' })).toBe(403);
    expect(await status({ 'Tailscale-User-Login': 'Ana@Example.com' })).toBe(200);
    expect(marked).toEqual([true]);
  });

  it('ptyNeedsConfirm: abrir, assumir, encerrar e o stream; a lista, digitar, redimensionar e fechar não', () => {
    expect(ptyNeedsConfirm('POST', '/api/pty')).toBe(true);
    expect(ptyNeedsConfirm('POST', '/api/agents/acc%3A1/takeover')).toBe(true);
    expect(ptyNeedsConfirm('POST', '/api/agents/acc%3A1/stop')).toBe(true);
    expect(ptyNeedsConfirm('GET', '/api/pty/p1/stream')).toBe(true);
    expect(ptyNeedsConfirm('GET', '/api/pty')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/input')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/resize')).toBe(false);
    expect(ptyNeedsConfirm('POST', '/api/pty/p1/close')).toBe(false);
  });
});
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/http/tailnet.test.ts` → falha (módulo não existe).

- [ ] **Step 3: `server/http/tailnet.ts`**

```ts
// Terceira porta (Fase 5, C2): o terminal interativo pelo iPhone, só pela tailnet.
//
// Escuta HTTP puro e SÓ em 127.0.0.1 (HABBLAUD_TAILNET_PORT, padrão 4749): ninguém da rede local alcança. Quem publica
// é o `tailscale serve --bg --https=8443 http://127.0.0.1:4749`, com o TLS e o nome .ts.net, e que põe em cada pedido
// de um usuário da tailnet o cabeçalho Tailscale-User-Login (o que vier do cliente ele descarta). Toda requisição aqui
// precisa desse cabeçalho igual a HABBLAUD_TAILNET_USER; depois passa pelo mesmo login da porta do celular
// (http/remote.ts) e vira "remota" (o que é só do computador continua recusado). Só aqui o terminal interativo vale,
// com `pty` em HABBLAUD_REMOTE_ALLOW e, para abrir/assumir/encerrar, a senha conferida há menos de 10 min.
// Um processo do próprio Mac consegue imitar o cabeçalho, mas ainda precisa da senha, e esse processo já teria a 4747.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { safeEqual } from './remote';

export const DEFAULT_TAILNET_PORT = 4749;
export const TAILNET_HOST = '127.0.0.1';

export interface TailnetConfig {
  port: number;
  /** Login do Tailscale liberado (minúsculas). */
  user: string;
}

export function parseTailnetConfig(env: NodeJS.ProcessEnv, inDocker: boolean, remoteOn: boolean): { config?: TailnetConfig; warning?: string } {
  const user = env.HABBLAUD_TAILNET_USER?.trim().toLowerCase() ?? '';
  if (!user) return {};
  if (inDocker) return { warning: tr('porta da tailnet desligada: indisponível no Docker (rode com npm start)') };
  if (!remoteOn) return { warning: tr('porta da tailnet desligada: precisa do acesso remoto com login (npm run remote:setup)') };
  const raw = Number.parseInt(env.HABBLAUD_TAILNET_PORT ?? '', 10);
  return { config: { port: Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_TAILNET_PORT, user } };
}

/** Requisições que chegaram pela porta da tailnet com o usuário do Tailscale conferido. */
const tailnetRequests = new WeakSet<IncomingMessage>();

export function isTailnetRequest(req: IncomingMessage): boolean {
  return tailnetRequests.has(req);
}

/** Antes do login: confere o usuário que o tailscale serve pôs no pedido. Devolve true quando já respondeu (403). */
export function createTailnetGate(cfg: Pick<TailnetConfig, 'user'>): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const raw = req.headers['tailscale-user-login'];
    const login = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (login && safeEqual(login, cfg.user)) {
      tailnetRequests.add(req);
      return false;
    }
    req.resume();
    const body = `${tr('Só pela tailnet, com o usuário liberado em HABBLAUD_TAILNET_USER.')}\n`;
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  };
}

export function startTailnetListener(
  port: number,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  log: { error(m: string): void },
): http.Server {
  const server = http.createServer(onRequest);
  server.on('error', (err) => log.error(tr('Porta da tailnet: não deu para escutar em {0}:{1} ({2}).', [TAILNET_HOST, port, (err as Error).message])));
  server.listen(port, TAILNET_HOST);
  return server;
}

/** Abrir, assumir, encerrar e ligar a tela (stream) pedem a senha conferida há pouco; a lista e as teclas, não. */
export function ptyNeedsConfirm(method: string, path: string): boolean {
  if (method === 'POST') return path === '/api/pty' || /^\/api\/agents\/[^/]+\/(stop|takeover)$/.test(path);
  return method === 'GET' && /^\/api\/pty\/[^/]+\/stream$/.test(path);
}
```

- [ ] **Step 4: Configuração** — em `server/config.ts`: `import { parseTailnetConfig, type TailnetConfig } from './http/tailnet';`;
  no `ServerConfig`, depois de `remoteWarning`:

```ts
  /** Terceira porta, só pela tailnet, para o terminal interativo no celular (http/tailnet.ts); ausente = desligada. */
  tailnet?: TailnetConfig;
  /** Por que a porta da tailnet ficou desligada com HABBLAUD_TAILNET_USER definido. */
  tailnetWarning?: string;
```

  e em `loadConfig`, depois de `const remote = parseRemoteConfig(env, inDocker);`:
  `const tailnet = parseTailnetConfig(env, inDocker, !!remote.config);` e no objeto devolvido, depois de
  `remoteWarning: remote.warning,`: `tailnet: tailnet.config, tailnetWarning: tailnet.warning,`.

- [ ] **Step 5: Ver passar** — `npx vitest run server/http/tailnet.test.ts && npm run typecheck` → verdes.

- [ ] **Step 6: Traduções**:
  - en:
    - `"porta da tailnet desligada: indisponível no Docker (rode com npm start)": "tailnet port off: not available in Docker (run with npm start)",`
    - `"porta da tailnet desligada: precisa do acesso remoto com login (npm run remote:setup)": "tailnet port off: it needs remote access with login (npm run remote:setup)",`
    - `"Só pela tailnet, com o usuário liberado em HABBLAUD_TAILNET_USER.": "Only through the tailnet, with the user allowed in HABBLAUD_TAILNET_USER.",`
    - `"Porta da tailnet: não deu para escutar em {0}:{1} ({2}).": "Tailnet port: couldn't listen on {0}:{1} ({2}).",`
  - es:
    - `"porta da tailnet desligada: indisponível no Docker (rode com npm start)": "puerto de la tailnet desactivado: no disponible en Docker (ejecuta con npm start)",`
    - `"porta da tailnet desligada: precisa do acesso remoto com login (npm run remote:setup)": "puerto de la tailnet desactivado: necesita el acceso remoto con login (npm run remote:setup)",`
    - `"Só pela tailnet, com o usuário liberado em HABBLAUD_TAILNET_USER.": "Solo por la tailnet, con el usuario permitido en HABBLAUD_TAILNET_USER.",`
    - `"Porta da tailnet: não deu para escutar em {0}:{1} ({2}).": "Puerto de la tailnet: no se pudo escuchar en {0}:{1} ({2}).",`
  - fr:
    - `"porta da tailnet desligada: indisponível no Docker (rode com npm start)": "port du tailnet désactivé : indisponible dans Docker (lancez avec npm start)",`
    - `"porta da tailnet desligada: precisa do acesso remoto com login (npm run remote:setup)": "port du tailnet désactivé : il faut l'accès à distance avec connexion (npm run remote:setup)",`
    - `"Só pela tailnet, com o usuário liberado em HABBLAUD_TAILNET_USER.": "Uniquement via le tailnet, avec l'utilisateur autorisé dans HABBLAUD_TAILNET_USER.",`
    - `"Porta da tailnet: não deu para escutar em {0}:{1} ({2}).": "Port du tailnet : impossible d'écouter sur {0}:{1} ({2}).",`

- [ ] **Step 7: Conferir** — `npx vitest run server/http && npm run typecheck && npm run i18n:check` → verdes.

- [ ] **Step 8: Commit**

```bash
git add server/http/tailnet.ts server/http/tailnet.test.ts server/config.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Porta da tailnet: listener em 127.0.0.1 com o usuário do Tailscale conferido"
```

---

### Task 5: C2 — o PTY só pela tailnet (API, `pty.ts` e ligação no servidor)

**Files:**
- Modify: `server/http/app.ts` (`ApiDeps.remote`, bloco do PTY, `/api/health`, `/api/access`)
- Modify: `server/http/pty.ts` (`ptyRequestProblem`, `createPtyRoutes`)
- Modify: `server/index.ts` (sessões e freio compartilhados, terceiro listener, logs, `shutdown`)
- Modify: `shared/types.ts` (`AccessInfo.pty`)
- Test: `server/http/tailnet.test.ts` (casos de ponta a ponta), `server/pty/manager.test.ts` (`ptyRequestProblem`),
  `server/http/remote.test.ts` (o `toEqual` do `/api/access` ganha `pty`)
- Modify: `FORK.md`, `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `isTailnetRequest`, `createTailnetGate`, `startTailnetListener`, `ptyNeedsConfirm` (Task 4);
  `CONFIRM_MS`, `RemoteSessions.confirmedWithin`, `LoginThrottle`, `COOKIE`, `readCookie` (Task 3);
  `config.tailnet`, `config.tailnetWarning` (Task 4).
- Produces:
  `ApiDeps.remote?: { is(req): boolean; allows(feature: RemoteFeature): boolean; tailnet?(req): boolean; confirmed?(req): boolean }`;
  PTY remoto só com `tailnet(req) && allows('pty')`; com `ptyNeedsConfirm` e sem `confirmed(req)` → 401
  `{ error, code: 'reauth' }`; `/api/health.pty` e `/api/access.pty` = PTY ligado e utilizável por esta requisição;
  `AccessInfo.pty?: boolean`; `ptyRequestProblem(req: IncomingMessage, tailnet?: boolean): string | null`;
  `createPtyRoutes(ptys: PtyManager, opts?: { tailnet?: (req: IncomingMessage) => boolean })`.

- [ ] **Step 1: Teste do `ptyRequestProblem` (falhando)** — em `server/pty/manager.test.ts`, no `describe('ptyRequestProblem')`:

```ts
  it('pela tailnet: o Host .ts.net vale (o guard já conferiu), mas a conexão segue do loopback e a origem segue a mesma, com a porta', () => {
    expect(ptyRequestProblem(req({ host: 'mac.tail.ts.net:8443', origin: 'https://mac.tail.ts.net:8443', 'sec-fetch-site': 'same-origin' }), true)).toBeNull();
    expect(ptyRequestProblem(req({ host: 'mac.tail.ts.net:8443' }), false)).toMatch(/localhost/);
    // A página da 443 (outra origem) não manda no terminal da 8443.
    expect(ptyRequestProblem(req({ host: 'mac.tail.ts.net:8443', origin: 'https://mac.tail.ts.net' }), true)).toMatch(/origem/);
    expect(ptyRequestProblem(req({ host: 'mac.tail.ts.net:8443' }, '100.64.0.2'), true)).toMatch(/próprio computador/);
    expect(ptyRequestProblem(req({}), true)).not.toBeNull();
  });
```

- [ ] **Step 2: Testes de ponta a ponta (falhando)** — em `server/http/tailnet.test.ts`, acrescentar aos imports:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AccountsService } from '../accounts/service';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { hashPassword, parsePasswordHash } from '../remote/password';
import { tempDir } from '../test/fixtures';
import { createApiHandler, sendJson } from './app';
import { createRequestGuard } from './guard';
import { CONFIRM_MS, COOKIE, createRemoteGate, isRemoteRequest, LoginThrottle, readCookie, RemoteSessions, type RemoteFeature } from './remote';
import { Hub } from './sse';
```

  e no fim do arquivo:

```ts
const SECRET = Buffer.alloc(32, 9);
const PASSWORD = 'senha do terminal';
const HASH_TEXT = await hashPassword(PASSWORD, 10);
const CFG = { user: 'ana', passwordHash: parsePasswordHash(HASH_TEXT)!, passwordHashText: HASH_TEXT };
const TS_HOST = 'mac.tail.ts.net:8443';
const TS = { Host: TS_HOST, 'Tailscale-User-Login': 'ana@example.com' };

/** Porta do celular na rede (LAN) e porta da tailnet sobre a MESMA API, sessões e freio, como no server/index.ts. */
async function start(allow: RemoteFeature[]) {
  let clock = Date.now();
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10, canAnswer: () => false });
  hub.start();
  const allowSet = new Set(allow);
  const sessions = new RemoteSessions(SECRET, CFG, () => clock);
  const throttle = new LoginThrottle(() => clock);
  const ptyCalls: string[] = [];
  const ok = (req: http.IncomingMessage, res: http.ServerResponse) => {
    req.resume();
    sendJson(res, 200, { ok: true });
  };
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    terminal: true,
    permissions: ok,
    messages: ok,
    world: (req, res) => ok(req, res),
    pty: (req, res, path) => {
      ptyCalls.push(`${req.method} ${path}`);
      ok(req, res);
    },
    remote: {
      is: isRemoteRequest,
      allows: (f) => allowSet.has(f),
      tailnet: isTailnetRequest,
      confirmed: (req) => sessions.confirmedWithin(readCookie(req.headers.cookie, COOKIE), CONFIRM_MS),
    },
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['mac.tail.ts.net']) });
  const lanGate = createRemoteGate({ config: CFG, sessions, secure: false, throttle });
  const tsGate = createRemoteGate({ config: CFG, sessions, secure: true, throttle });
  const tailnetGate = createTailnetGate({ user: 'ana@example.com' });
  const page = (res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Habblaud</title>');
  };
  const lan = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (lanGate(req, res, url)) return;
    if (!api(req, res, url)) page(res);
  });
  lan.listen(0, '127.0.0.1');
  const tailnet = startTailnetListener(
    0,
    (req, res) => {
      if (guard(req, res)) return;
      if (tailnetGate(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      if (tsGate(req, res, url)) return;
      if (!api(req, res, url)) page(res);
    },
    { error: () => {} },
  );
  const lanBase = await listen(lan);
  const tsBase = await listen(tailnet);
  closers.push(async () => {
    hub.stop();
    tmp.cleanup();
  });
  return { lanBase, tsBase, ptyCalls, advance: (ms: number) => void (clock += ms) };
}

/** Requisição crua (o fetch do Node não deixa trocar o Host). */
function request(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, fail) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

async function login(base: string, headers: Record<string, string> = {}): Promise<{ cookie: string; setCookie: string }> {
  const r = await request(base, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: PASSWORD }, headers });
  expect(r.status).toBe(200);
  const setCookie = r.headers['set-cookie']?.[0] ?? '';
  return { cookie: setCookie.split(';')[0], setCookie };
}

const PTY_ROUTES: Array<[string, string]> = [
  ['GET', '/api/pty'],
  ['POST', '/api/pty'],
  ['POST', '/api/pty/p1/input'],
  ['GET', '/api/pty/p1/stream'],
  ['POST', '/api/agents/a1/takeover'],
  ['POST', '/api/agents/a1/stop'],
];
const call = (base: string, [method, path]: [string, string], headers: Record<string, string>) =>
  request(base, path, { method, headers, ...(method === 'POST' ? { body: {} } : {}) });

describe('terminal interativo: LAN x tailnet', () => {
  it('LAN (4748) logado com pty liberado: o terminal interativo continua recusado (403) e health/access dizem pty false', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.lanBase);
    for (const r of PTY_ROUTES) expect((await call(s.lanBase, r, { Cookie: cookie })).status, r.join(' ')).toBe(403);
    expect(s.ptyCalls).toEqual([]);
    expect(JSON.parse((await request(s.lanBase, '/api/health', { headers: { Cookie: cookie } })).body).pty).toBe(false);
    expect(JSON.parse((await request(s.lanBase, '/api/access', { headers: { Cookie: cookie } })).body).pty).toBe(false);
  });

  it('tailnet sem o cabeçalho do Tailscale: 403 em tudo, até no login e na página', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/health', { headers: { Host: TS_HOST } })).status).toBe(403);
    expect((await request(s.tsBase, '/login', { headers: { Host: TS_HOST } })).status).toBe(403);
    expect((await request(s.tsBase, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: PASSWORD }, headers: { Host: TS_HOST } })).status).toBe(403);
  });

  it('tailnet com outro usuário do Tailscale: 403', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/health', { headers: { ...TS, 'Tailscale-User-Login': 'bob@example.com' } })).status).toBe(403);
  });

  it('tailnet sem login: API 401 e a página vai para /login', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    expect((await request(s.tsBase, '/api/pty', { headers: TS })).status).toBe(401);
    const page = await request(s.tsBase, '/', { headers: TS });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
  });

  it('tailnet logado sem pty liberado: terminal interativo 403; o resto liberado funciona', async () => {
    const s = await start(['permissions', 'terminal']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    for (const r of PTY_ROUTES) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(403);
    expect((await request(s.tsBase, '/api/snapshot', { headers: h })).status).toBe(200);
    expect(JSON.parse((await request(s.tsBase, '/api/access', { headers: h })).body)).toMatchObject({ remote: true, terminal: true, pty: false });
  });

  it('tailnet logado com pty: lista, abre, assume, liga a tela e digita (200); health e access dizem pty true', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    for (const r of PTY_ROUTES) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(200);
    expect(s.ptyCalls).toEqual(PTY_ROUTES.map(([m, p]) => `${m} ${p}`));
    expect(JSON.parse((await request(s.tsBase, '/api/health', { headers: h })).body).pty).toBe(true);
    expect(JSON.parse((await request(s.tsBase, '/api/access', { headers: h })).body).pty).toBe(true);
  });

  it('senha conferida há mais de 10 min: abrir, assumir, encerrar e a tela pedem a senha (401 reauth); a lista e digitar não; confirmar libera', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    s.advance(CONFIRM_MS + 1);
    for (const r of [PTY_ROUTES[1], PTY_ROUTES[3], PTY_ROUTES[4], PTY_ROUTES[5]]) {
      const res = await call(s.tsBase, r, h);
      expect(res.status, r.join(' ')).toBe(401);
      expect(JSON.parse(res.body).code).toBe('reauth');
    }
    expect((await call(s.tsBase, PTY_ROUTES[0], h)).status).toBe(200);
    expect((await call(s.tsBase, PTY_ROUTES[2], h)).status).toBe(200);
    expect((await request(s.tsBase, '/api/remote/confirm', { method: 'POST', body: { password: 'errada' }, headers: h })).status).toBe(401);
    expect((await request(s.tsBase, '/api/remote/confirm', { method: 'POST', body: { password: PASSWORD }, headers: h })).status).toBe(200);
    expect((await call(s.tsBase, PTY_ROUTES[1], h)).status).toBe(200);
  });

  it('tailnet: as rotas só do próprio computador, o World e o demo continuam recusados, mesmo logado com tudo', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const h = { ...TS, Cookie: cookie };
    const blocked: Array<[string, string]> = [
      ['POST', '/api/permissions'],
      ['GET', '/api/permissions/p1/wait'],
      ['POST', '/api/mod/inbox'],
      ['POST', '/api/codex/events'],
      ['POST', '/api/codex/bridge/poll'],
      ['POST', '/api/host/files/poll'],
      ['POST', '/api/host/attachments/poll'],
      ['POST', '/api/host/spawn/poll'],
      ['POST', '/api/host/dictation/poll'],
      ['GET', '/api/world/account'],
      ['POST', '/api/demo'],
    ];
    for (const r of blocked) expect((await call(s.tsBase, r, h)).status, r.join(' ')).toBe(403);
  });

  it('login pela tailnet: cookie com Secure (o TLS está no tailscale serve); o login da LAN vale na tailnet (mesmas sessões)', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const ts = await login(s.tsBase, TS);
    expect(ts.setCookie).toMatch(/; Secure/);
    expect(ts.setCookie).toMatch(/HttpOnly/);
    expect(ts.setCookie).toMatch(/SameSite=Strict/);
    const lan = await login(s.lanBase);
    expect((await request(s.tsBase, '/api/snapshot', { headers: { ...TS, Cookie: lan.cookie } })).status).toBe(200);
  });

  it('tailnet: Origin de outro site é barrado pelo guard antes de tudo', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    const { cookie } = await login(s.tsBase, TS);
    const r = await request(s.tsBase, '/api/pty', { method: 'POST', body: {}, headers: { ...TS, Cookie: cookie, Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(s.ptyCalls).toEqual([]);
  });
});
```

- [ ] **Step 3: Ver falhar** — `npx vitest run server/http/tailnet.test.ts server/pty/manager.test.ts` → falham os casos
  com pty pela tailnet (hoje 403 para todo remoto), o 401 reauth, `access.pty` e o `ptyRequestProblem(…, true)`.

- [ ] **Step 4: `AccessInfo`** — em `shared/types.ts`, no `AccessInfo`, depois de `spawn`:

```ts
  /**
   * Pode usar o terminal interativo: na porta local com Host local, ou pela porta da tailnet com `pty` liberado (nunca
   * pela porta do celular na rede). Ausente em servidores antigos.
   */
  pty?: boolean;
```

- [ ] **Step 5: `server/http/app.ts`** —
  1. `import { ptyNeedsConfirm } from './tailnet';`
  2. `ApiDeps.remote` (com o comentário):

```ts
  /**
   * Porta remota com login (http/remote.ts): `is` diz se a requisição chegou por ela (já autenticada); `allows`, o que
   * HABBLAUD_REMOTE_ALLOW libera. Requisição remota nunca vale pelo Host: só pelo que `allows` liberar. `tailnet` diz se
   * ela veio pela porta da tailnet (http/tailnet.ts, a única por onde o terminal interativo vale remoto) e `confirmed`,
   * se a senha foi conferida há menos de 10 min com o cookie dela.
   */
  remote?: { is(req: IncomingMessage): boolean; allows(feature: RemoteFeature): boolean; tailnet?(req: IncomingMessage): boolean; confirmed?(req: IncomingMessage): boolean };
```

  3. Depois de `const denied = ...`:

```ts
  /** Remoto que pode usar o terminal interativo: só pela porta da tailnet e com `pty` liberado. */
  const remotePty = (req: IncomingMessage): boolean => !!deps.remote?.tailnet?.(req) && trusted(req, 'pty');
  /** O que /api/health e /api/access dizem do terminal interativo: local só com Host local (como o pty.ts exige). */
  const ptyUsable = (req: IncomingMessage): boolean => !!deps.pty && (isRemote(req) ? remotePty(req) : isLoopbackHost(req.headers.host));
```

  4. No `/api/health`: trocar as duas linhas do pty por

```ts
          // O terminal interativo (pty) nunca vale pela porta do celular na rede; pela da tailnet, só com `pty`.
          pty: ptyUsable(req),
```

  5. No `/api/access`, depois de `spawn: ...`: `pty: ptyUsable(req),`. Em `server/http/remote.test.ts`, no teste
     `GET /api/access (o que a página pode fazer)`, os dois `toEqual` ganham a chave nova: o da porta remota
     `pty: false`, o da porta local `pty: true` (o harness tem `pty` e Host `127.0.0.1`).
  6. Trocar o bloco do PTY por (a recusa da porta local continua com o `ptyRequestProblem`, como hoje):

```ts
    if (path === '/api/pty' || path.startsWith('/api/pty/') || AGENT_ACTION_ROUTE.test(path)) {
      // Executa comandos na máquina. Pela porta do celular na rede, nunca (o Host e o endereço de quem conecta não bastam:
      // o Tailscale chega pelo loopback e o Host se imita). Pela porta da tailnet (http/tailnet.ts), só com o usuário do
      // Tailscale conferido, `pty` liberado e, para abrir/assumir/encerrar/ligar a tela, a senha conferida há pouco.
      if (isRemote(req) && !remotePty(req)) {
        req.resume();
        sendJson(res, 403, {
          error: deps.remote?.tailnet?.(req)
            ? tr('terminal interativo não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW: pty)')
            : tr('o terminal interativo só pode ser usado no próprio computador'),
        });
      } else if (!deps.pty) sendJson(res, 403, { error: tr('terminal interativo desligado (veja o log do servidor)') });
      else if (isRemote(req) && ptyNeedsConfirm(method, path) && !deps.remote?.confirmed?.(req)) {
        req.resume();
        sendJson(res, 401, { error: tr('confirme a senha para abrir o terminal'), code: 'reauth' });
      } else deps.pty(req, res, path);
      return true;
    }
```

- [ ] **Step 6: `server/http/pty.ts`** —

```ts
/** Motivo da recusa, ou null. `tailnet`: veio pela porta da tailnet (Host .ts.net, já conferido pelo guard). */
export function ptyRequestProblem(req: IncomingMessage, tailnet = false): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return tr('o terminal interativo só pode ser usado no próprio computador');
  const host = req.headers.host;
  if (tailnet ? !host : !isLoopbackHost(host)) return tr('abra o Habblaud por http://localhost para usar o terminal interativo');
  // (o resto da função, Origin e Sec-Fetch-Site, fica igual)
```

  e `createPtyRoutes(ptys: PtyManager, opts: { tailnet?: (req: IncomingMessage) => boolean } = {})`, com
  `const problem = ptyRequestProblem(req, !!opts.tailnet?.(req));` no `handle`. Atualizar o comentário do topo:
  "só conexões do próprio computador (o tailscale serve também conecta pelo loopback), com Host local — ou o nome da
  tailnet, na porta da tailnet — e (quando o navegador manda) Origin da mesma origem".

- [ ] **Step 7: Ver passar** — `npx vitest run server/http server/pty` → verde (inclusive `remote.test.ts`, que espera
  403 no PTY pela porta remota e `health.pty === false`).

- [ ] **Step 8: Ligar no servidor (`server/index.ts`)** —
  1. Imports: `import { CONFIRM_MS, COOKIE, createRemoteGate, isRemoteRequest, loadSecret, LoginThrottle, readCookie, RemoteSessions, startRemoteListener, type RemoteListener } from './http/remote';`
     e `import { createTailnetGate, isTailnetRequest, startTailnetListener } from './http/tailnet';`
  2. Antes de `const api = createApiHandler({`:

```ts
// Sessões e freio do login: os mesmos na porta do celular (4748) e na da tailnet (4749). O login numa vale na outra
// (cookies não separam portas) e as tentativas de senha somam.
const remoteSessions = config.remote
  ? new RemoteSessions(loadSecret(join(config.dataDir, 'remote-secret')), config.remote, Date.now, join(config.dataDir, 'remote-revoked.json'))
  : undefined;
const loginThrottle = new LoginThrottle();
```

  3. No `createApiHandler`: `pty: ptys ? createPtyRoutes(ptys, { tailnet: isTailnetRequest }) : undefined,` e

```ts
  remote: config.remote
    ? {
        is: isRemoteRequest,
        allows: (f) => config.remote!.allow.has(f),
        tailnet: isTailnetRequest,
        confirmed: (req) => !!remoteSessions?.confirmedWithin(readCookie(req.headers.cookie, COOKIE), CONFIRM_MS),
      }
    : undefined,
```

  4. No bloco da porta remota: `sessions: remoteSessions!,` (no lugar do `new RemoteSessions(...)`) e
     `throttle: loginThrottle,`. Dentro do `once('listening')`, depois do aviso do spawn:

```ts
    if (remote.allow.has('pty') && !config.tailnet) log.warn(tr('   Acesso remoto: "pty" liberado, mas o terminal interativo só vale pela porta da tailnet (defina HABBLAUD_TAILNET_USER).'));
```

  5. Depois do bloco da porta remota (antes do `server.listen`):

```ts
/**
 * Porta da tailnet (http/tailnet.ts): só 127.0.0.1, publicada pelo `tailscale serve --https=8443`. Usuário do Tailscale
 * conferido antes de tudo; depois o mesmo login da porta do celular, com cookie Secure (para o navegador é HTTPS).
 */
let tailnetServer: http.Server | undefined;
if (config.tailnet && config.remote && remoteSessions) {
  const tailnet = config.tailnet;
  const remote = config.remote;
  const tailnetGate = createTailnetGate(tailnet);
  const gate = createRemoteGate({ config: remote, sessions: remoteSessions, secure: true, caFile: remote.tls?.caFile, throttle: loginThrottle });
  tailnetServer = startTailnetListener(
    tailnet.port,
    (req, res) => {
      const url = parseUrl(req);
      try {
        if (guard(req, res)) return;
        if (tailnetGate(req, res)) return;
        if (gate(req, res, url)) return;
        if (!api(req, res, url)) fallback(req, res, url);
      } catch (err) {
        log.warn(tr('Erro ao responder (tailnet) {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
        else res.destroy();
      }
    },
    log,
  );
  tailnetServer.once('listening', () => {
    const pty = !ptys ? tr('desligado ({0})', [ptyOff ?? tr('desligado')]) : remote.allow.has('pty') ? tr('liberado') : tr('não liberado (pty em HABBLAUD_REMOTE_ALLOW)');
    log.info(tr('   Porta da tailnet: ligada em 127.0.0.1:{0}, com login e o usuário do Tailscale; terminal interativo: {1}.', [tailnet.port, pty]));
  });
} else if (config.tailnetWarning) {
  log.warn(`   ${config.tailnetWarning}.`);
}
```

  6. No `shutdown`, depois de `remoteListener?.close();`: `tailnetServer?.close();`

- [ ] **Step 9: Rodada real (sem tocar no Habblaud do Mac)** — num terminal:

```bash
D=$(mktemp -d)
H=$(npx tsx -e "import('./server/remote/password.ts').then(async (m) => console.log(await m.hashPassword('teste-123', 10)))")
HABBLAUD_DATA_DIR=$D HABBLAUD_WORLD=0 HABBLAUD_UPDATE_CHECK=0 HABBLAUD_PORT=4757 \
HABBLAUD_REMOTE_PORT=4758 HABBLAUD_REMOTE_HOST=127.0.0.1 HABBLAUD_REMOTE_TLS_DIR=$D/tls HABBLAUD_REMOTE_INSECURE_HTTP=1 \
HABBLAUD_REMOTE_USER=teste HABBLAUD_REMOTE_PASSWORD_HASH=$H HABBLAUD_REMOTE_ALLOW=permissions,terminal,pty \
HABBLAUD_TAILNET_USER=teste@exemplo.com HABBLAUD_TAILNET_PORT=4759 HABBLAUD_PTY=1 HABBLAUD_ALLOWED_HOSTS=mac.tail.ts.net \
npm run dev
```

  Noutro terminal (mesmo `$D` não é necessário):

```bash
lsof -nP -iTCP:4759 -sTCP:LISTEN                                  # só 127.0.0.1:4759
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4759/api/health                     # 403 (sem cabeçalho)
T=(-H 'Tailscale-User-Login: teste@exemplo.com' -H 'Host: mac.tail.ts.net:8443')
curl -s -o /dev/null -w '%{http_code}\n' "${T[@]}" http://127.0.0.1:4759/api/pty              # 401 (sem login)
C=$(curl -s -D - -o /dev/null "${T[@]}" -H 'Content-Type: application/json' -d '{"user":"teste","password":"teste-123"}' http://127.0.0.1:4759/api/remote/login | sed -n 's/^[Ss]et-[Cc]ookie: \(habblaud_remote=[^;]*\).*/\1/p')
curl -s "${T[@]}" -H "Cookie: $C" http://127.0.0.1:4759/api/health | jq '{remote, pty}'      # {"remote": true, "pty": true}
curl -s "${T[@]}" -H "Cookie: $C" http://127.0.0.1:4759/api/pty | jq '.status'               # {"enabled": true}
C2=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' -d '{"user":"teste","password":"teste-123"}' http://127.0.0.1:4758/api/remote/login | sed -n 's/^[Ss]et-[Cc]ookie: \(habblaud_remote=[^;]*\).*/\1/p')
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: $C2" http://127.0.0.1:4758/api/pty     # 403 (LAN)
```

  O log do `npm run dev` mostra "Porta da tailnet: ligada em 127.0.0.1:4759 … terminal interativo: liberado." Parar
  com Ctrl+C e `rm -rf "$D"`.

- [ ] **Step 10: Traduções**:
  - en:
    - `"terminal interativo não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW: pty)": "interactive terminal not allowed in remote access (see HABBLAUD_REMOTE_ALLOW: pty)",`
    - `"confirme a senha para abrir o terminal": "confirm the password to open the terminal",`
    - `"   Acesso remoto: \"pty\" liberado, mas o terminal interativo só vale pela porta da tailnet (defina HABBLAUD_TAILNET_USER).": "   Remote access: \"pty\" allowed, but the interactive terminal only works through the tailnet port (set HABBLAUD_TAILNET_USER).",`
    - `"Erro ao responder (tailnet) {0} {1}: {2}": "Error answering (tailnet) {0} {1}: {2}",`
    - `"desligado ({0})": "off ({0})",` (conferir antes se já existe)
    - `"liberado": "allowed",` · `"não liberado (pty em HABBLAUD_REMOTE_ALLOW)": "not allowed (pty in HABBLAUD_REMOTE_ALLOW)",`
    - `"   Porta da tailnet: ligada em 127.0.0.1:{0}, com login e o usuário do Tailscale; terminal interativo: {1}.": "   Tailnet port: on at 127.0.0.1:{0}, with login and the Tailscale user; interactive terminal: {1}.",`
  - es:
    - `"terminal interativo não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW: pty)": "terminal interactiva no permitida en el acceso remoto (mira HABBLAUD_REMOTE_ALLOW: pty)",`
    - `"confirme a senha para abrir o terminal": "confirma la contraseña para abrir la terminal",`
    - `"   Acesso remoto: \"pty\" liberado, mas o terminal interativo só vale pela porta da tailnet (defina HABBLAUD_TAILNET_USER).": "   Acceso remoto: \"pty\" permitido, pero la terminal interactiva solo funciona por el puerto de la tailnet (define HABBLAUD_TAILNET_USER).",`
    - `"Erro ao responder (tailnet) {0} {1}: {2}": "Error al responder (tailnet) {0} {1}: {2}",`
    - `"desligado ({0})": "desactivado ({0})",`
    - `"liberado": "permitido",` · `"não liberado (pty em HABBLAUD_REMOTE_ALLOW)": "no permitido (pty en HABBLAUD_REMOTE_ALLOW)",`
    - `"   Porta da tailnet: ligada em 127.0.0.1:{0}, com login e o usuário do Tailscale; terminal interativo: {1}.": "   Puerto de la tailnet: activo en 127.0.0.1:{0}, con login y el usuario de Tailscale; terminal interactiva: {1}.",`
  - fr:
    - `"terminal interativo não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW: pty)": "terminal interactif non autorisé dans l'accès à distance (voir HABBLAUD_REMOTE_ALLOW : pty)",`
    - `"confirme a senha para abrir o terminal": "confirmez le mot de passe pour ouvrir le terminal",`
    - `"   Acesso remoto: \"pty\" liberado, mas o terminal interativo só vale pela porta da tailnet (defina HABBLAUD_TAILNET_USER).": "   Accès à distance : « pty » autorisé, mais le terminal interactif ne fonctionne que via le port du tailnet (définissez HABBLAUD_TAILNET_USER).",`
    - `"Erro ao responder (tailnet) {0} {1}: {2}": "Erreur de réponse (tailnet) {0} {1} : {2}",`
    - `"desligado ({0})": "désactivé ({0})",`
    - `"liberado": "autorisé",` · `"não liberado (pty em HABBLAUD_REMOTE_ALLOW)": "non autorisé (pty dans HABBLAUD_REMOTE_ALLOW)",`
    - `"   Porta da tailnet: ligada em 127.0.0.1:{0}, com login e o usuário do Tailscale; terminal interativo: {1}.": "   Port du tailnet : actif sur 127.0.0.1:{0}, avec connexion et l'utilisateur Tailscale ; terminal interactif : {1}.",`

- [ ] **Step 11: FORK.md** — acrescentar:

```md
## Terminal interativo no iPhone (só pela tailnet)

No `.env`: `HABBLAUD_TAILNET_USER=<login do Tailscale>` e `pty` em `HABBLAUD_REMOTE_ALLOW`. O Habblaud abre a porta
`127.0.0.1:4749` (`HABBLAUD_TAILNET_PORT`), que o Tailscale publica com HTTPS:

    tailscale serve --bg --https=8443 http://127.0.0.1:4749     # desligar: tailscale serve --https=8443 off

No iPhone: `https://<mac>.<tailnet>.ts.net:8443` (o mesmo login da 443). Abrir, assumir ou encerrar um terminal pede a
senha de novo quando a última conferência passou de 10 min. Pela rede local (4748) o terminal interativo continua
recusado.
```

- [ ] **Step 12: Conferir** — `npm run typecheck && npx vitest run server && npm run i18n:check` → verdes.

- [ ] **Step 13: Commit**

```bash
git add server/http/app.ts server/http/pty.ts server/index.ts shared/types.ts server/http/tailnet.test.ts server/http/remote.test.ts server/pty/manager.test.ts FORK.md shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Terminal interativo pela porta da tailnet, com usuário do Tailscale, pty e senha recente"
```

---

### Task 6: C2 — cliente: acesso `pty` e a senha de novo

**Files:**
- Modify: `client/src/net/access.ts` (`canUsePty`) + `client/src/net/access.test.ts`
- Create: `client/src/ui/reauth.ts`, `client/src/ui/reauth.test.ts`
- Modify: `client/src/ui/ptyapi.ts` (`postPty` lança `ReauthError`)
- Modify: `client/src/ui/ptypane.ts` (stream recusado avisa o painel; `notice`)
- Modify: `client/src/ui/pty.ts` (`enabled`, `reason`, ações com `withReauth`, senha antes de ligar a tela)
- Modify: `client/src/ui/styles.css`, `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `AccessInfo.pty` (Task 5); `GET|POST /api/remote/confirm` (Task 3); 401 `{code: 'reauth'}` (Task 5).
- Produces:
  `canUsePty(a?: AccessInfo): boolean` (`a.pty ?? a.local`);
  `class ReauthError extends Error`; `isReauth(status: number, body: unknown): boolean`;
  `confirmPassword(password: string, fetchImpl?: typeof fetch): Promise<string>` ('' = aceita);
  `confirmedRecently(fetchImpl?: typeof fetch): Promise<boolean>`;
  `withReauth<T>(fn: () => Promise<T>, ask?: () => Promise<boolean>): Promise<T | undefined>`;
  `askPassword(): Promise<boolean>`;
  `new PtyPane(onExit: () => void, onDenied: () => void)`; `PtyPane.notice(text: string): void`.

- [ ] **Step 1: Testes (falhando)** — em `client/src/net/access.test.ts`: `canUsePty` no import e

```ts
  it('terminal interativo: vale o pty do servidor; servidor antigo (sem pty): só a página local', () => {
    expect(canUsePty({ remote: true, local: false, permissions: true, messages: true, terminal: true, spawn: false, pty: true })).toBe(true);
    expect(canUsePty({ remote: true, local: false, permissions: true, messages: true, terminal: true, spawn: false, pty: false })).toBe(false);
    expect(canUsePty(fallbackAccess('localhost'))).toBe(true);
    expect(canUsePty(fallbackAccess('192.168.1.10'))).toBe(false);
  });
```

  e `client/src/ui/reauth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { confirmedRecently, confirmPassword, isReauth, ReauthError, withReauth } from './reauth';

const reply = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('senha de novo (terminal pelo celular)', () => {
  it('isReauth: só o 401 com code reauth', () => {
    expect(isReauth(401, { code: 'reauth' })).toBe(true);
    expect(isReauth(401, { error: 'faça login' })).toBe(false);
    expect(isReauth(403, { code: 'reauth' })).toBe(false);
    expect(isReauth(401, null)).toBe(false);
  });

  it('withReauth: pede a senha e tenta mais uma vez; cancelou = undefined; outro erro passa', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new ReauthError('confirme');
      return 'ok';
    };
    expect(await withReauth(fn, async () => true)).toBe('ok');
    expect(calls).toBe(2);
    calls = 0;
    expect(await withReauth(fn, async () => false)).toBeUndefined();
    expect(calls).toBe(1);
    await expect(withReauth(async () => Promise.reject(new Error('rede')), async () => true)).rejects.toThrow('rede');
  });

  it('confirmPassword: aceita, senha errada (mensagem do servidor), sem rede', async () => {
    expect(await confirmPassword('x', reply(200, { ok: true }))).toBe('');
    expect(await confirmPassword('x', reply(401, { error: 'Senha incorreta.' }))).toBe('Senha incorreta.');
    expect(await confirmPassword('x', (() => Promise.reject(new Error('rede'))) as unknown as typeof fetch)).toBe('o Habblaud não respondeu');
  });

  it('confirmedRecently: só com fresh true', async () => {
    expect(await confirmedRecently(reply(200, { fresh: true }))).toBe(true);
    expect(await confirmedRecently(reply(200, { fresh: false }))).toBe(false);
    expect(await confirmedRecently(reply(401, {}))).toBe(false);
  });
});
```

- [ ] **Step 2: Ver falhar** — `npx vitest run client/src/net/access.test.ts client/src/ui/reauth.test.ts` → falham
  (`canUsePty` e `reauth.ts` não existem).

- [ ] **Step 3: `canUsePty`** — em `client/src/net/access.ts`, depois de `access()`:

```ts
/** Pode usar o terminal interativo nesta página? O servidor diz (`pty`); servidor antigo: só a página local. */
export function canUsePty(a: AccessInfo = access()): boolean {
  return a.pty ?? a.local;
}
```

- [ ] **Step 4: `client/src/ui/reauth.ts`**

```ts
// Senha de novo antes de abrir, assumir ou encerrar um terminal interativo pelo celular (Fase 5, C2). O servidor
// responde 401 {code: 'reauth'} quando a última conferência da senha passou de 10 min (server/http/app.ts); aqui a
// pessoa digita a senha num <dialog> e o pedido é refeito uma vez. O EventSource da tela não lê o 401: quem liga a
// tela pergunta antes (confirmedRecently).
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';

export class ReauthError extends Error {}

export function isReauth(status: number, body: unknown): boolean {
  return status === 401 && !!body && (body as { code?: unknown }).code === 'reauth';
}

/** POST /api/remote/confirm: '' quando a senha foi aceita; senão, o motivo. */
export async function confirmPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl('/api/remote/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ password }),
    });
    if (res.ok) return '';
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? tr('erro {0}', [res.status]);
  } catch {
    return tr('o Habblaud não respondeu');
  }
}

/** GET /api/remote/confirm: a senha foi conferida há menos de 10 min? Sem resposta: false (pergunta de novo). */
export async function confirmedRecently(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/remote/confirm', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok && ((await res.json()) as { fresh?: unknown }).fresh === true;
  } catch {
    return false;
  }
}

/** Roda `fn`; se o servidor pedir a senha, pergunta (`ask`) e tenta mais uma vez. Cancelou: undefined. */
export async function withReauth<T>(fn: () => Promise<T>, ask: () => Promise<boolean> = askPassword): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ReauthError)) throw err;
    if (!(await ask())) return undefined;
    return fn();
  }
}

let asking: Promise<boolean> | null = null;

/** Diálogo da senha: true quando o servidor aceitou, false se a pessoa cancelou. Um por vez. */
export function askPassword(): Promise<boolean> {
  asking ??= new Promise<boolean>((done) => {
    const input = h('input', { class: 'ui-reauth__input', attrs: { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': tr('Senha') } });
    const err = h('p', { class: 'ui-reauth__err', role: 'alert', hidden: true });
    const ok = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: tr('Confirmar') });
    const cancel = h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar') });
    const form = h(
      'form',
      { class: 'ui-reauth' },
      h('h2', { class: 'ui-reauth__title', text: tr('Confirme a senha') }),
      h('p', { class: 'ui-muted ui-small', text: tr('Para abrir o terminal pelo celular, digite de novo a senha do acesso remoto. Vale por 10 min.') }),
      input,
      err,
      h('div', { class: 'ui-reauth__actions' }, cancel, ok),
    );
    const dialog = h('dialog', { class: 'ui-reauth-dialog' }, form);
    const finish = (accepted: boolean) => {
      dialog.close();
      dialog.remove();
      asking = null;
      done(accepted);
    };
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    // As teclas do diálogo não vão para os atalhos do escritório.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ok.disabled = true;
      void confirmPassword(input.value).then((problem) => {
        ok.disabled = false;
        if (!problem) return finish(true);
        setText(err, problem);
        setHidden(err, false);
        input.select();
      });
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
  return asking;
}
```

- [ ] **Step 5: Ver passar** — `npx vitest run client/src/net/access.test.ts client/src/ui/reauth.test.ts` → verde.

- [ ] **Step 6: `ptyapi.ts`** — `import { isReauth, ReauthError } from './reauth';` e em `postPty`:

```ts
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (isReauth(res.status, j)) throw new ReauthError(j.error ?? tr('confirme a senha para abrir o terminal'));
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
```

- [ ] **Step 7: `ptypane.ts`** — o construtor vira `constructor(private onExit: () => void, private onDenied: () => void)`;
  em `attach`, depois do `addEventListener('exit', ...)`:

```ts
    es.onerror = () => {
      // Recusado (401 da senha vencida, 403, 404): o EventSource desiste sozinho (CLOSED) e não diz o status.
      if (es.readyState === EventSource.CLOSED && this.es === es && !this.exited) {
        this.es = null;
        this.onDenied();
      }
    };
```

  e o método:

```ts
  /** Aviso apagado na tela (ex.: sem conexão com o terminal). */
  notice(text: string): void {
    this.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
  }
```

- [ ] **Step 8: `pty.ts`** — imports: `import { access, canUsePty } from '../net/access';` e
  `import { askPassword, confirmedRecently, withReauth } from './reauth';`. Trocar:

```ts
  get enabled(): boolean {
    return !!this.ctx.store.snapshot?.meta.pty?.enabled && !this.ctx.store.replaying && canUsePty();
  }

  get reason(): string {
    if (this.ctx.store.replaying) return tr('Sem terminal no timelapse');
    if (this.ctx.store.snapshot?.meta.pty?.enabled && !canUsePty()) return tr('Terminal interativo só no próprio computador ou pela porta da tailnet');
    return this.ctx.store.snapshot?.meta.pty?.reason ?? tr('Terminal interativo desligado');
  }
```

```ts
  async takeover(agentId: string): Promise<void> {
    const p = await withReauth(() => takeoverAgent(agentId));
    if (p) this.show(p, true);
  }

  async newSession(cwd: string, account?: string): Promise<void> {
    const p = await withReauth(() => createPty(cwd, account));
    if (p) this.show(p, true);
  }

  async stop(agentId: string): Promise<void> {
    const done = await withReauth(async () => {
      await stopAgent(agentId);
      return true;
    });
    if (done) this.ctx.announce(tr('Sessão encerrada.'));
  }
```

  em `show`, trocar o `void this.ensurePane().then((pane) => { ... })` por:

```ts
    void this.ensurePane().then(async (pane) => {
      if (this.info?.id !== p.id) return;
      // Pelo celular, ligar a tela pede a senha conferida há pouco (o EventSource não lê o 401): pergunta antes.
      if (access().remote && !(await confirmedRecently()) && !(await askPassword())) return this.close();
      if (this.info?.id !== p.id) return;
      pane.attach(p.id);
      requestAnimationFrame(() => {
        pane.refit(true);
        pane.focus();
      });
    });
```

  em `ensurePane`: `this.pane = new PtyPane(() => this.ctx.invalidate(), () => void this.reopen());` e o método novo:

```ts
  /** A tela do terminal foi recusada: pelo celular com a senha vencida, pede a senha e liga de novo; senão, avisa. */
  private async reopen(): Promise<void> {
    const id = this.info?.id;
    const pane = this.pane;
    if (!id || !pane) return;
    if (access().remote && !(await confirmedRecently()) && (await askPassword()) && this.info?.id === id) return pane.attach(id);
    pane.notice(tr('sem conexão com o terminal'));
  }
```

- [ ] **Step 9: CSS** — no fim de `client/src/ui/styles.css`:

```css
/* Senha de novo para o terminal pelo celular (ui/reauth.ts). */
.ui-reauth-dialog {
  width: min(360px, calc(100vw - 32px));
  padding: 0;
  border: 2px solid var(--ui-line-strong);
  border-radius: var(--radius);
  background: #1e2130;
  color: inherit;
}

.ui-reauth-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
}

.ui-reauth {
  display: grid;
  gap: 10px;
  padding: 20px;
}

.ui-reauth__title {
  margin: 0;
  font-size: 17px;
}

.ui-reauth__input {
  width: 100%;
  padding: 10px;
  font: inherit;
  /* 16px: o iPhone não dá zoom no campo. */
  font-size: 16px;
  color: inherit;
  background: #14161f;
  border: 2px solid var(--ui-line-strong);
  border-radius: 6px;
}

.ui-reauth__err {
  margin: 0;
  color: #ff8a80;
  font-size: 13px;
}

.ui-reauth__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
```

- [ ] **Step 10: Traduções**:
  - en:
    - `"Confirme a senha": "Confirm your password",`
    - `"Para abrir o terminal pelo celular, digite de novo a senha do acesso remoto. Vale por 10 min.": "To open the terminal from your phone, type the remote access password again. It lasts 10 min.",`
    - `"Terminal interativo só no próprio computador ou pela porta da tailnet": "Interactive terminal only on the computer itself or through the tailnet port",`
    - `"sem conexão com o terminal": "no connection to the terminal",`
  - es:
    - `"Confirme a senha": "Confirma la contraseña",`
    - `"Para abrir o terminal pelo celular, digite de novo a senha do acesso remoto. Vale por 10 min.": "Para abrir la terminal desde el móvil, escribe otra vez la contraseña del acceso remoto. Vale 10 min.",`
    - `"Terminal interativo só no próprio computador ou pela porta da tailnet": "Terminal interactiva solo en el propio ordenador o por el puerto de la tailnet",`
    - `"sem conexão com o terminal": "sin conexión con la terminal",`
  - fr:
    - `"Confirme a senha": "Confirmez le mot de passe",`
    - `"Para abrir o terminal pelo celular, digite de novo a senha do acesso remoto. Vale por 10 min.": "Pour ouvrir le terminal depuis le téléphone, saisissez à nouveau le mot de passe de l'accès à distance. Valable 10 min.",`
    - `"Terminal interativo só no próprio computador ou pela porta da tailnet": "Terminal interactif uniquement sur l'ordinateur lui-même ou via le port du tailnet",`
    - `"sem conexão com o terminal": "pas de connexion au terminal",`

- [ ] **Step 11: Conferir** — `npx vitest run client && npm run typecheck && npm run i18n:check` → verdes. Visual no Mac:
  `npm run dev` (com a rodada da Task 5, Step 9, e `HABBLAUD_REMOTE_ALLOW=permissions,terminal,pty`) aberto em
  `http://localhost:4757`: terminal interativo abre sem pedir senha (página local). Para ver o diálogo sem o iPhone:
  no navegador, `http://127.0.0.1:4759` não serve (falta o cabeçalho); o diálogo é conferido ao vivo na Task 12.

- [ ] **Step 12: Commit**

```bash
git add client/src/net/access.ts client/src/net/access.test.ts client/src/ui/reauth.ts client/src/ui/reauth.test.ts client/src/ui/ptyapi.ts client/src/ui/ptypane.ts client/src/ui/pty.ts client/src/ui/styles.css shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Terminal pelo celular: acesso pty e senha de novo quando vencida"
```

---

### Task 7: C2 — barra de teclas do terminal no celular

**Files:**
- Create: `client/src/ui/ptykeys.ts`, `client/src/ui/ptykeys.test.ts`
- Modify: `client/src/ui/ptypane.ts` (Ctrl armado nas teclas digitadas; `keys`)
- Modify: `client/src/ui/pty.ts` (barra embaixo da tela; janela acima do teclado do iPhone)
- Modify: `client/src/ui/styles.css`, `CHANGELOG.md`, `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Produces (`client/src/ui/ptykeys.ts`): `type PtyKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right'`;
  `keySequence(key: PtyKey, appCursor: boolean): string`; `withCtrl(data: string): string`;
  `keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number } | null | undefined): number`;
  `class PtyKeys { el: HTMLElement; constructor(send: (d: string) => void, appCursor: () => boolean, refocus: () => void); apply(data: string): string }`.
  `PtyPane.keys: PtyKeys`.

- [ ] **Step 1: Teste (falhando)** — `client/src/ui/ptykeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keyboardInset, keySequence, withCtrl } from './ptykeys';

describe('teclas do terminal no celular', () => {
  it('Esc, Tab e setas (normal e "application cursor")', () => {
    expect(keySequence('esc', false)).toBe('\x1b');
    expect(keySequence('tab', true)).toBe('\t');
    expect(keySequence('up', false)).toBe('\x1b[A');
    expect(keySequence('down', false)).toBe('\x1b[B');
    expect(keySequence('right', false)).toBe('\x1b[C');
    expect(keySequence('left', false)).toBe('\x1b[D');
    expect(keySequence('up', true)).toBe('\x1bOA');
    expect(keySequence('left', true)).toBe('\x1bOD');
  });

  it('Ctrl: letras (qualquer caixa) e os especiais; o resto passa igual', () => {
    expect(withCtrl('c')).toBe('\x03');
    expect(withCtrl('C')).toBe('\x03');
    expect(withCtrl('d')).toBe('\x04');
    expect(withCtrl('a')).toBe('\x01');
    expect(withCtrl('z')).toBe('\x1a');
    expect(withCtrl('[')).toBe('\x1b');
    expect(withCtrl(' ')).toBe('\x00');
    expect(withCtrl('1')).toBe('1');
    expect(withCtrl('ab')).toBe('ab');
  });

  it('teclado na tela: quanto do fundo ele cobre', () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardInset(800, { height: 500, offsetTop: 20 })).toBe(280);
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, null)).toBe(0);
  });
});
```

- [ ] **Step 2: Ver falhar** — `npx vitest run client/src/ui/ptykeys.test.ts` → falha (módulo não existe).

- [ ] **Step 3: `client/src/ui/ptykeys.ts`**

```ts
// Barra de teclas do terminal interativo no celular (Fase 5, C2): Esc, Tab, Ctrl e setas, que o teclado do iPhone não
// tem. Fica embaixo da tela do terminal, logo acima do teclado; só aparece com tela de toque (CSS, pointer: coarse).
// Ctrl é de um toque: arma, e a próxima tecla digitada vai com Ctrl (Ctrl+C interrompe, Ctrl+D sai...).
import { tr } from '../../../shared/i18n';
import { h } from './dom';

export type PtyKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

const ARROWS: Record<'up' | 'down' | 'right' | 'left', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** O que a tecla manda ao terminal. Setas no modo "application cursor" (DECCKM, usado por TUIs) vão com ESC O. */
export function keySequence(key: PtyKey, appCursor: boolean): string {
  if (key === 'esc') return '\x1b';
  if (key === 'tab') return '\t';
  return `${appCursor ? '\x1bO' : '\x1b['}${ARROWS[key]}`;
}

const CTRL_SPECIAL: Record<string, string> = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f' };

/** Ctrl + o que foi digitado: letras viram o código de controle (Ctrl+C = \x03), e @ [ \ ] ^ _ e espaço também. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toLowerCase();
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  return CTRL_SPECIAL[c] ?? data;
}

/** Quanto do fundo da janela o teclado na tela cobre (visualViewport; sem ele, 0). */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number } | null | undefined): number {
  return vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
}

export class PtyKeys {
  readonly el: HTMLElement;
  private ctrl = false;
  private readonly ctrlBtn: HTMLButtonElement;

  constructor(
    private readonly send: (data: string) => void,
    private readonly appCursor: () => boolean,
    private readonly refocus: () => void,
  ) {
    const key = (label: string, aria: string, k: PtyKey) => this.button(label, aria, () => this.send(keySequence(k, this.appCursor())));
    this.ctrlBtn = this.button('Ctrl', tr('Ctrl: a próxima tecla vai com Ctrl'), () => this.setCtrl(!this.ctrl));
    this.ctrlBtn.setAttribute('aria-pressed', 'false');
    this.el = h(
      'div',
      { class: 'ui-pty__keys', role: 'toolbar', attrs: { 'aria-label': tr('Teclas do terminal') } },
      key('Esc', 'Esc', 'esc'),
      key('Tab', 'Tab', 'tab'),
      this.ctrlBtn,
      key('←', tr('Seta para a esquerda'), 'left'),
      key('↑', tr('Seta para cima'), 'up'),
      key('↓', tr('Seta para baixo'), 'down'),
      key('→', tr('Seta para a direita'), 'right'),
    );
  }

  /** O que foi digitado, com o Ctrl armado aplicado (e desarmado). */
  apply(data: string): string {
    if (!this.ctrl) return data;
    this.setCtrl(false);
    return withCtrl(data);
  }

  private setCtrl(on: boolean): void {
    this.ctrl = on;
    this.ctrlBtn.classList.toggle('is-on', on);
    this.ctrlBtn.setAttribute('aria-pressed', String(on));
  }

  private button(label: string, aria: string, act: () => void): HTMLButtonElement {
    const b = h('button', { class: 'ui-pty__key', type: 'button', text: label, attrs: { 'aria-label': aria } });
    // Sem tirar o foco do terminal: o teclado do iPhone não fecha a cada toque.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      act();
      this.refocus();
    });
    return b;
  }
}
```

- [ ] **Step 4: Ver passar** — `npx vitest run client/src/ui/ptykeys.test.ts` → verde.

- [ ] **Step 5: `ptypane.ts`** — `import { PtyKeys } from './ptykeys';`, campo `readonly keys: PtyKeys;` e no construtor,
  antes do `this.term.onData`:

```ts
    this.keys = new PtyKeys(
      (d) => this.send(d),
      () => this.term.modes.applicationCursorKeysMode,
      () => this.term.focus(),
    );
```

  e trocar `this.term.onData((d) => this.send(d));` por `this.term.onData((d) => this.send(this.keys.apply(d)));`

- [ ] **Step 6: `pty.ts`** — `import { keyboardInset } from './ptykeys';`
  1. Em `ensurePane`, depois de `this.screen.append(this.pane.el);`: `this.screen.after(this.pane.keys.el);`
  2. Em `setMode`, no fim: `if (this.pane) setHidden(this.pane.keys.el, away);`
  3. No fim do construtor (a janela termina em cima do teclado do iPhone):

```ts
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    const fitKeyboard = () => {
      if (this.el.hidden) return;
      this.el.style.setProperty('--ui-pty-kb', `${keyboardInset(window.innerHeight, vv)}px`);
      this.pane?.refit();
    };
    vv?.addEventListener('resize', fitKeyboard);
    vv?.addEventListener('scroll', fitKeyboard);
```

- [ ] **Step 7: CSS** — no fim de `client/src/ui/styles.css`:

```css
/* Barra de teclas do terminal interativo (ui/ptykeys.ts): só com tela de toque. */
.ui-pty__keys {
  display: none;
}

@media (pointer: coarse) {
  .ui-pty__keys {
    display: flex;
    flex: none;
    gap: 6px;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    overflow-x: auto;
    background: #0a0c12;
    border-top: 1px solid var(--ui-line);
  }

  .ui-pty__keys[hidden] {
    display: none;
  }
}

.ui-pty__key {
  flex: none;
  min-width: 44px;
  min-height: 36px;
  padding: 0 10px;
  font: 600 13px/1 ui-monospace, Menlo, monospace;
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--ui-line-strong);
  border-radius: 6px;
  touch-action: manipulation;
}

.ui-pty__key.is-on {
  background: color-mix(in srgb, var(--st-working) 30%, transparent);
  border-color: var(--st-working);
}

/* Celular com o teclado aberto: a janela termina em cima dele (--ui-pty-kb, ui/pty.ts). */
@media (max-width: 600px) {
  .ui-term.ui-pty {
    bottom: var(--ui-pty-kb, 0px);
  }
}
```

- [ ] **Step 8: Traduções**:
  - en: `"Ctrl: a próxima tecla vai com Ctrl": "Ctrl: the next key goes with Ctrl",` · `"Teclas do terminal": "Terminal keys",` ·
    `"Seta para a esquerda": "Left arrow",` · `"Seta para cima": "Up arrow",` · `"Seta para baixo": "Down arrow",` · `"Seta para a direita": "Right arrow",`
  - es: `"Ctrl: a próxima tecla vai com Ctrl": "Ctrl: la siguiente tecla va con Ctrl",` · `"Teclas do terminal": "Teclas de la terminal",` ·
    `"Seta para a esquerda": "Flecha izquierda",` · `"Seta para cima": "Flecha arriba",` · `"Seta para baixo": "Flecha abajo",` · `"Seta para a direita": "Flecha derecha",`
  - fr: `"Ctrl: a próxima tecla vai com Ctrl": "Ctrl : la touche suivante part avec Ctrl",` · `"Teclas do terminal": "Touches du terminal",` ·
    `"Seta para a esquerda": "Flèche gauche",` · `"Seta para cima": "Flèche haut",` · `"Seta para baixo": "Flèche bas",` · `"Seta para a direita": "Flèche droite",`

- [ ] **Step 9: CHANGELOG** — `### Adicionado`:

```md
- **Terminal interativo no iPhone, só pela tailnet.** Com o Habblaud fora do Docker, uma terceira porta
  (`127.0.0.1:4749`, publicada pelo `tailscale serve --https=8443`) libera o terminal interativo no celular para o
  usuário do Tailscale em `HABBLAUD_TAILNET_USER`, com login e `pty` em `HABBLAUD_REMOTE_ALLOW`. Abrir, assumir ou
  encerrar uma sessão pede a senha de novo quando a última conferência passou de 10 min. No celular, uma barra com Esc,
  Tab, Ctrl e setas fica acima do teclado. Pela rede local (porta 4748) o terminal interativo continua recusado.
```

- [ ] **Step 10: Conferir** — `npx vitest run client && npm run typecheck && npm run i18n:check && npm run build` →
  verdes. Visual no Mac: `npm run dev` (rodada da Task 5, Step 9), DevTools com emulação de iPhone (pointer coarse):
  abrir um terminal interativo local, conferir a barra; Ctrl e depois `c` interrompe o Claude Code; setas mexem no
  histórico do prompt; Esc interrompe.

- [ ] **Step 11: Commit**

```bash
git add client/src/ui/ptykeys.ts client/src/ui/ptykeys.test.ts client/src/ui/ptypane.ts client/src/ui/pty.ts client/src/ui/styles.css CHANGELOG.md shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Terminal no celular: barra com Esc, Tab, Ctrl e setas acima do teclado"
```

---

## Parte B — Operação no Mac (cada passo com OK do Itallo)

### Task 8: Suíte completa e revisão final

- [ ] **Step 1: Suíte** — no worktree:
  `npm run typecheck && npm test && npm run i18n:check && npm run build && git diff --check meu-habblaud...HEAD`
  → tudo verde (anotar o total de testes; antes desta fase eram 1972).
- [ ] **Step 2: Revisão de segurança dirigida** — conferir no diff: (a) nenhum caminho novo em que uma requisição da
  porta 4748 chega ao `deps.pty`; (b) `startTailnetListener` só com `TAILNET_HOST`; (c) a 401 `reauth` só para
  `isRemote`; (d) nada mudou em `shared/world/` e `server/world/` (`git diff --stat meu-habblaud...HEAD -- shared/world server/world` vazio);
  (e) o plist não tem segredos (`renderPlist` não lê o `.env`).

### Task 9: Push, PR e merge (pedir OK do Itallo)

- [ ] **Step 1: Pedir OK** no chat para: `git push fork fase-5-terminal`; PR `fase-5-terminal` → `meu-habblaud`; merge.
  Nada antes do OK.
- [ ] **Step 2: Depois do OK**

```bash
git push fork fase-5-terminal
gh pr create --repo itallopenedo/habblaud --base meu-habblaud --head fase-5-terminal \
  --title "Fase 5: Habblaud nativo e terminal interativo no iPhone pela tailnet" \
  --body "$(cat <<'EOF'
Plano: docs/superpowers/plans/2026-11-01-fase-5-terminal.md

- Arquivos do agente no modo Node só das pastas de projeto (mesma regra do auxiliar no Docker).
- npm run native:install|uninstall|status: LaunchAgent com.pnd.habblaud (KeepAlive, HABBLAUD_PTY=1, .env lido pelo Node).
- Porta da tailnet 127.0.0.1:4749: Tailscale-User-Login = HABBLAUD_TAILNET_USER, login, pty em HABBLAUD_REMOTE_ALLOW,
  senha de novo depois de 10 min (401 reauth, /api/remote/confirm). A 4748 continua sem PTY.
- Cliente: acesso pty, diálogo da senha e barra de teclas (Esc, Tab, Ctrl, setas).
- Checks: typecheck, Vitest (<total>), i18n, build, git diff --check.
- Fica para depois do merge (com OK): migração do Docker, tailscale serve --https=8443, testes ao vivo.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr view --repo itallopenedo/habblaud fase-5-terminal --json state,mergeable     # OPEN, MERGEABLE
gh pr merge --repo itallopenedo/habblaud fase-5-terminal --merge
```

- [ ] **Step 3: Conferir** — `gh pr view --repo itallopenedo/habblaud fase-5-terminal --json state` → `MERGED`.

### Task 10: C1 — migração do Docker para o serviço nativo (pedir OK do Itallo)

- [ ] **Step 1: Retrato antes (só leitura, sem OK)**

```bash
docker ps -a --filter name=habblaud --format '{{.Names}} {{.Status}} {{.Ports}}'
docker exec habblaud ls -la /data
curl -s http://127.0.0.1:4747/api/health | jq '{version, docker, pty, terminal, messages}'
launchctl list | grep -E 'habblaud|docker'
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
ls -la ~/.habblaud
```

- [ ] **Step 2: Pedir OK** no chat, mostrando os comandos dos Steps 3-8 e o rollback do Step 10. Avisar: o Habblaud fica
  fora do ar por 1-2 min; sessões do Claude Code/Codex não são afetadas; os avisos do ntfy falham nesse intervalo.

- [ ] **Step 3: Código e dependências** (depois do OK)

```bash
git -C ~/habblaud pull --ff-only fork meu-habblaud
git -C ~/habblaud log --oneline -1                     # o merge da Fase 5
(cd ~/habblaud && npm install)
(cd ~/habblaud && node -e "require('node-pty'); console.log('node-pty ok')")
cp -p ~/habblaud/.env ~/.habblaud/env.backup-fase5-$(date +%Y%m%d%H%M)
```

- [ ] **Step 4: Parar o Docker (container e volume ficam)**

```bash
docker stop habblaud
docker ps -a --filter name=habblaud --format '{{.Status}}'    # Exited (...)
curl -s -m 2 http://127.0.0.1:4747/api/health || echo "4747 livre"
```

  O `restart: unless-stopped` não religa um container parado à mão (nem ao reiniciar o Docker Desktop).

- [ ] **Step 5: Copiar os dados do volume para `~/.habblaud` (sem sobrescrever)**

```bash
B=~/.habblaud/docker-data-backup-$(date +%Y%m%d%H%M)
mkdir -p "$B" && docker cp habblaud:/data/. "$B"/
ls -la "$B"                                           # names.json, remote-secret, stats/, timeline/, updates.json
cp -Rn "$B"/. ~/.habblaud/
chmod 600 ~/.habblaud/remote-secret
cmp "$B/names.json" ~/.habblaud/names.json && cmp "$B/remote-secret" ~/.habblaud/remote-secret && echo "dados copiados"
ls ~/.habblaud/stats | tail -3; ls ~/.habblaud/timeline | tail -3
```

- [ ] **Step 6: Desligar o auxiliar do Docker (o plist fica, para o rollback)**

```bash
launchctl bootout gui/$(id -u)/com.pnd.habblaud-codex-bridge
launchctl disable gui/$(id -u)/com.pnd.habblaud-codex-bridge
launchctl print-disabled gui/$(id -u) | grep codex-bridge     # "com.pnd.habblaud-codex-bridge" => disabled
```

- [ ] **Step 7: Instalar o serviço**

```bash
cd ~/habblaud && npm run native:install       # termina com "Habblaud 1.0.x no ar; terminal interativo: ligado."
npm run native:status
```

- [ ] **Step 8: Conferir**

```bash
curl -s http://127.0.0.1:4747/api/health | jq '{version, docker, pty, terminal, messages, permissions}'   # docker false, pty true, o resto true
curl -s http://127.0.0.1:4747/api/dictation                     # {"available":true}
grep -E "Terminal interativo|Mensagens ao Codex|Acesso remoto|Novo agente" ~/.habblaud/logs/habblaud.log | tail -6
cat ~/.habblaud/logs/habblaud.error.log | tail -5                # vazio ou só avisos esperados
curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.habblaud/remote-tls/ca/ca.crt https://habblaud.local:4748/api/snapshot   # 401 (porta do celular com login)
curl -s -o /dev/null -w '%{http_code}\n' https://macbook-pro-de-itallo.taile846b7.ts.net/api/snapshot                         # 401 (443 da tailnet)
tail -3 ~/.habblaud/logs/phone-notify.log                        # sem erro novo depois da subida
```

  Esperado no log: "Terminal interativo: ligado (/Users/itallopenedo/.local/bin/claude)", "Mensagens ao Codex: pelo
  codex queue (…/codex)", "Acesso remoto: ligado na porta 4748 (0.0.0.0), HTTPS".

- [ ] **Step 9: Se algo falhar** — ler `~/.habblaud/logs/habblaud.error.log`; não insistir: rollback (Step 10) e voltar
  ao chat com a evidência.

- [ ] **Step 10: Rollback (só se preciso, com OK)**

```bash
cd ~/habblaud && npm run native:uninstall
launchctl enable gui/$(id -u)/com.pnd.habblaud-codex-bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pnd.habblaud-codex-bridge.plist
npm run docker:up -- --no-build
curl -s http://127.0.0.1:4747/api/health | jq '{version, docker}'    # docker true
```

  O que o modo nativo gravou depois da migração (nomes, estatísticas, timelapse) fica em `~/.habblaud`, não volta ao
  volume.

### Task 11: C2 — porta da tailnet e `tailscale serve --https=8443` (pedir OK do Itallo)

- [ ] **Step 1: Retrato antes (só leitura)**

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS serve status
$TS status --json | jq -r '.User[(.Self.UserID | tostring)].LoginName'     # o login do Tailscale do Mac (esperado: o do Itallo)
grep -E '^HABBLAUD_(REMOTE_ALLOW|ALLOWED_HOSTS|TAILNET_USER)=' ~/habblaud/.env
```

- [ ] **Step 2: Pedir OK** no chat com os comandos dos Steps 3-5 e o rollback do Step 7. Confirmar com o Itallo que o
  login mostrado no Step 1 é o mesmo do iPhone (o iPhone e o Mac estão na mesma conta da tailnet).

- [ ] **Step 3: `.env`** (depois do OK)

```bash
cp -p ~/habblaud/.env ~/.habblaud/env.backup-fase5-tailnet-$(date +%Y%m%d%H%M)
cd ~/habblaud && TS_USER=$($TS status --json | jq -r '.User[(.Self.UserID | tostring)].LoginName') npx tsx -e "
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { addToList, readEnvValue, updateEnv } from './server/remote/envfile.ts';
const c = readFileSync('.env', 'utf8');
writeFileSync('.env', updateEnv(c, { HABBLAUD_TAILNET_USER: process.env.TS_USER, HABBLAUD_REMOTE_ALLOW: addToList(readEnvValue(c, 'HABBLAUD_REMOTE_ALLOW'), 'pty') }), { mode: 0o600 });
chmodSync('.env', 0o600);"
grep -E '^HABBLAUD_(REMOTE_ALLOW|TAILNET_USER)=' ~/habblaud/.env    # ALLOW com pty; TAILNET_USER = o login do Step 1
```

- [ ] **Step 4: Reiniciar o serviço e conferir a porta**

```bash
launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud
sleep 5; grep "Porta da tailnet" ~/.habblaud/logs/habblaud.log | tail -1      # "ligada em 127.0.0.1:4749 … terminal interativo: liberado."
lsof -nP -iTCP:4749 -sTCP:LISTEN                                             # só 127.0.0.1:4749
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4749/api/health    # 403 (sem o cabeçalho do Tailscale)
```

- [ ] **Step 5: Publicar na tailnet**

```bash
$TS serve --bg --https=8443 http://127.0.0.1:4749
$TS serve status                                                              # :443 → https+insecure://127.0.0.1:4748 e :8443 → http://127.0.0.1:4749
curl -s -o /dev/null -w '%{http_code}\n' https://macbook-pro-de-itallo.taile846b7.ts.net:8443/api/health   # 401: o cabeçalho chegou, falta o login
curl -s -o /dev/null -w '%{http_code}\n' https://macbook-pro-de-itallo.taile846b7.ts.net:8443/login        # 200
```

  Se o primeiro `curl` der 403, o `tailscale serve` não pôs o cabeçalho para o próprio Mac: conferir pelo iPhone (Task
  12) antes de concluir qualquer coisa.

- [ ] **Step 6: LAN continua sem PTY** — `curl -s --cacert ~/.habblaud/remote-tls/ca/ca.crt https://habblaud.local:4748/api/pty -o /dev/null -w '%{http_code}\n'` → 401 (sem login; com login seria 403, coberto pelos testes e conferido no iPhone na Task 12).

- [ ] **Step 7: Rollback (só se preciso, com OK)**

```bash
$TS serve --https=8443 off
cp -p ~/.habblaud/env.backup-fase5-tailnet-<data> ~/habblaud/.env
launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud
```

### Task 12: Ao vivo e registro

- [ ] **Step 1: PTY no Mac (localhost)** — `http://localhost:4747`, gaveta de uma sala de teste → "Nova sessão": o
  Claude Code abre na janela interativa; digitar "diga oi" e ver a resposta; fechar a janela e reabrir (a sessão
  continua); "Encerrar" (dois cliques). Conferir que nenhuma senha foi pedida (página local).
- [ ] **Step 2: PTY no iPhone pelo 4G** — Wi-Fi desligado; abrir `https://macbook-pro-de-itallo.taile846b7.ts.net:8443`
  (entrar, se pedir; o login da 443 já vale). Numa sessão descartável aberta pelo Habblaud: abrir o terminal
  interativo (logo depois do login, sem pedir senha), digitar, usar a barra: Esc interrompe, Tab completa, Ctrl e `c`
  interrompe, setas no histórico; o teclado do iPhone não cobre a barra.
- [ ] **Step 3: Senha vencida** — esperar mais de 10 min (ou reiniciar o serviço, com OK, o que zera as conferências),
  reabrir o terminal: aparece "Confirme a senha"; senha errada mostra "Senha incorreta."; a certa abre. Com o terminal
  aberto, digitar continua funcionando depois dos 10 min.
- [ ] **Step 4: LAN sem PTY** — iPhone no Wi-Fi de casa em `https://habblaud.local:4748`: o botão do terminal
  interativo não aparece (motivo: "Terminal interativo só no próprio computador ou pela porta da tailnet"); o terminal
  ao vivo, permissões e mensagens funcionam.
- [ ] **Step 5: O resto depois da migração** — login pela 443 (`https://macbook-pro-de-itallo.taile846b7.ts.net`)
  funciona; uma pergunta numa sessão de teste (`AskUserQuestion`) gera o aviso do ntfy (`tail -2
  ~/.habblaud/logs/phone-notify.log` → "Notificação enviada"); mensagem com anexo pelo iPhone chega à sessão; botão
  Ditar transcreve; uma mensagem a um Codex de teste é entregue pelo `codex queue` do servidor (sem o auxiliar).
- [ ] **Step 6: Arquivos do agente (Task 1)** — gaveta → Arquivos de uma sessão em `~/dev/...`: abre; um arquivo fora
  das pastas de projeto (se houver) responde "fora das pastas de projeto".
- [ ] **Step 7: Reinício do Mac (pedir OK do Itallo)** — depois de reiniciar e entrar: `npm run native:status` →
  rodando; `curl -s http://127.0.0.1:4747/api/health | jq .pty` → true; `$TS serve status` com 443 e 8443;
  `docker ps --filter name=habblaud` → nada rodando (o container parado não volta).
- [ ] **Step 8: Registrar** — em `/Users/itallopenedo/dev/pnd-tecnologia/projetos/habblaud.md` (seção nova com a data:
  commits, PR, migração feita, o que foi verificado ao vivo e o que não, onde estão os backups do volume e do `.env`)
  e atualizar a linha do `_indice.md`. Encerrar as sessões descartáveis.

---

## Autorrevisão

- **Cobertura do spec:** C1 — LaunchAgent `com.pnd.habblaud` com KeepAlive, Node absoluto, `HABBLAUD_PTY=1`, logs em
  `~/.habblaud/logs/` → Task 2; Docker desligado com volume preservado e migração dos dados → Task 10 (Steps 4-5);
  checks `pty: true`, terminal no Mac, reinício do Mac → Task 10 (Step 8) e Task 12 (Steps 1 e 7); rollback
  `launchctl bootout` + `docker:up` → Task 10 (Step 10). C2 — terceiro listener `127.0.0.1:4749`
  (`HABBLAUD_TAILNET_PORT`), HTTP só em loopback → Task 4; `tailscale serve --bg --https=8443` com a 443 intacta →
  Task 11; login + `Tailscale-User-Login` = `HABBLAUD_TAILNET_USER` + `pty` → Tasks 3-5; senha de novo depois de 10 min
  → Tasks 3, 5 e 6; 4748 recusando PTY → Task 5 (testes) e Task 12 (Step 4); barra de teclas → Task 7; testes do gate
  (LAN 403, sem cabeçalho 403, usuário errado 403, sem `pty` 403, ok 200, vencida 401) → Task 5, Step 2; caso real no
  4G → Task 12, Step 2. Follow-up da Fase 4 (arquivos do agente no modo Node) → Task 1.
- **Placeholders:** nenhum "TBD"; cada passo de código traz o código; os passos de operação trazem os comandos e a
  conferência. `<data>` no rollback da Task 11 é o sufixo do backup criado no Step 3 da mesma task.
- **Nomes conferidos entre tarefas:** `FileFetcherOptions.inside` (1); `SERVICE_LABEL`/`renderPlist`/`servicePath`/
  `plistFile`/`parseLaunchctlPrint`/`logFiles` (2); `CONFIRM_MS`, `RemoteSessions.confirm`/`confirmedWithin`,
  `'pty'` em `RemoteFeature` (3 → 5); `parseTailnetConfig`/`createTailnetGate`/`isTailnetRequest`/
  `startTailnetListener`/`ptyNeedsConfirm`/`DEFAULT_TAILNET_PORT`/`TAILNET_HOST`, `ServerConfig.tailnet`/
  `tailnetWarning` (4 → 5); `ApiDeps.remote.tailnet`/`confirmed`, `AccessInfo.pty`, `ptyRequestProblem(req, tailnet)`,
  `createPtyRoutes(ptys, { tailnet })` (5 → 6); `canUsePty`, `ReauthError`/`isReauth`/`confirmPassword`/
  `confirmedRecently`/`withReauth`/`askPassword`, `PtyPane(onExit, onDenied)`/`notice` (6 → 7); `PtyKeys`/
  `keySequence`/`withCtrl`/`keyboardInset`, `PtyPane.keys` (7).
- **Fora desta fase (de propósito):** PTY pela LAN; Codex no terminal interativo (o `ptyControllable` continua só
  Claude Code); rotação dos logs do serviço (launchd não rotaciona; ver o tamanho de `~/.habblaud/logs/habblaud.log`
  de tempos em tempos); `--allow pty` na ajuda do `remote:setup`; serviço nativo no Linux (systemd); seção no README
  do upstream (o `FORK.md` documenta).
