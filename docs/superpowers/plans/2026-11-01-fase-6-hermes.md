# Fase 6 — Hermes no escritório Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ver no escritório do Habblaud, ao vivo, cada sessão do Hermes Agent da VPS (chegou, trabalhando, ferramenta
em uso, "precisa de você" na aprovação, à toa, saiu), sem nenhum texto de mensagem sair da VPS, sem atrasar o Hermes e
sem nenhum agente do Hermes ir ao Habblaud World.

**Architecture:** Um plugin oficial do Hermes, `habblaud-observer` (Python, só stdlib, em
`integrations/hermes/habblaud-observer/`), registra dez ganchos de observação, monta para cada um um evento com campos
de uma lista fechada (perfil, plataforma, sha256 da sessão cortada, gancho, ferramenta, ok, duração, horário, modelo),
põe numa fila em memória e uma thread em segundo plano manda lotes de até 50 eventos para
`https://macbook-pro-de-itallo.taile846b7.ts.net:8443/api/hermes/events` (timeout 2 s, descarta na falha). No Habblaud,
essa rota existe só no listener da tailnet (`127.0.0.1:4749`), depois do guard e do `Tailscale-User-Login` e ANTES do
login remoto: freio de requisições, token Bearer (só a sha256 no `.env`), corpo até 64 KB e formato estrito
(`server/hermes/http.ts`). Os eventos vão para a `HermesSource` (contrato `AgentSource`), que mantém um agente
`provider: 'hermes'` por sessão numa sala por perfil (`hermes:/<perfil>`). A projeção do World
(`shared/world/projection.ts`) passa a aceitar só `claude` e `codex` (hoje ela converte qualquer outro provider em
`claude`), com teste na projeção e no uplink provando que nada do Hermes sobe.

**Tech Stack:** Node 24 + TypeScript (tsx), Vitest, cliente em TypeScript puro (Vite); Python 3 (stdlib: `urllib`,
`threading`, `queue`, `unittest`) no plugin; Tailscale (`tailscale serve`, já publicado na Fase 5); Hermes Agent
v0.22.2 (plugins `kind: standalone`, `ctx.register_hook`). Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-11-01-meu-habblaud-design.md` (Fase 6 — Hermes no escritório (E)). Mudanças e
decisões registradas em relação ao spec:

- **Transporte:** o spec previa "VPS entra na tailnet". Ela já está (fatos abaixo), com o mesmo dono do Mac
  (`itallo@`), então o `tailscale serve` põe nas requisições dela o `Tailscale-User-Login` do Itallo. Por isso a rota
  **continua exigindo o cabeçalho** (o spec dizia que ela não pediria): só o login remoto é dispensado, trocado pelo
  token. A Task 1 confere isso de verdade da VPS (`curl` na `:8443` → 401 do login, não 403 do cabeçalho); se der 403,
  parar e voltar ao chat.
- **`on_session_end`:** o spec dizia `offline` nele. O Hermes chama `on_session_end` no fim de cada `run_conversation`
  (cada mensagem do Telegram), não quando a sessão fecha; mapeá-lo para `offline` faria o agente sair e voltar a cada
  mensagem. Decisão: `on_session_end` e `post_llm_call` → à toa; `on_session_finalize` e `on_session_reset` →
  `offline`; sem evento por 6 h → sai do escritório. Esse mapeamento é seguro nos dois casos (se a Task 1 mostrar que
  o `on_session_end` é o fim da sessão, o agente fica à toa até o finalize ou as 6 h).
- **Subagentes (`subagent_start/stop`):** fora desta fase (opcional na decisão do Itallo). O plugin não registra esses
  ganchos; a fonte não cria subagentes.
- **Token:** `sha256` em vez de scrypt. O token tem 32 bytes aleatórios: uma hash lenta não protege mais nada e
  custaria CPU a cada lote. `.env`: `HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>`; o token cru só existe no arquivo
  `0600` da VPS (`<HERMES_HOME>/habblaud-observer.json`).
- **Sessão:** o id cru da sessão nunca sai da VPS: vai `sha256(perfil + "\0" + session_id)` cortada em 16 hex. A
  aprovação (`pre_approval_request`/`post_approval_response`) usa o `session_id` do gancho; se ele não vier, a sessão
  da última ferramenta que começou na mesma thread; sem nenhuma das duas, o evento não sai.
- **World:** a exclusão fica na projeção, o único lugar que monta o pacote (raiz do problema: `toWorldAgent` mandava
  qualquer provider que não fosse `codex` como `claude`). Uma linha de filtro + o tipo `Provider` mais largo em dois
  arquivos do caminho de volta (`office-from-world.ts`, que nada sobe). `protocol.ts`, `schema.json`, `city.ts` e as
  outras cópias exatas do servidor do mundo não mudam.
- **Conta:** os agentes do Hermes usam a conta `hermes`, sem entrada no `AccountsService` (não há pasta nem uso local):
  o chip mostra "H" e o rótulo "Hermes". A sala `hermes:/<perfil>` não é caminho absoluto, então não aparece nas pastas
  sugeridas do Novo agente, e o PTY recusa assumir/encerrar (conta desconhecida).
- **Resposta ao Hermes pelo escritório:** fora do escopo (spec). A caixa de mensagem do agente do Hermes diz "O Hermes
  só é acompanhado aqui: responda no canal dele".

### Fatos conferidos (2026-11-01, HEAD `9b8d88d`)

- `server/sources/source.ts`: `AgentSource { provider; start(); stop(); sources(); transcriptPathOf(); terminalParser?() }`;
  `SourceSet.add/start/stop`. `server/index.ts` monta `agents = new SourceSet([claude])` e `agents.add(codex)` (~143-149).
- `server/codex/http.ts` + `server/sources/codex/live.ts`: o modelo de rota de eventos (só observa; a rota só
  repassa à fonte). `server/http/app.ts`: `HttpError`, `readJson(req, max)` (exige JSON, 413 acima do máximo),
  `sendJson`; `isLocalOnlyPath` barra `/api/codex/*` para remoto; rota desconhecida → 404 `rota desconhecida`.
- `server/index.ts` (~526-555), listener da tailnet: `guard → createTailnetGate → createTailnetRemoteGate (login) → api → fallback`.
  `server/http/tailnet.ts`: `createTailnetGate` aceita só `Tailscale-User-Login` = `HABBLAUD_TAILNET_USER` e recusa o
  Funnel. `server/http/tailnet.test.ts` refaz essa cadeia na função `start()` (LAN + tailnet sobre a mesma API).
- `server/model/office.ts`: `addMain(MainInput{id, provider?, account, sessionId, cwd, role, startedAt, status})`,
  `setStatus(id, status, waitingFor?)` (sintetiza "Precisa de você", "Concluiu" e os avisos), `addActivity(id, act,
  current)`, `applyTranscript(id, {title, tasks, stats, model, lastAt})`, `closeMain(id)` (offline + 20 s de graça).
  `OfficeDeps.now` existe (relógio manual nos testes).
- `shared/types.ts:18`: `export type Provider = 'claude' | 'codex';`. Trocando por `'claude' | 'codex' | 'hermes'`, o
  typecheck acusa exatamente 3 lugares (conferido numa cópia): `client/src/ui/provider.ts:11` (`PROVIDER_NAME`),
  `shared/world/office-from-world.ts:52` (`WORLD_TOOL_ACCOUNTS`) e `server/accounts/detect.ts:213` (`ALIAS_TOOLS`).
- `shared/world/projection.ts:250`: `provider: a.provider === 'codex' ? 'codex' : 'claude'` — um agente `hermes` subiria
  como `claude` (conferido: o teste da Task 2 falha hoje com 2 andares em vez de 1).
- `shared/world/README.md`: o servidor do mundo guarda cópias exatas (SHA-256 em teste) de `protocol.ts`,
  `schema.json`, `city.ts`, `floor-names.ts` e `shared/names.ts`; `projection.ts` e `office-from-world.ts` não estão
  nessa lista. Toda mudança em `shared/world/` confere `docs/world/privacidade.md` na revisão.
- Mac: Habblaud nativo (LaunchAgent `com.pnd.habblaud`, `.env` em `~/habblaud`, logs em `~/.habblaud/logs/`),
  `tailscale serve --https=8443 → http://127.0.0.1:4749` (Fase 5), `python3` 3.14.7, Node v24.21.0.
- VPS (fatos lidos em 2026-11-01, só leitura, `ssh openclaw-aapanel`): `vmi856727` na tailnet `taile846b7.ts.net`
  (100.110.111.68), dono `itallo@`; Hermes Agent v0.22.2 em `/opt/hermes-0.22.2-20261016`; perfis em
  `/root/.hermes/profiles/` (auditor, guedola, iongroup, pnd-ads, suporte, voz) e o principal `default` = `/root/.hermes`
  (Íon). Plugins em `<HERMES_HOME>/plugins/<nome>/` (`plugin.yaml` + `__init__.py` com `register(ctx)` →
  `ctx.register_hook(nome, fn)`), ligados por `plugins.enabled` no `config.yaml` do HERMES_HOME (opt-in). Precedente:
  `/root/.hermes/plugins/orca-status`, ligado em `/root/.hermes/config.yaml`. Ganchos e campos (SELECTED_KEYS do
  orca-status): `on_session_start` (session_id, model, platform); `pre_llm_call` (session_id, user_message,
  is_first_turn, model, platform, sender_id); `post_llm_call` (… assistant_response …); `pre_tool_call` (session_id,
  task_id, tool_call_id, tool_name, args); `post_tool_call` (… result, duration_ms); `pre_approval_request` /
  `post_approval_response` (command, description, pattern_key(s), session_key, surface, choice — **sem session_id**
  na lista); `on_session_end` (session_id); `on_session_finalize`/`on_session_reset` (session_id, platform).
  Observadores são fail-open. Outros plugins da PND (pnd-guardiao, pnd-delegation-guard, observers): não mexer.
- Notas do Itallo (`pnd-tecnologia/projetos/hermes-guedola.md`): um gateway só (`hermes-gateway`, systemd) serve os
  perfis por multiplexação; a rota do Telegram do grupo PND vai para o perfil `guedola`; DM do Itallo e grupo Meu Íon
  vão para o `default` (Íon). Regra para reiniciar: antes de `systemctl restart hermes-gateway`, conferir
  `/root/.hermes/logs/agent.log` e `/root/.hermes/profiles/guedola/logs/agent.log` e só reiniciar quando o último
  `conversation turn` de cada um tiver um `Turn ended` depois; melhor ainda, confirmar com a sessão que coordena a VPS.
  Reinícios recentes levaram 12-25 s e interrompem as integrações do Íon nesse intervalo.

## Global Constraints

- Branch `fase-6-hermes` a partir de `meu-habblaud` (`9b8d88d`) → PR para `meu-habblaud` no fork `itallopenedo/habblaud`.
- **Habblaud World — dados verdadeiros:** agentes `provider: 'hermes'` nunca vão ao World. A única mudança em
  `shared/world/` e `server/world/` é: o filtro de providers na projeção (só `claude` e `codex`), o tipo do caminho de
  volta (`office-from-world.ts`, nada sobe) e testes. `protocol.ts`, `schema.json`, `city.ts`, `floor-names.ts`,
  `shared/names.ts` não mudam. Nada desta fase inventa, infla ou muda o que sobe de Claude Code e Codex.
- **Nada de texto do Hermes:** o plugin nunca manda `user_message`, `assistant_response`, `args`, `result`, `command`,
  `description`, `pattern_key(s)`, `session_key`, `sender_id` nem o `session_id` cru. O Habblaud recusa (400) qualquer
  chave fora de `profile, platform, session, event, tool, ok, duration_ms, at, model`. A fonte só escreve textos fixos
  (`tr()`), o nome da ferramenta, o perfil e a plataforma.
- **Rota:** `POST /api/hermes/events` só no listener da tailnet (`127.0.0.1:4749`), na ordem guard → `Tailscale-User-Login`
  → **rota do Hermes** → login → API. É a única rota sem o login remoto. Nas portas 4747 e 4748 ela não existe (404).
  Freio (60 requisições/10 s) antes do token; token antes de ler o corpo; corpo até 64 KB; 1 a 100 eventos por lote.
- **Token:** 32 bytes aleatórios (`base64url`). No Mac só `HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>` em `~/habblaud/.env`
  (tirada do ambiente dos filhos por `scrubSecretsFromEnv`); o token cru vai num arquivo `0600` para a VPS e não fica
  no Mac. Nunca no chat, em log, em URL nem em argumento de linha de comando.
- **Plugin:** Python só com stdlib; o gancho só enfileira e volta `None` na hora (nunca injeta contexto nem bloqueia
  ferramenta); fila de 500 (cheia = descarta); lotes de até 50; timeout 2 s; descarta na falha; erro inesperado desliga
  o plugin até o próximo restart do gateway; sem configuração válida não registra nada.
- Rodadas de teste do servidor (`npm run dev`) sempre com `HABBLAUD_DATA_DIR` temporário, `HABBLAUD_WORLD=0`,
  `HABBLAUD_UPDATE_CHECK=0` e portas diferentes de 4747/4748/4749.
- Texto visível (interface, erros, logs) passa por `tr()` com traduções em `shared/locales/{en,es,fr}.ts`, num bloco
  `// Fase 6 — Hermes` no fim de cada arquivo (antes do `};`); `npm run i18n:check` verde. Antes de acrescentar uma
  chave, `grep -n '^\s*"<texto>":' shared/locales/en.ts`: se já existir, não repita (chave duplicada quebra o
  typecheck). Já existem e são reusadas: `"Lendo arquivo"`, `"Escrevendo arquivo"`, `"Editando arquivo"`,
  `"Pesquisando na web"`, `"Lendo uma página"`, `"Navegando no navegador"`, `"Usando {0}"`, `"aprovar um comando"`,
  `"método não permitido"`, `"erro interno"`, `"corpo grande demais"`.
- Mudança visível entra em `## [Não lançado]` do `CHANGELOG.md` (`### Adicionado`).
- Arquivos novos em vez de reescrever arquivos do upstream sempre que possível.
- Commits terminam com `Co-Authored-By:` do modelo que escreveu. Nunca `git add -A`: arquivos explícitos.
- Antes do PR: `npm run typecheck`, `npm test`, `npm run i18n:check`, `npm run build`,
  `python3 -m unittest discover -s integrations/hermes`, `git diff --check` verdes.
- **Operação** (push/PR/merge, `.env`, reinício do Habblaud, qualquer coisa na VPS): cada passo marcado "pedir OK do
  Itallo" só roda depois do OK no chat, com os comandos exatos, a conferência e o rollback. Na VPS (produção):
  nunca mexer em outros plugins; backup antes de editar `config.yaml`; o comando de reinício do gateway é confirmado
  com o Itallo na hora, depois da conferência dos logs das notas.

---

## Parte A — Código (testável, revisável)

### Task 1: Fatos do Hermes na VPS (só leitura)

Confirma o que o código das Tasks 3 e 7 supõe. Não muda nada na VPS; avisar no chat antes de rodar.

**Files:** nenhum (o resultado vai para o chat e para o registro da Task 12).

**Interfaces:**
- Consumes: nada.
- Produces: respostas para (a) os campos reais de `pre_approval_request`/`post_approval_response` (tem `session_id`?);
  (b) quando o `on_session_end` é chamado; (c) se o gateway multiplexado carrega os plugins de cada perfil (ou só os
  do `default`); (d) se `hermes plugins enable` existe; (e) a versão do Python do Hermes; (f) se a VPS resolve o nome
  do Mac e chega na `:8443` com o cabeçalho do Tailscale (401, não 403); (g) o formato das linhas
  `conversation turn`/`Turn ended` do `agent.log` (para medir a latência na Task 11).

- [ ] **Step 1: Rodar (só leitura)**

```bash
ssh openclaw-aapanel 'bash -s' <<'EOF'
set -u
H=$(readlink -f /usr/local/lib/hermes-agent); echo "== hermes: $H"
hermes --version 2>&1 | head -1
BIN=$(readlink -f "$(command -v hermes)"); PY=$(head -1 "$BIN" | sed 's/^#![[:space:]]*//; s/[[:space:]].*//')
echo "== python: $PY"; "$PY" --version
echo "== quem chama os ganchos"
grep -rn --include=*.py -E '(invoke_hook|_invoke_hook|call_hook|run_hooks?)\(' "$H" | grep -E 'approval|on_session_end|on_session_finalize|pre_tool_call|post_tool_call|pre_llm_call|post_llm_call' | head -40
echo "== multiplexação e plugins"
grep -rn --include=*.py -E 'MULTIPLEX|load_plugins|discover_plugins|plugins\.enabled' "$H/gateway" "$H/hermes_cli" 2>/dev/null | head -20
echo "== CLI de plugins"; hermes plugins --help 2>&1 | head -20
echo "== orca-status (como recebe os argumentos)"; grep -n -E 'def |register_hook|kwargs' /root/.hermes/plugins/orca-status/__init__.py | head -30
echo "== config do Íon"; grep -n -A6 '^plugins:' /root/.hermes/config.yaml
echo "== nome do Mac e a :8443"
getent hosts macbook-pro-de-itallo.taile846b7.ts.net || echo "SEM MagicDNS"
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' https://macbook-pro-de-itallo.taile846b7.ts.net:8443/api/health
echo "== gateway"; systemctl is-active hermes-gateway; systemctl cat hermes-gateway | grep -E '^(ExecStart|Environment)' | head
echo "== formato do agent.log"; grep -E 'conversation turn|Turn ended' /root/.hermes/logs/agent.log | tail -4
EOF
```

- [ ] **Step 2: Conferir e anotar no chat**
  - (f) `curl` → `401`. **Se der `403`**, o `tailscale serve` não pôs o `Tailscale-User-Login` para a VPS (nó com tag,
    por exemplo): parar e voltar ao chat (a rota desta fase depende do cabeçalho). Se der erro de nome: `SEM MagicDNS`
    → voltar ao chat (a URL do plugin teria de mudar).
  - (a) Se `pre_approval_request` recebe `session_id`, ótimo; se não, o plugin usa a sessão da ferramenta na mesma
    thread (Task 7) — conferir no código mostrado que o pedido de aprovação roda na mesma thread do `pre_tool_call`
    (dentro da execução da ferramenta). Se rodar noutra thread, anotar: a aprovação não vai aparecer e isso vira
    pergunta ao Itallo (não bloqueia a fase).
  - (b) Anotar onde o `on_session_end` é chamado (esperado: fim de `run_conversation`). O mapeamento da Task 3 é seguro
    nos dois casos.
  - (c) **Se o gateway carrega só os plugins do `default` e os ganchos dos outros perfis passam por eles**, ligar o
    plugin no Íon também mostraria turnos do `guedola` (grupo PND) rotulados "Íon" — sem texto nenhum, mas com o
    perfil errado. Anotar e levar ao Itallo antes da Task 11.
  - (d) Anotar se `hermes plugins enable <nome>` existe (a Task 11 usa; senão, a edição com `sed`).
  - (e) Python ≥ 3.8 (o plugin usa f-strings e `re.fullmatch`). (g) Anotar o formato das duas linhas.

---

### Task 2: Provider `hermes` e o World: só Claude Code e Codex sobem

**Files:**
- Modify: `shared/types.ts:18` (`Provider`)
- Modify: `shared/world/projection.ts` (cabeçalho, `WORLD_PROVIDERS`, filtro em `projectWithReport`)
- Modify: `shared/world/office-from-world.ts:52-56` (tipos de `WORLD_TOOL_ACCOUNTS` e `PROVIDERS`; nada sobe dali)
- Modify: `server/accounts/detect.ts:213-249` (`AliasTool`)
- Modify: `client/src/ui/provider.ts:11` (`PROVIDER_NAME`)
- Modify: `docs/world/privacidade.md` (tabela "Nunca sai")
- Test: `shared/world/projection.test.ts`, `server/world/uplink.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `Provider = 'claude' | 'codex' | 'hermes'`; `AliasTool = Exclude<Provider, 'hermes'>` (exportado de
  `server/accounts/detect.ts`); `PROVIDER_NAME.hermes = 'Hermes'`.

- [ ] **Step 1: Teste da projeção (falhando)** — em `shared/world/projection.test.ts`, dentro do
  `describe('projeção: regras')`, logo antes de `it('provider ausente é claude; codex continua codex'`:

```ts
  it('Hermes nunca entra: nem o agente, nem a sala só dele, nem pedido de id do mundo', () => {
    const ids = new FakeIds();
    const rooms = [room('/p/a'), room('hermes:/Íon')];
    const agents = [
      agent('m1', '/p/a'),
      agent('hermes:0123456789abcdef', 'hermes:/Íon', { provider: 'hermes' }),
      agent('hermes:fedcba9876543210', '/p/a', { provider: 'hermes', status: 'waiting' }),
    ];
    const u = project(input(rooms, agents), ids, NOW);
    expect(u.floors).toHaveLength(1);
    expect(agentsOf(u).map((a) => a.provider)).toEqual(['claude']);
    expect(ids.calls.some((c) => c.startsWith('hermes'))).toBe(false);
    expect(JSON.stringify(u).toLowerCase()).not.toContain('hermes');
    expect(validate(u)).toEqual([]);
    // Só o Hermes trabalhando: prédio sem andares.
    expect(project(input([room('hermes:/Íon')], [agents[1]]), new FakeIds(), NOW).floors).toEqual([]);
  });
```

- [ ] **Step 2: Teste do uplink (falhando)** — em `server/world/uplink.test.ts`, dentro do
  `describe('BuildingUplink: conexão e remessas')`, logo antes de `it('última remessa em disco: modo 600, …'`:

```ts
  it('Hermes nunca sobe: o pacote é o mesmo do escritório sem ele, e mudança só nele não manda nada', async () => {
    const h = await start({ start: false });
    h.agents.push(
      agent('hermes:0123456789abcdef', 'hermes:/Íon', { provider: 'hermes', status: 'working' }),
      agent('hermes:fedcba9876543210', '/Users/ana/outro', { provider: 'hermes', status: 'waiting' }),
    );
    h.uplink.start();
    await waitFor(() => h.world.ws.uplinks.length === 1, 'primeira remessa');
    const { uplink } = h.world.ws.uplinks[0];
    expect(validate(uplink)).toEqual([]);
    expect(uplink.floors).toHaveLength(2);
    expect(agentsOf(uplink).map((a) => a.provider).sort()).toEqual(['claude', 'claude', 'codex']);
    expect(JSON.stringify(uplink).toLowerCase()).not.toContain('hermes');
    expect(h.uplink.lastUplink()!.uplink).toEqual(uplink);
    // Só o Hermes mudou (status e entrou mais um): o pacote é igual, nada sai.
    h.agents[4] = { ...h.agents[4], status: 'idle' };
    h.agents.push(agent('hermes:00000000000000aa', 'hermes:/guedola', { provider: 'hermes' }));
    h.change();
    await sleep((FAST.debounceMs ?? 0) + (FAST.minGapMs ?? 0) + 150);
    expect(h.world.ws.uplinks).toHaveLength(1);
  });
```

- [ ] **Step 3: Ver falhar** — `npx vitest run shared/world/projection.test.ts server/world/uplink.test.ts -t Hermes`
  → os dois falham: `expected [ … ] to have a length of 1 but got 2` (projeção: o andar só do Hermes entrou) e
  `… to have a length of 2 but got 3` (uplink). É o defeito de hoje: o Hermes subiria como `claude`.

- [ ] **Step 4: Implementação** — `shared/types.ts:18`:

```ts
/** Ferramenta de um agente: Claude Code, Codex ou o Hermes Agent da VPS (Fase 6, só observado; nunca vai ao World). */
export type Provider = 'claude' | 'codex' | 'hermes';
```

  `shared/world/projection.ts` — no comentário do topo, trocar a linha do "Um andar por sala…" por:

```ts
// - Um andar por sala com pelo menos um agente presente; um agente por principal ou subagente trabalhando, esperando,
//   à toa ou de olho num shell. Demonstração (`demo:`) nunca entra, nem agente de ferramenta que não é do mundo
//   (só `claude` e `codex`: o Hermes, que roda numa VPS, fica de fora).
```

  logo depois de `const isWorldStatus = …`:

```ts

/**
 * Ferramentas que existem no mundo (o `provider` do schema.json). Agente de outra ferramenta (o Hermes, que roda numa
 * VPS e não neste computador) fica de fora: mandá-lo como `claude` seria um agente que não existe aqui.
 */
const WORLD_PROVIDERS: ReadonlySet<string> = new Set<WorldAgent['provider']>(['claude', 'codex']);
```

  e em `projectWithReport`, logo depois de `if ((a.kind !== 'main' && a.kind !== 'sub') || !isWorldStatus(a.status)) continue;`:

```ts
    if (!WORLD_PROVIDERS.has(a.provider ?? 'claude')) continue;
```

  (`WorldAgent` já é importado de `./protocol`. A linha 250, `provider: a.provider === 'codex' ? 'codex' : 'claude'`,
  fica como está: agora só chegam `claude` e `codex`.)

  `shared/world/office-from-world.ts` (caminho de volta, só leitura do mundo): trocar

```ts
export const WORLD_TOOL_ACCOUNTS: Readonly<Record<Provider, { short: string; name: string; color: string }>> = {
```
  por
```ts
export const WORLD_TOOL_ACCOUNTS: Readonly<Record<WorldAgent['provider'], { short: string; name: string; color: string }>> = {
```
  e `const PROVIDERS: readonly Provider[] = ['claude', 'codex'];` por
  `const PROVIDERS: readonly WorldAgent['provider'][] = ['claude', 'codex'];` (`WorldAgent` já é importado).

  `server/accounts/detect.ts`: trocar `const ALIAS_TOOLS: Record<Provider, {` por

```ts
/** Ferramentas abertas por alias de shell (o Hermes roda na VPS: não tem alias aqui). */
export type AliasTool = Exclude<Provider, 'hermes'>;
const ALIAS_TOOLS: Record<AliasTool, {
```
  e, nas assinaturas, `parseToolAliases(text: string, home: string, tool: Provider)` →
  `parseToolAliases(text: string, home: string, tool: AliasTool)` e `readShellAliases(home: string, tool: Provider = 'claude')`
  → `readShellAliases(home: string, tool: AliasTool = 'claude')`.

  `client/src/ui/provider.ts:11`:

```ts
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
```

- [ ] **Step 5: `docs/world/privacidade.md`** — na tabela "Nunca sai", depois da linha "Agentes do modo demonstração":

```md
| Agentes do Hermes (o agente da VPS que o Habblaud só acompanha) | Ficam de fora antes de montar o pacote: o mundo só conhece `claude` e `codex` |
```

- [ ] **Step 6: Ver passar** — `npx vitest run shared/world server/world client/src/ui/provider.test.ts && npm run typecheck`
  → verde (inclusive `server/world/sources.test.ts`, que confere as cópias exatas, e `privacy-doc.test.ts`).
  `git diff --stat -- shared/world/protocol.ts shared/world/schema.json shared/world/city.ts` → vazio.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts shared/world/projection.ts shared/world/projection.test.ts shared/world/office-from-world.ts server/world/uplink.test.ts server/accounts/detect.ts client/src/ui/provider.ts docs/world/privacidade.md
git commit -m "World: só agentes do Claude Code e do Codex sobem; provider hermes no escritório"
```

---

### Task 3: `HermesSource` — a fonte dos agentes do Hermes

**Files:**
- Create: `server/sources/hermes/source.ts`
- Test: `server/sources/hermes/source.test.ts`
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `Office` (`addMain`, `setStatus`, `addActivity`, `applyTranscript`, `closeMain`, `get`), `SPECIAL.error`,
  `ActivityDescription` (`shared/activity.ts`), `AgentSource` (`server/sources/source.ts`), `Provider` (Task 2).
- Produces (`server/sources/hermes/source.ts`): `HERMES_EVENTS` (tupla dos 10 ganchos), `type HermesEventName`,
  `interface HermesEvent { profile; platform?; session; event; tool?; ok?; durationMs?; at; model? }`,
  `HERMES_ACCOUNT = 'hermes'`, `HERMES_QUIET_MS = 300_000`, `HERMES_STALE_MS = 21_600_000`,
  `hermesAgentId(session: string): string` (`hermes:<session>`), `describeHermesTool(name: string): ActivityDescription`,
  `class HermesSource implements AgentSource` com `constructor({ office, now?, tickMs? })`,
  `apply(events: readonly HermesEvent[]): void` e `tick(): void`.

- [ ] **Step 1: Teste (falhando)** — `server/sources/hermes/source.test.ts`:

```ts
// Fonte do Hermes (server/sources/hermes/source.ts) com o Office de verdade e um relógio manual: a sessão abre, a
// ferramenta vira atividade, a aprovação vira "precisa de você", o fim fecha, o silêncio põe à toa e tira. Dados
// sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { describeHermesTool, HERMES_QUIET_MS, HERMES_STALE_MS, HermesSource, hermesAgentId, type HermesEvent } from './source';

setQuiet(true);

const SID = '0123456789abcdef';
const ID = hermesAgentId(SID);

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined, now: () => clock.t });
  const source = new HermesSource({ office, now: () => clock.t });
  const ev = (event: HermesEvent['event'], extra: Partial<HermesEvent> = {}): HermesEvent => ({ profile: 'Íon', platform: 'telegram', session: SID, event, at: clock.t, ...extra });
  return { clock, office, source, ev };
}

describe('HermesSource', () => {
  it('sessão abre (Hermes, sala do perfil, título sem texto), mensagem e ferramenta viram atividade, fim do turno fica à toa, finalize fecha', () => {
    const { office, source, ev } = setup();
    source.apply([ev('on_session_start', { model: 'gpt-6-luna' })]);
    expect(office.get(ID)).toMatchObject({ provider: 'hermes', account: 'hermes', kind: 'main', status: 'idle', title: 'Hermes · Íon (telegram)', model: 'gpt-6-luna' });
    expect(office.roomPath(office.get(ID)!.roomId)).toBe('hermes:/Íon');
    source.apply([ev('pre_llm_call')]);
    expect(office.get(ID)).toMatchObject({ status: 'working', activity: { kind: 'prompt', text: 'Recebeu uma mensagem' } });
    source.apply([ev('pre_tool_call', { tool: 'terminal' }), ev('post_tool_call', { tool: 'terminal', ok: true, durationMs: 1200 })]);
    expect(office.get(ID)).toMatchObject({ status: 'working', activity: { kind: 'run', text: 'Rodando um comando', tool: 'terminal' } });
    expect(office.get(ID)!.stats).toEqual({ toolCalls: 1, tokensIn: 0, tokensOut: 0, subagents: 0 });
    source.apply([ev('post_tool_call', { tool: 'web_search', ok: false })]);
    expect(office.get(ID)!.activity).toMatchObject({ kind: 'error', tool: 'web_search' });
    source.apply([ev('post_llm_call')]);
    expect(office.get(ID)!.status).toBe('idle');
    // on_session_end vem no fim de cada conversa: só fica à toa.
    source.apply([ev('pre_llm_call'), ev('on_session_end')]);
    expect(office.get(ID)!.status).toBe('idle');
    source.apply([ev('on_session_finalize')]);
    expect(office.get(ID)!.status).toBe('offline');
    expect(source.sources()).toEqual([{ label: 'hermes', provider: 'hermes', path: 'tailnet', sessions: 0, ok: true }]);
  });

  it('aprovação: precisa de você até a resposta; reset também fecha', () => {
    const { office, source, ev } = setup();
    source.apply([ev('pre_tool_call', { tool: 'terminal' }), ev('pre_approval_request')]);
    expect(office.get(ID)).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    source.apply([ev('post_approval_response')]);
    expect(office.get(ID)!.status).toBe('working');
    source.apply([ev('on_session_reset')]);
    expect(office.get(ID)!.status).toBe('offline');
  });

  it('evento no meio de uma sessão desconhecida (o Habblaud reiniciou): o agente aparece já trabalhando', () => {
    const { office, source, ev } = setup();
    source.apply([ev('pre_tool_call', { tool: 'read_file', platform: undefined })]);
    expect(office.get(ID)).toMatchObject({ status: 'working', title: 'Hermes · Íon', activity: { text: 'Lendo arquivo' } });
  });

  it('silêncio: trabalhando sem notícia por 5 min fica à toa; sem nada por 6 h sai do escritório', () => {
    const { clock, office, source, ev } = setup();
    source.apply([ev('pre_llm_call')]);
    clock.t += HERMES_QUIET_MS - 1;
    source.tick();
    expect(office.get(ID)!.status).toBe('working');
    clock.t += 1;
    source.tick();
    expect(office.get(ID)!.status).toBe('idle');
    clock.t += HERMES_STALE_MS;
    source.tick();
    expect(office.get(ID)!.status).toBe('offline');
    expect(source.sources()[0].sessions).toBe(0);
  });

  it('horário da VPS adiantado não põe atividade no futuro', () => {
    const { clock, office, source, ev } = setup();
    source.apply([ev('pre_tool_call', { tool: 'patch', at: clock.t + 60_000 })]);
    expect(office.get(ID)!.activity!.at).toBe(clock.t);
  });

  it('ferramentas: as conhecidas pelo nome; o resto "Usando <ferramenta>"', () => {
    expect(describeHermesTool('write_file')).toMatchObject({ kind: 'write', text: 'Escrevendo arquivo' });
    expect(describeHermesTool('browser_navigate')).toMatchObject({ kind: 'browser' });
    expect(describeHermesTool('delegate_task')).toMatchObject({ kind: 'delegate' });
    expect(describeHermesTool('mcp_github_create_issue')).toMatchObject({ kind: 'mcp', text: 'Usando mcp_github_create_issue' });
    expect(describeHermesTool('cronjob')).toMatchObject({ kind: 'other', text: 'Usando cronjob' });
  });
});
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/sources/hermes` → falha: `Failed to load url ./source`.

- [ ] **Step 3: Implementação** — `server/sources/hermes/source.ts`:

```ts
// Fonte do Hermes (Fase 6): as sessões do Hermes Agent da VPS, vistas pelos eventos que o plugin habblaud-observer
// manda para POST /api/hermes/events (server/hermes/http.ts). Só observa. Nada de texto de mensagem, argumento,
// resultado, comando ou id de quem falou chega aqui: só o perfil, a plataforma, um hash da sessão, o evento, o nome da
// ferramenta, se deu certo, a duração, o horário e o modelo. Um agente por sessão, numa sala por perfil
// ("hermes:/<perfil>", fora das pastas sugeridas no Novo agente por não ser caminho absoluto); sem transcript (o
// terminal fica vazio) e sem tokens (stats zerados). Agentes do Hermes nunca vão ao Habblaud World
// (shared/world/projection.ts só aceita claude e codex).
import { SPECIAL, type ActivityDescription } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { Activity, Provider, SourceInfo } from '../../../shared/types';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

/** Os ganchos do Hermes que o plugin manda, com os nomes do próprio Hermes. */
export const HERMES_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
] as const;
export type HermesEventName = (typeof HERMES_EVENTS)[number];

/** Um evento já validado (server/hermes/http.ts, parseHermesBatch). */
export interface HermesEvent {
  profile: string;
  platform?: string;
  /** 16 hex: sha256 do perfil + id da sessão, cortada (o id cru nunca sai da VPS). */
  session: string;
  event: HermesEventName;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  /** Epoch ms no relógio da VPS. */
  at: number;
  model?: string;
}

/** Conta (AgentInfo.account) de todos os agentes do Hermes: não há conta local, o chip mostra "H". */
export const HERMES_ACCOUNT = 'hermes';
/** Trabalhando sem notícia por este tempo (o post_llm_call se perdeu): volta a "à toa". */
export const HERMES_QUIET_MS = 5 * 60_000;
/** Sem nenhum evento por este tempo (gateway parado, VPS fora): a sessão sai do escritório. */
export const HERMES_STALE_MS = 6 * 60 * 60_000;

export function hermesAgentId(session: string): string {
  return `hermes:${session}`;
}

/** Atividade de uma ferramenta do Hermes só pelo nome (os argumentos nunca chegam). */
export function describeHermesTool(name: string): ActivityDescription {
  const n = name.toLowerCase();
  if (n === 'terminal' || n === 'process' || n === 'execute_code') return { kind: 'run', icon: '🖥️', text: tr('Rodando um comando') };
  if (n === 'read_file') return { kind: 'read', icon: '📖', text: tr('Lendo arquivo') };
  if (n === 'write_file') return { kind: 'write', icon: '📝', text: tr('Escrevendo arquivo') };
  if (n === 'patch') return { kind: 'edit', icon: '✏️', text: tr('Editando arquivo') };
  if (n === 'search_files') return { kind: 'search', icon: '🔎', text: tr('Buscando nos arquivos') };
  if (n === 'web_search') return { kind: 'web', icon: '🌐', text: tr('Pesquisando na web') };
  if (n === 'web_extract') return { kind: 'web', icon: '🌐', text: tr('Lendo uma página') };
  if (n.startsWith('browser_')) return { kind: 'browser', icon: '🧭', text: tr('Navegando no navegador') };
  if (n === 'delegate_task') return { kind: 'delegate', icon: '👥', text: tr('Delegando a um subagente') };
  if (n === 'todo') return { kind: 'plan', icon: '📋', text: tr('Atualizando as tarefas') };
  if (n.startsWith('skill')) return { kind: 'skill', icon: '🧩', text: tr('Usando uma skill') };
  if (n === 'send_message') return { kind: 'communicate', icon: '✉️', text: tr('Mandando uma mensagem') };
  if (n === 'clarify') return { kind: 'ask', icon: '❓', text: tr('Perguntando ao usuário') };
  if (n.startsWith('mcp_')) return { kind: 'mcp', icon: '🔌', text: tr('Usando {0}', [name]) };
  return { kind: 'other', icon: '🔧', text: tr('Usando {0}', [name]) };
}

interface Session {
  id: string;
  title: string;
  lastAt: number;
  toolCalls: number;
  model?: string;
}

export interface HermesSourceOptions {
  office: Office;
  now?: () => number;
  /** Intervalo do relógio que põe à toa e tira as sessões paradas (padrão 10 s). */
  tickMs?: number;
}

export class HermesSource implements AgentSource {
  readonly provider: Provider = 'hermes';
  private readonly sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly o: HermesSourceOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Sem boot: o Hermes não deixa nada para reler; a sessão aparece no próximo evento dela. */
  start(): void {
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return [{ label: HERMES_ACCOUNT, provider: 'hermes', path: 'tailnet', sessions: this.sessions.size, ok: true }];
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Aplica um lote, na ordem. Um evento que falha não derruba os outros (vai para o log). */
  apply(events: readonly HermesEvent[]): void {
    for (const ev of events) {
      try {
        this.applyOne(ev);
      } catch (err) {
        log.warnOnce(`hermes-event:${errMsg(err)}`, tr('Eventos do Hermes: falha ao aplicar um evento ({0}).', [errMsg(err)]));
      }
    }
  }

  /** Trabalhando e quieto há HERMES_QUIET_MS: à toa. Sem evento há HERMES_STALE_MS (ou já fora do escritório): sai. */
  tick(): void {
    const now = this.now();
    for (const [session, s] of this.sessions) {
      const status = this.o.office.get(s.id)?.status;
      if (status === undefined || now - s.lastAt >= HERMES_STALE_MS) {
        this.sessions.delete(session);
        this.o.office.closeMain(s.id);
      } else if (status === 'working' && now - s.lastAt >= HERMES_QUIET_MS) this.o.office.setStatus(s.id, 'idle');
    }
  }

  private applyOne(ev: HermesEvent): void {
    const office = this.o.office;
    const id = hermesAgentId(ev.session);
    if (ev.event === 'on_session_finalize' || ev.event === 'on_session_reset') {
      this.sessions.delete(ev.session);
      office.closeMain(id);
      return;
    }
    const s = this.ensure(ev, id);
    switch (ev.event) {
      case 'pre_llm_call':
        office.setStatus(id, 'working');
        this.activity(id, ev, { kind: 'prompt', icon: '💬', text: tr('Recebeu uma mensagem') });
        break;
      case 'pre_tool_call':
        s.toolCalls++;
        office.setStatus(id, 'working');
        if (ev.tool) this.activity(id, ev, describeHermesTool(ev.tool), ev.tool);
        break;
      case 'post_tool_call':
        if (ev.ok === false) this.activity(id, ev, SPECIAL.error(ev.tool), ev.tool);
        break;
      case 'pre_approval_request':
        office.setStatus(id, 'waiting', tr('aprovar um comando'));
        break;
      case 'post_approval_response':
        office.setStatus(id, 'working');
        break;
      // O on_session_end do Hermes vem no fim de cada conversa (run_conversation), não quando a sessão fecha.
      case 'post_llm_call':
      case 'on_session_end':
        office.setStatus(id, 'idle');
        break;
      case 'on_session_start':
        break;
    }
    office.applyTranscript(id, {
      title: s.title,
      tasks: [],
      stats: { toolCalls: s.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 },
      model: s.model,
      lastAt: this.at(ev),
    });
  }

  /** A sessão (e o agente) deste evento; cria se for nova ou se o Habblaud reiniciou no meio dela. */
  private ensure(ev: HermesEvent, id: string): Session {
    const title = `Hermes · ${ev.profile}${ev.platform ? ` (${ev.platform})` : ''}`;
    let s = this.sessions.get(ev.session);
    if (!s) {
      s = { id, title, lastAt: this.now(), toolCalls: 0 };
      this.sessions.set(ev.session, s);
    }
    if (ev.platform) s.title = title;
    if (ev.model) s.model = ev.model;
    s.lastAt = this.now();
    const cur = this.o.office.get(id);
    if (!cur || cur.status === 'offline') {
      this.o.office.addMain({
        id,
        provider: 'hermes',
        account: HERMES_ACCOUNT,
        sessionId: ev.session,
        cwd: `hermes:/${ev.profile}`,
        role: tr('Agente do Hermes'),
        startedAt: this.at(ev),
        status: 'idle',
      });
    }
    return s;
  }

  private activity(id: string, ev: HermesEvent, d: ActivityDescription, tool?: string): void {
    const act: Activity = { id: `${id}#h:${++this.seq}`, at: this.at(ev), kind: d.kind, icon: d.icon, text: d.text };
    if (tool) act.tool = tool;
    if (ev.durationMs !== undefined) act.durationMs = ev.durationMs;
    this.o.office.addActivity(id, act, true);
  }

  /** O horário do evento, nunca no futuro do relógio daqui (o da VPS pode estar adiantado). */
  private at(ev: HermesEvent): number {
    return Math.min(ev.at, this.now());
  }
}
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/sources/hermes` → 6 testes verdes.

- [ ] **Step 5: Traduções** — bloco `// Fase 6 — Hermes` no fim de cada locale (antes do `};`), com estas chaves (as
  outras de `describeHermesTool` já existem):

  `shared/locales/en.ts` (o comentário `// Fase 6 — Hermes` só na primeira vez, nesta task):

```ts
  // Fase 6 — Hermes
  "Rodando um comando": "Running a command",
  "Buscando nos arquivos": "Searching the files",
  "Delegando a um subagente": "Delegating to a subagent",
  "Atualizando as tarefas": "Updating the tasks",
  "Usando uma skill": "Using a skill",
  "Mandando uma mensagem": "Sending a message",
  "Perguntando ao usuário": "Asking the user",
  "Eventos do Hermes: falha ao aplicar um evento ({0}).": "Hermes events: failed to apply an event ({0}).",
  "Recebeu uma mensagem": "Got a message",
  "Agente do Hermes": "Hermes agent",
```

  `shared/locales/es.ts` (o comentário `// Fase 6 — Hermes` só na primeira vez, nesta task):

```ts
  // Fase 6 — Hermes
  "Rodando um comando": "Ejecutando un comando",
  "Buscando nos arquivos": "Buscando en los archivos",
  "Delegando a um subagente": "Delegando a un subagente",
  "Atualizando as tarefas": "Actualizando las tareas",
  "Usando uma skill": "Usando una skill",
  "Mandando uma mensagem": "Enviando un mensaje",
  "Perguntando ao usuário": "Preguntando al usuario",
  "Eventos do Hermes: falha ao aplicar um evento ({0}).": "Eventos de Hermes: error al aplicar un evento ({0}).",
  "Recebeu uma mensagem": "Recibió un mensaje",
  "Agente do Hermes": "Agente de Hermes",
```

  `shared/locales/fr.ts` (o comentário `// Fase 6 — Hermes` só na primeira vez, nesta task):

```ts
  // Fase 6 — Hermes
  "Rodando um comando": "Exécute une commande",
  "Buscando nos arquivos": "Cherche dans les fichiers",
  "Delegando a um subagente": "Délègue à un sous-agent",
  "Atualizando as tarefas": "Met à jour les tâches",
  "Usando uma skill": "Utilise une skill",
  "Mandando uma mensagem": "Envoie un message",
  "Perguntando ao usuário": "Pose une question à l'utilisateur",
  "Eventos do Hermes: falha ao aplicar um evento ({0}).": "Événements Hermes : échec de l'application d'un événement ({0}).",
  "Recebeu uma mensagem": "A reçu un message",
  "Agente do Hermes": "Agent Hermes",
```

- [ ] **Step 6: Conferir** — `npm run typecheck && npm run i18n:check` → verdes (as chaves desta task traduzidas).

- [ ] **Step 7: Commit**

```bash
git add server/sources/hermes/source.ts server/sources/hermes/source.test.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "HermesSource: um agente por sessão do Hermes, só com o que o evento traz"
```

---

### Task 4: `POST /api/hermes/events` — token, formato estrito e freio

**Files:**
- Create: `server/hermes/token.ts`, `server/hermes/http.ts`
- Test: `server/hermes/http.test.ts`
- Modify: `server/config.ts` (`ServerConfig.hermes`/`hermesWarning`, `SECRET_ENV`, `loadConfig`)
- Modify: `server/http/remote.test.ts` (`describe('segredos fora do ambiente dos filhos')`)
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `HttpError`, `readJson`, `sendJson` (`server/http/app.ts`); `HERMES_EVENTS`, `HermesEvent`,
  `HermesEventName` (Task 3).
- Produces: `server/hermes/token.ts`: `parseHermesTokenHash(raw: string | undefined): Buffer | undefined`,
  `bearerMatches(header: string | undefined, hash: Buffer): boolean`. `server/hermes/http.ts`:
  `HERMES_EVENTS_PATH = '/api/hermes/events'`, `HERMES_BODY_MAX = 65_536`, `HERMES_BATCH_MAX = 100`,
  `parseHermesBatch(raw: unknown): HermesEvent[]` (lança `HttpError(400)`), `class FixedWindowLimiter(max, windowMs, now?)`
  com `take(): boolean`, `interface HermesIngestOptions { tokenHash: Buffer; apply(events): void; limiter? }`,
  `createHermesIngest(o): (req, res, url: URL) => boolean`. `ServerConfig.hermes?: { tokenHash: Buffer }` (só com a
  porta da tailnet) e `ServerConfig.hermesWarning?: string`.

- [ ] **Step 1: Teste (falhando)** — `server/hermes/http.test.ts`:

```ts
// Rota dos eventos do Hermes (server/hermes/http.ts) e o token (server/hermes/token.ts): formato estrito (nenhuma chave
// a mais passa, então nenhum texto entra por engano), token só pela hash, 64 KB, freio e só POST. A recusa nas portas
// 4747 e 4748 e a ordem dentro da porta da tailnet estão em server/http/tailnet.test.ts. Dados sintéticos.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../http/app';
import { setQuiet } from '../log';
import type { HermesEvent } from '../sources/hermes/source';
import { createHermesIngest, FixedWindowLimiter, HERMES_BATCH_MAX, parseHermesBatch } from './http';
import { bearerMatches, parseHermesTokenHash } from './token';

setQuiet(true);

const TOKEN = 'tok_'.padEnd(43, 'x');
const HASH = createHash('sha256').update(TOKEN).digest();
const EV = { profile: 'Íon', platform: 'telegram', session: '0123456789abcdef', event: 'pre_tool_call', tool: 'terminal', at: 1_800_000_000_000 };

const status400 = (raw: unknown) => {
  try {
    parseHermesBatch(raw);
    return 'passou';
  } catch (err) {
    return err instanceof HttpError ? err.status : 'outro erro';
  }
};

describe('token do Hermes', () => {
  it('hash: só sha256:<64 hex>', () => {
    expect(parseHermesTokenHash(`sha256:${HASH.toString('hex')}`)).toEqual(HASH);
    expect(parseHermesTokenHash(` SHA256:${HASH.toString('hex').toUpperCase()} `)).toEqual(HASH);
    for (const raw of [undefined, '', HASH.toString('hex'), 'sha256:abc', `scrypt:${HASH.toString('hex')}`]) expect(parseHermesTokenHash(raw), String(raw)).toBeUndefined();
  });
  it('Bearer: o token certo passa; errado, ausente, curto ou sem "Bearer" não', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, HASH)).toBe(true);
    for (const h of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, 'Bearer curto', `Bearer ${TOKEN} `]) expect(bearerMatches(h, HASH), String(h)).toBe(false);
  });
});

describe('parseHermesBatch', () => {
  it('aceita o formato do plugin e devolve duration_ms como durationMs', () => {
    expect(parseHermesBatch({ v: 1, events: [EV, { ...EV, event: 'post_tool_call', ok: false, duration_ms: 1500, model: 'gpt-6-luna' }] })).toEqual([
      EV,
      { ...EV, event: 'post_tool_call', ok: false, durationMs: 1500, model: 'gpt-6-luna' },
    ]);
  });
  it('recusa (400) envelope errado, lote vazio ou grande demais', () => {
    for (const raw of [null, [], {}, { v: 2, events: [EV] }, { v: 1, events: [] }, { v: 1, events: Array(HERMES_BATCH_MAX + 1).fill(EV) }, { v: 1, events: [EV], extra: 1 }]) {
      expect(status400(raw), JSON.stringify(raw)?.slice(0, 60)).toBe(400);
    }
  });
  it('recusa (400) qualquer chave a mais: texto de mensagem, argumentos, resultado, comando, remetente', () => {
    for (const k of ['user_message', 'assistant_response', 'args', 'result', 'command', 'sender_id', 'session_id', 'description']) {
      expect(status400({ v: 1, events: [{ ...EV, [k]: 'CANARIO' }] }), k).toBe(400);
    }
  });
  it('recusa (400) campo fora do formato', () => {
    const bad: Array<Record<string, unknown>> = [
      { session: '0123456789ABCDEF' },
      { session: 'sessao-crua-do-telegram' },
      { event: 'on_message' },
      { profile: '' },
      { profile: 'a'.repeat(41) },
      { profile: 'íon\n' },
      { platform: 'Telegram Group 123' },
      { tool: 'rm -rf /' },
      { tool: 'x'.repeat(65) },
      { ok: 'false' },
      { duration_ms: -1 },
      { duration_ms: 1.5 },
      { at: '2026-11-01' },
      { at: 0 },
      { model: 'gpt 6' },
    ];
    for (const b of bad) expect(status400({ v: 1, events: [{ ...EV, ...b }] }), JSON.stringify(b)).toBe(400);
  });
});

describe('FixedWindowLimiter', () => {
  it('max por janela; a janela seguinte zera', () => {
    let t = 0;
    const l = new FixedWindowLimiter(2, 1000, () => t);
    expect([l.take(), l.take(), l.take()]).toEqual([true, true, false]);
    t = 1000;
    expect(l.take()).toBe(true);
  });
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(limiter?: FixedWindowLimiter) {
  const applied: HermesEvent[][] = [];
  const ingest = createHermesIngest({ tokenHash: HASH, apply: (evs) => void applied.push([...evs]), limiter });
  const server = http.createServer((req, res) => {
    if (!ingest(req, res, new URL(req.url ?? '/', 'http://x'))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () => new Promise((ok) => server.close(() => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}, path = '/api/hermes/events', method = 'POST') =>
    fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { applied, post };
}

describe('createHermesIngest', () => {
  it('token certo e corpo válido: 200 {ok, n} e os eventos vão para a fonte', async () => {
    const s = await serve();
    const r = await s.post({ v: 1, events: [EV] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, n: 1 });
    expect(s.applied).toEqual([[EV]]);
  });
  it('token errado ou ausente: 401; corpo inválido: 400; JSON quebrado: 400; sem JSON: 415; acima de 64 KB: 413; GET: 405; nada aplicado', async () => {
    const s = await serve();
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: 'Bearer '.padEnd(50, 'y') })).status).toBe(401);
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: '' })).status).toBe(401);
    expect((await s.post({ v: 1, events: [{ ...EV, user_message: 'CANARIO' }] })).status).toBe(400);
    expect((await s.post('{"v":1,')).status).toBe(400);
    expect((await s.post({ v: 1, events: [EV] }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await s.post({ v: 1, events: [{ ...EV, model: 'x' }], pad: 'x'.repeat(70 * 1024) })).status).toBe(413);
    const get = await s.post(undefined, {}, '/api/hermes/events', 'GET');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(s.applied).toEqual([]);
  });
  it('outro caminho (mesmo variante): não é da rota (segue para o login)', async () => {
    const s = await serve();
    expect((await s.post({ v: 1, events: [EV] }, {}, '/api/hermes/events/')).status).toBe(418);
    expect((await s.post({ v: 1, events: [EV] }, {}, '/api/hermes')).status).toBe(418);
    expect(s.applied).toEqual([]);
  });
  it('freio: acima do limite, 429 com Retry-After, antes até de conferir o token', async () => {
    const s = await serve(new FixedWindowLimiter(2, 60_000));
    expect((await s.post({ v: 1, events: [EV] })).status).toBe(200);
    expect((await s.post({ v: 1, events: [EV] }, { Authorization: '' })).status).toBe(401);
    const r = await s.post({ v: 1, events: [EV] });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
    expect(s.applied).toHaveLength(1);
  });
});
```

  e em `server/http/remote.test.ts`, no `it('scrubSecretsFromEnv: …')`: no objeto `env`, depois de
  `HABBLAUD_TAILNET_USER: 'ana@example.com',`:

```ts
      HABBLAUD_HERMES_TOKEN_HASH: `sha256:${'ab'.repeat(32)}`,
```

  e depois de `expect(config.tailnet?.user).toBe('ana@example.com');`:

```ts
    expect(config.hermes?.tokenHash).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
```

  (o `expect(Object.keys(env).sort())` existente continua igual: a hash precisa sair do ambiente). E, no mesmo
  `describe`, depois desse `it`:

```ts
  it('eventos do Hermes: hash inválida ou sem a porta da tailnet ficam desligados, com o motivo', () => {
    const base = { HOME: '/h', HABBLAUD_REMOTE_USER: 'ana', HABBLAUD_REMOTE_PASSWORD_HASH: HASH_TEXT, HABBLAUD_REMOTE_INSECURE_HTTP: '1' };
    const ok = `sha256:${'ab'.repeat(32)}`;
    expect(loadConfig(base, [])).toMatchObject({ hermes: undefined, hermesWarning: undefined });
    expect(loadConfig({ ...base, HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_HERMES_TOKEN_HASH: 'abc' }, [])).toMatchObject({ hermes: undefined, hermesWarning: expect.stringMatching(/sha256/) });
    expect(loadConfig({ ...base, HABBLAUD_HERMES_TOKEN_HASH: ok }, [])).toMatchObject({ hermes: undefined, hermesWarning: expect.stringMatching(/HABBLAUD_TAILNET_USER/) });
    expect(loadConfig({ ...base, HABBLAUD_TAILNET_USER: 'a@b', HABBLAUD_HERMES_TOKEN_HASH: ok }, []).hermes).toBeDefined();
  });
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/hermes server/http/remote.test.ts -t "Hermes|segredos"` → falha:
  `Failed to load url ./http` e `config.hermes` indefinido.

- [ ] **Step 3: Implementação** — `server/hermes/token.ts`:

```ts
// Token do plugin habblaud-observer (Fase 6): só a sha256 dele fica no .env (HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>).
// O token é aleatório de 32 bytes, então uma hash lenta (scrypt) não protege mais nada e custaria CPU a cada evento.
import { createHash, timingSafeEqual } from 'node:crypto';

/** `sha256:<64 hex>` → os 32 bytes da hash; qualquer outra coisa → undefined. */
export function parseHermesTokenHash(raw: string | undefined): Buffer | undefined {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(raw?.trim() ?? '');
  return m ? Buffer.from(m[1], 'hex') : undefined;
}

/** `Authorization: Bearer <token>` com a sha256 igual a `hash` (comparação em tempo constante). */
export function bearerMatches(header: string | undefined, hash: Buffer): boolean {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '');
  return !!m && timingSafeEqual(createHash('sha256').update(m[1]).digest(), hash);
}
```

  `server/hermes/http.ts`:

```ts
// Eventos do Hermes (Fase 6): o plugin habblaud-observer, na VPS, manda o que o Hermes está fazendo para
// POST /api/hermes/events na porta da tailnet (http/tailnet.ts). É a ÚNICA rota dessa porta que não pede o login
// remoto. Antes dela já passaram o guard (Host .ts.net, Origin, JSON) e o usuário do Tailscale (a VPS é do mesmo dono,
// então o tailscale serve põe o cabeçalho); aqui ela pede um freio de requisições, o token Bearer (só a sha256 no .env,
// server/hermes/token.ts), corpo JSON até 64 KB e o formato exato (chave a mais = 400: nenhum texto entra por engano).
// Nas portas 4747 e 4748 a rota não existe (404): quem a trata é só o listener da tailnet, no server/index.ts.
//
//   POST /api/hermes/events  (Bearer)  {v: 1, events: [{profile, platform?, session, event, tool?, ok?, duration_ms?, at, model?}]}
//                                       → 200 {ok: true, n}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { HERMES_EVENTS, type HermesEvent, type HermesEventName } from '../sources/hermes/source';
import { bearerMatches } from './token';

export const HERMES_EVENTS_PATH = '/api/hermes/events';
export const HERMES_BODY_MAX = 64 * 1024;
export const HERMES_BATCH_MAX = 100;

const PROFILE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const PLATFORM = /^[a-z0-9_-]{1,20}$/;
const SESSION = /^[0-9a-f]{16}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{1,80}$/;
const KEYS = new Set(['profile', 'platform', 'session', 'event', 'tool', 'ok', 'duration_ms', 'at', 'model']);
const DAY_MS = 86_400_000;

function bad(what: string): never {
  throw new HttpError(400, tr('evento do Hermes inválido ({0})', [what]));
}

/** Corpo de POST /api/hermes/events, campo a campo; qualquer coisa fora do formato: HttpError 400. */
export function parseHermesBatch(raw: unknown): HermesEvent[] {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const events = r?.events;
  if (!r || r.v !== 1 || !Array.isArray(events) || !events.length || events.length > HERMES_BATCH_MAX || Object.keys(r).some((k) => k !== 'v' && k !== 'events')) {
    throw new HttpError(400, tr('esperado {v: 1, events: [1 a {0} eventos do Hermes]}', [HERMES_BATCH_MAX]));
  }
  return events.map(parseEvent);
}

function parseEvent(raw: unknown): HermesEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('objeto');
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!KEYS.has(k)) bad(k);
  const { profile, platform, session, event, tool, ok, duration_ms: duration, at, model } = e;
  if (typeof profile !== 'string' || !PROFILE.test(profile)) bad('profile');
  if (typeof session !== 'string' || !SESSION.test(session)) bad('session');
  if (typeof event !== 'string' || !(HERMES_EVENTS as readonly string[]).includes(event)) bad('event');
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) bad('at');
  const out: HermesEvent = { profile, session, event: event as HermesEventName, at };
  if (platform !== undefined) {
    if (typeof platform !== 'string' || !PLATFORM.test(platform)) bad('platform');
    out.platform = platform;
  }
  if (tool !== undefined) {
    if (typeof tool !== 'string' || !TOOL.test(tool)) bad('tool');
    out.tool = tool;
  }
  if (ok !== undefined) {
    if (typeof ok !== 'boolean') bad('ok');
    out.ok = ok;
  }
  if (duration !== undefined) {
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0 || duration > DAY_MS) bad('duration_ms');
    out.durationMs = duration;
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || !MODEL.test(model)) bad('model');
    out.model = model;
  }
  return out;
}

/** Freio simples: no máximo `max` requisições por janela fixa de `windowMs`. */
export class FixedWindowLimiter {
  private start = -Infinity;
  private n = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(): boolean {
    const t = this.now();
    if (t - this.start >= this.windowMs) {
      this.start = t;
      this.n = 0;
    }
    return ++this.n <= this.max;
  }
}

export interface HermesIngestOptions {
  /** sha256 do token (parseHermesTokenHash). */
  tokenHash: Buffer;
  /** Quem recebe os eventos válidos (HermesSource.apply). */
  apply: (events: readonly HermesEvent[]) => void;
  /** Padrão: 60 requisições a cada 10 s (o plugin junta até 50 eventos por requisição). */
  limiter?: FixedWindowLimiter;
}

/**
 * Trata POST /api/hermes/events no listener da tailnet, ANTES do login (o guard e o usuário do Tailscale já passaram).
 * Devolve false para qualquer outro caminho (inclusive variantes como "/api/hermes/events/"), que segue para o login.
 */
export function createHermesIngest(o: HermesIngestOptions): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const limiter = o.limiter ?? new FixedWindowLimiter(60, 10_000);
  return (req, res, url) => {
    if (url.pathname !== HERMES_EVENTS_PATH) return false;
    const refuse = (status: number, error: string, headers: Record<string, string> = {}) => {
      req.resume();
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      sendJson(res, status, { error });
    };
    if (req.method !== 'POST') refuse(405, tr('método não permitido'), { Allow: 'POST' });
    else if (!limiter.take()) refuse(429, tr('muitos eventos do Hermes: tente de novo em instantes'), { 'Retry-After': '10' });
    else if (!bearerMatches(req.headers.authorization, o.tokenHash)) refuse(401, tr('token do Hermes inválido'));
    else {
      readJson(req, HERMES_BODY_MAX)
        .then((body) => {
          const events = parseHermesBatch(body);
          o.apply(events);
          sendJson(res, 200, { ok: true, n: events.length });
        })
        .catch((err) => {
          if (res.headersSent) return void res.destroy();
          if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
          else sendJson(res, 500, { error: tr('erro interno') });
        });
    }
    return true;
  };
}
```

  `server/config.ts` — import, depois do de `./http/tailnet`:

```ts
import { parseHermesTokenHash } from './hermes/token';
```

  na `interface ServerConfig`, depois de `tailnetWarning?: string;`:

```ts
  /**
   * Eventos do Hermes (Fase 6, server/hermes/http.ts): a sha256 do token do plugin habblaud-observer
   * (HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>). Só com a porta da tailnet; ausente = rota inexistente.
   */
  hermes?: { tokenHash: Buffer };
  /** Por que os eventos do Hermes ficaram desligados com HABBLAUD_HERMES_TOKEN_HASH definido. */
  hermesWarning?: string;
```

  `SECRET_ENV` ganha `'HABBLAUD_HERMES_TOKEN_HASH'`:

```ts
const SECRET_ENV = ['HABBLAUD_REMOTE_PASSWORD_HASH', 'HABBLAUD_REMOTE_PASSWORD', 'HABBLAUD_REMOTE_USER', 'HABBLAUD_TAILNET_USER', 'HABBLAUD_HERMES_TOKEN_HASH'] as const;
```

  em `loadConfig`, depois de `const tailnet = parseTailnetConfig(…);`:

```ts
  const hermesRaw = env.HABBLAUD_HERMES_TOKEN_HASH?.trim();
  const hermesHash = parseHermesTokenHash(hermesRaw);
```

  e no objeto devolvido, depois de `tailnetWarning: tailnet.warning,`:

```ts
    hermes: hermesHash && tailnet.config ? { tokenHash: hermesHash } : undefined,
    hermesWarning: !hermesRaw
      ? undefined
      : !hermesHash
        ? tr('eventos do Hermes desligados: HABBLAUD_HERMES_TOKEN_HASH inválido (esperado sha256:<64 hex>)')
        : !tailnet.config
          ? tr('eventos do Hermes desligados: precisam da porta da tailnet (HABBLAUD_TAILNET_USER)')
          : undefined,
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/hermes server/http/remote.test.ts` → verde.

- [ ] **Step 5: Traduções** (bloco `// Fase 6 — Hermes`):

  `shared/locales/en.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "eventos do Hermes desligados: HABBLAUD_HERMES_TOKEN_HASH inválido (esperado sha256:<64 hex>)": "Hermes events off: invalid HABBLAUD_HERMES_TOKEN_HASH (expected sha256:<64 hex>)",
  "eventos do Hermes desligados: precisam da porta da tailnet (HABBLAUD_TAILNET_USER)": "Hermes events off: they need the tailnet port (HABBLAUD_TAILNET_USER)",
  "evento do Hermes inválido ({0})": "invalid Hermes event ({0})",
  "esperado {v: 1, events: [1 a {0} eventos do Hermes]}": "expected {v: 1, events: [1 to {0} Hermes events]}",
  "muitos eventos do Hermes: tente de novo em instantes": "too many Hermes events: try again shortly",
  "token do Hermes inválido": "invalid Hermes token",
```

  `shared/locales/es.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "eventos do Hermes desligados: HABBLAUD_HERMES_TOKEN_HASH inválido (esperado sha256:<64 hex>)": "eventos de Hermes desactivados: HABBLAUD_HERMES_TOKEN_HASH no válido (se esperaba sha256:<64 hex>)",
  "eventos do Hermes desligados: precisam da porta da tailnet (HABBLAUD_TAILNET_USER)": "eventos de Hermes desactivados: necesitan el puerto de la tailnet (HABBLAUD_TAILNET_USER)",
  "evento do Hermes inválido ({0})": "evento de Hermes no válido ({0})",
  "esperado {v: 1, events: [1 a {0} eventos do Hermes]}": "se esperaba {v: 1, events: [1 a {0} eventos de Hermes]}",
  "muitos eventos do Hermes: tente de novo em instantes": "demasiados eventos de Hermes: inténtalo de nuevo en unos instantes",
  "token do Hermes inválido": "token de Hermes no válido",
```

  `shared/locales/fr.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "eventos do Hermes desligados: HABBLAUD_HERMES_TOKEN_HASH inválido (esperado sha256:<64 hex>)": "événements Hermes désactivés : HABBLAUD_HERMES_TOKEN_HASH invalide (attendu sha256:<64 hex>)",
  "eventos do Hermes desligados: precisam da porta da tailnet (HABBLAUD_TAILNET_USER)": "événements Hermes désactivés : ils ont besoin du port du tailnet (HABBLAUD_TAILNET_USER)",
  "evento do Hermes inválido ({0})": "événement Hermes invalide ({0})",
  "esperado {v: 1, events: [1 a {0} eventos do Hermes]}": "attendu {v: 1, events: [1 à {0} événements Hermes]}",
  "muitos eventos do Hermes: tente de novo em instantes": "trop d'événements Hermes : réessayez dans un instant",
  "token do Hermes inválido": "jeton Hermes invalide",
```

- [ ] **Step 6: Conferir** — `npm run typecheck && npm run i18n:check` → verdes.

- [ ] **Step 7: Commit**

```bash
git add server/hermes/token.ts server/hermes/http.ts server/hermes/http.test.ts server/config.ts server/http/remote.test.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Eventos do Hermes: rota com token (só a hash no .env), formato estrito, 64 KB e freio"
```

---

### Task 5: Ligar no servidor — a rota só na porta da tailnet, antes do login

**Files:**
- Modify: `server/index.ts` (imports; fonte depois do Codex ~149; listener da tailnet ~526-548; log da subida ~580)
- Modify: `server/http/tailnet.test.ts` (função `start()`: porta local e a rota do Hermes na cadeia da tailnet; testes novos)
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `HermesSource` (Task 3); `createHermesIngest`, `HERMES_EVENTS_PATH` (Task 4); `config.hermes`,
  `config.hermesWarning` (Task 4).
- Produces: no `start()` de `tailnet.test.ts`, o retorno ganha `localBase` e `hermesApplied: HermesEvent[]`.

- [ ] **Step 1: Testes da cadeia** (a função `start()` espelha o `index.ts`) — em `server/http/tailnet.test.ts`:
  - imports: `import { createHash } from 'node:crypto';` (primeira linha) e, depois de
    `import { TerminalStreams } from './terminal';`:

```ts
import { createHermesIngest } from '../hermes/http';
import type { HermesEvent } from '../sources/hermes/source';
```

  - depois de `const TS = { Host: TS_HOST, 'Tailscale-User-Login': 'ana@example.com' };`:

```ts
const HERMES_TOKEN = 'tok_'.padEnd(43, 'h');
const HERMES_HASH = createHash('sha256').update(HERMES_TOKEN).digest();
const HERMES_AUTH = { Authorization: `Bearer ${HERMES_TOKEN}` };
const HERMES_BODY = { v: 1, events: [{ profile: 'Íon', session: '0123456789abcdef', event: 'on_session_start', at: 1_800_000_000_000 }] };
```

  - em `start()`, logo depois da função `page`:

```ts
  // Eventos do Hermes: como no index.ts, só no listener da tailnet, depois do usuário do Tailscale e antes do login.
  const hermesApplied: HermesEvent[] = [];
  const hermesIngest = createHermesIngest({ tokenHash: HERMES_HASH, apply: (evs) => void hermesApplied.push(...evs) });
  // A porta local (4747): só o guard e a API, como no index.ts.
  const local = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) page(res);
  });
  local.listen(0, '127.0.0.1');
```

  - na cadeia da tailnet do `start()`, entre `const url = …` e `if (tsGate(req, res, url)) return;`:

```ts
      if (hermesIngest(req, res, url)) return;
```

  - `const lanBase = await listen(lan);` ganha antes `const localBase = await listen(local);`, e o `return` vira
    `return { localBase, lanBase, tsBase, ptyCalls, hermesApplied, advance: (ms: number) => void (clock += ms) };`
  - no fim do arquivo:

```ts
describe('eventos do Hermes: só pela porta da tailnet, com o usuário do Tailscale e o token, sem login', () => {
  it('tailnet com o usuário do Tailscale e o token, sem login: 200 e o evento chega à fonte', async () => {
    const s = await start(['permissions']);
    const r = await request(s.tsBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { ...TS, ...HERMES_AUTH } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, n: 1 });
    expect(s.hermesApplied).toHaveLength(1);
  });

  it('tailnet sem o cabeçalho do Tailscale ou pelo Funnel: 403 antes do token; token errado: 401; nada chega à fonte', async () => {
    const s = await start(['permissions']);
    const post = (headers: Record<string, string>) => request(s.tsBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers });
    expect((await post({ Host: TS_HOST, ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS, 'Tailscale-User-Login': 'bob@example.com', ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS, 'Tailscale-Funnel-Request': '?1', ...HERMES_AUTH })).status).toBe(403);
    expect((await post({ ...TS })).status).toBe(401);
    expect((await post({ ...TS, Authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401);
    expect((await post({ ...TS, ...HERMES_AUTH, Origin: 'https://evil.example' })).status).toBe(403);
    expect(s.hermesApplied).toEqual([]);
  });

  it('o token do Hermes não abre mais nada: as outras rotas da tailnet continuam pedindo login (401)', async () => {
    const s = await start(['permissions', 'terminal', 'pty']);
    for (const [method, path] of [['GET', '/api/snapshot'], ['GET', '/api/pty'], ['POST', '/api/hermes/events/'], ['POST', '/api/hermes']] as const) {
      const r = await request(s.tsBase, path, { method, headers: { ...TS, ...HERMES_AUTH }, ...(method === 'POST' ? { body: HERMES_BODY } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(s.hermesApplied).toEqual([]);
  });

  it('portas 4747 (local) e 4748 (celular na rede, mesmo logado): a rota não existe (404)', async () => {
    const s = await start(['permissions', 'messages', 'terminal', 'spawn', 'pty']);
    const local = await request(s.localBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { Host: '127.0.0.1', ...HERMES_AUTH } });
    expect(local.status).toBe(404);
    const { cookie } = await login(s.lanBase);
    const lan = await request(s.lanBase, '/api/hermes/events', { method: 'POST', body: HERMES_BODY, headers: { Cookie: cookie, ...HERMES_AUTH } });
    expect(lan.status).toBe(404);
    expect(s.hermesApplied).toEqual([]);
  });
});
```

- [ ] **Step 2: Ver passar o que já é da Task 4, e o resto do arquivo** — `npx vitest run server/http/tailnet.test.ts`
  → verde: a cadeia do teste já usa a rota. (Esta task liga a MESMA cadeia no `index.ts`, que não tem teste de
  unidade; a conferência dela é o Step 5 e a Task 10.)

- [ ] **Step 3: Implementação** — `server/index.ts`:
  - imports, depois de `import { CodexSource } from './sources/codex/source';`:

```ts
import { createHermesIngest, HERMES_EVENTS_PATH } from './hermes/http';
import { HermesSource } from './sources/hermes/source';
```

  - depois de `const codexLive: CodexLive | undefined = codex;`:

```ts
// Hermes (Fase 6): agentes do Hermes Agent da VPS, pelos eventos do plugin habblaud-observer (POST /api/hermes/events,
// só na porta da tailnet e com o token; HABBLAUD_HERMES_TOKEN_HASH). Sem a hash, nem a fonte nem a rota existem.
const hermes = config.hermes ? new HermesSource({ office }) : undefined;
if (hermes) agents.add(hermes);
```

  - no bloco da porta da tailnet, depois de `const gate = createTailnetRemoteGate(remote, remoteSessions);`:

```ts
  // A única rota desta porta sem o login: os eventos do Hermes, com o token (server/hermes/http.ts).
  const hermesIngest = hermes && config.hermes ? createHermesIngest({ tokenHash: config.hermes.tokenHash, apply: (evs) => hermes.apply(evs) }) : undefined;
```

    e na cadeia, entre `if (tailnetGate(req, res)) return;` e `if (gate(req, res, url)) return;`:

```ts
        if (hermesIngest?.(req, res, url)) return;
```

  - no `server.listen(…)`, antes de `if (office.isDemo()) …`:

```ts
  log.info(hermes ? tr('   Hermes: recebendo eventos pela porta da tailnet ({0}).', [HERMES_EVENTS_PATH]) : tr('   Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH).'));
  if (config.hermesWarning) log.warn(`   ${config.hermesWarning}.`);
```

  (`agents.stop()` no `shutdown` já para a fonte.)

- [ ] **Step 4: Traduções** (bloco `// Fase 6 — Hermes`):

  `shared/locales/en.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "   Hermes: recebendo eventos pela porta da tailnet ({0}).": "   Hermes: receiving events through the tailnet port ({0}).",
  "   Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH).": "   Hermes: off (set HABBLAUD_HERMES_TOKEN_HASH).",
```

  `shared/locales/es.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "   Hermes: recebendo eventos pela porta da tailnet ({0}).": "   Hermes: recibiendo eventos por el puerto de la tailnet ({0}).",
  "   Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH).": "   Hermes: desactivado (define HABBLAUD_HERMES_TOKEN_HASH).",
```

  `shared/locales/fr.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "   Hermes: recebendo eventos pela porta da tailnet ({0}).": "   Hermes : réception des événements par le port du tailnet ({0}).",
  "   Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH).": "   Hermes : désactivé (définissez HABBLAUD_HERMES_TOKEN_HASH).",
```

- [ ] **Step 5: Conferir** — `npm run typecheck && npx vitest run server/http server/hermes server/sources/hermes && npm run i18n:check`
  → verdes. `grep -n "hermesIngest\|HermesSource" server/index.ts` → só a criação, a cadeia da tailnet e o log (nada
  no `server.on('request')` da 4747 nem no `startRemoteListener` da 4748). Rodada curta, sem token (rota desligada):

```bash
T=$(mktemp -d); HABBLAUD_DATA_DIR=$T HABBLAUD_WORLD=0 HABBLAUD_UPDATE_CHECK=0 HABBLAUD_PORT=4790 npx tsx server/index.ts > $T/log 2>&1 & PID=$!
sleep 4; grep "Hermes:" $T/log; curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:4790/api/hermes/events
kill $PID; rm -rf "$T"
```

  → `Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH).` e `404`.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/http/tailnet.test.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Hermes: eventos só pela porta da tailnet, depois do usuário do Tailscale e antes do login"
```

---

### Task 6: Cliente — chip, selo e caixa de mensagem do Hermes

**Files:**
- Modify: `client/src/ui/provider.ts` (`showsProviderTag`, `accountChipLabel`)
- Modify: `client/src/ui/widgets.ts` (`updateAccountChip`, `createProviderTag`, `updateProviderTag`)
- Modify: `client/src/ui/styles.css` (chip `data-provider='hermes'`)
- Modify: `client/src/ui/composer-model.ts` (`composerMode`)
- Test: `client/src/ui/provider.test.ts`, `client/src/ui/composer-model.test.ts`
- Modify: `shared/locales/en.ts`, `es.ts`, `fr.ts`

**Interfaces:**
- Consumes: `PROVIDER_NAME` (Task 2); agentes `provider: 'hermes'`, `account: 'hermes'` (Task 3).
- Produces: `showsProviderTag('hermes', nome)` (selo "Hermes"), `accountChipLabel(undefined, 'hermes', 'hermes') === 'Hermes'`,
  `composerMode` desligado para o Hermes.

- [ ] **Step 1: Testes (falhando)** — em `client/src/ui/provider.test.ts`, no `it('selo "Codex": …')`, depois de
  `expect(showsProviderTag('claude', 'Conta C')).toBe(false);`:

```ts
    expect(showsProviderTag('hermes', '')).toBe(true);
    expect(showsProviderTag('hermes', 'hermes')).toBe(false);
  });

  it('Hermes: chip "H" sem conta local, rótulo só com a ferramenta', () => {
    expect(fallbackShort('hermes', 'hermes')).toBe('H');
    expect(accountProvider(undefined, 'hermes', 'hermes')).toBe('hermes');
    expect(accountChipLabel(undefined, 'hermes', 'hermes')).toBe('Hermes');
```

  (o `});` que já existia fecha o `it` novo). Em `client/src/ui/composer-model.test.ts`, no
  `it('composerMode: quando não dá, diz por quê …')`, depois de `expect(off(agent(), { replaying: true })).toMatch(/timelapse/);`:

```ts
    expect(off(agent({ provider: 'hermes', canMessage: true }))).toBe('O Hermes só é acompanhado aqui: responda no canal dele');
```

- [ ] **Step 2: Ver falhar** — `npx vitest run client/src/ui/provider.test.ts client/src/ui/composer-model.test.ts`
  → falham `showsProviderTag('hermes', '')` (false), `accountChipLabel` (`'hermes'`) e o `composerMode` (`kind: 'hint'`).

- [ ] **Step 3: Implementação** — `client/src/ui/provider.ts`:

```ts
/** O selo da ferramenta ("Codex", "Hermes") ao lado do nome da conta (não repete quando o nome já diz qual é). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider !== 'claude' && !accountName.toLowerCase().includes(provider);
}
```

  e em `accountChipLabel`, antes da linha `if (!account) return fallbackId ? …`:

```ts
  // O Hermes roda na VPS e não tem conta aqui: o chip diz só a ferramenta.
  if (!account && provider === 'hermes') return PROVIDER_NAME.hermes;
```

  `client/src/ui/widgets.ts` — import: `import { accountChipLabel, accountProvider, fallbackShort, PROVIDER_NAME, showsProviderTag } from './provider';`;
  em `updateAccountChip`, trocar as duas linhas do `--acc` e do `data-provider` por:

```ts
  setStyleVar(chip, '--acc', account?.color ?? (p === 'hermes' ? HERMES_COLOR : '#8b98b3'));
  setAttr(chip, 'data-provider', p === 'claude' ? null : p);
```

  e trocar `createProviderTag` e `updateProviderTag` por:

```ts
/** Cor do chip do Hermes (não há conta local com cor própria). */
const HERMES_COLOR = '#5cc97b';
/** Dica do selo de cada ferramenta que não é o Claude Code. */
const PROVIDER_TITLE: Partial<Record<Provider, string>> = { codex: tr('Agente do Codex (OpenAI)'), hermes: tr('Agente do Hermes (VPS)') };

/** Selo de texto "Codex" ou "Hermes" ao lado do nome da conta (onde há espaço: gaveta, terminal, cartão de uso, dica). */
export function createProviderTag(extra = ''): HTMLElement {
  return h('span', { class: `ui-prov${extra ? ` ${extra}` : ''}`, text: 'Codex', hidden: true, title: PROVIDER_TITLE.codex });
}

/** Mostra o selo só fora do Claude Code (e não repete quando o nome da conta já diz a ferramenta). */
export function updateProviderTag(tag: HTMLElement, provider: Provider, accountName = ''): void {
  setHidden(tag, !showsProviderTag(provider, accountName));
  if (provider === 'claude') return;
  setText(tag, PROVIDER_NAME[provider]);
  setTitle(tag, PROVIDER_TITLE[provider] ?? '');
}
```

  `client/src/ui/styles.css`, depois do bloco `.ui-acc-chip--lg[data-provider='codex'] { --step: 3px; }`:

```css

/* Hermes (roda na VPS): chip redondo e vazado, na cor dele. */
.ui-acc-chip[data-provider='hermes'] {
  border-radius: 50%;
  background: #161b26;
  color: var(--acc);
  box-shadow: inset 0 0 0 2px var(--acc);
}
```

  `client/src/ui/composer-model.ts`, em `composerMode`, antes de `const codex = agent.provider === 'codex';`:

```ts
  // O Hermes só é observado (Fase 6): responder a ele pelo escritório está fora do escopo.
  if (agent.provider === 'hermes') return { kind: 'off', text: tr('O Hermes só é acompanhado aqui: responda no canal dele') };
```

- [ ] **Step 4: Ver passar** — `npx vitest run client/src/ui` → verde.

- [ ] **Step 5: Traduções** (bloco `// Fase 6 — Hermes`):

  `shared/locales/en.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "O Hermes só é acompanhado aqui: responda no canal dele": "Hermes is only followed here: reply in its own channel",
  "Agente do Hermes (VPS)": "Hermes agent (VPS)",
```

  `shared/locales/es.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "O Hermes só é acompanhado aqui: responda no canal dele": "Hermes solo se sigue aquí: responde en su canal",
  "Agente do Hermes (VPS)": "Agente de Hermes (VPS)",
```

  `shared/locales/fr.ts` (dentro do bloco `// Fase 6 — Hermes`):

```ts
  "O Hermes só é acompanhado aqui: responda no canal dele": "Hermes est seulement suivi ici : répondez dans son canal",
  "Agente do Hermes (VPS)": "Agent Hermes (VPS)",
```

- [ ] **Step 6: Conferir** — `npm run typecheck && npm run i18n:check && npm run build` → verdes.

- [ ] **Step 7: Commit**

```bash
git add client/src/ui/provider.ts client/src/ui/provider.test.ts client/src/ui/widgets.ts client/src/ui/styles.css client/src/ui/composer-model.ts client/src/ui/composer-model.test.ts shared/locales/en.ts shared/locales/es.ts shared/locales/fr.ts
git commit -m "Cliente: chip e selo do Hermes; a caixa de mensagem diz que ele só é acompanhado"
```

---

### Task 7: Plugin `habblaud-observer` (VPS), testes e documentação

**Files:**
- Create: `integrations/hermes/habblaud-observer/plugin.yaml`, `integrations/hermes/habblaud-observer/__init__.py`
- Test: `integrations/hermes/test_habblaud_observer.py` (fora da pasta do plugin: não vai para a VPS)
- Modify: `FORK.md` (seção nova), `CHANGELOG.md`

**Interfaces:**
- Consumes: o formato de `parseHermesBatch` (Task 4): `{v: 1, events: [{profile, platform?, session, event, tool?, ok?, duration_ms?, at, model?}]}`,
  Bearer, `Content-Type: application/json`.
- Produces: `register(ctx)` (contrato do Hermes); `Observer(url, token, profile, timeout=2.0, queue_max=500)` com
  `hook(name)`, `build(name, kwargs)`, `dropped`, `sent`, `disabled`; `load_config(home)`; arquivo de configuração
  `<HERMES_HOME>/habblaud-observer.json` `{url, token, profile?}` (ou `HABBLAUD_OBSERVER_CONFIG`).

- [ ] **Step 1: Teste (falhando)** — `integrations/hermes/test_habblaud_observer.py`:

```python
"""Testes do plugin habblaud-observer com um ctx falso e um servidor HTTP local (sem Hermes, sem rede).

Rodar: python3 -m unittest discover -s integrations/hermes -v
"""

import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent / "habblaud-observer" / "__init__.py"
spec = importlib.util.spec_from_file_location("habblaud_observer", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

TOKEN = "t" * 43
CANARIES = ("CANARIO-MENSAGEM", "CANARIO-RESPOSTA", "CANARIO-ARG", "CANARIO-RESULTADO", "CANARIO-COMANDO", "CANARIO-REMETENTE", "sessao-crua-123")


class Sink:
    """Servidor HTTP local que guarda o que chega; `delay` segura cada resposta."""

    def __init__(self, delay=0.0):
        self.bodies, self.headers = [], []
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                time.sleep(delay)
                sink.bodies.append(json.loads(body))
                sink.headers.append(dict(self.headers))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/hermes/events"

    def events(self):
        return [e for b in self.bodies for e in b["events"]]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


def wait_until(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


class RegisterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / "habblaud-observer.json"
        os.environ["HABBLAUD_OBSERVER_CONFIG"] = str(self.config)

    def tearDown(self):
        os.environ.pop("HABBLAUD_OBSERVER_CONFIG", None)
        self.tmp.cleanup()

    def test_sem_configuracao_nao_registra_nada(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(ctx.hooks, {})

    def test_configuracao_invalida_nao_registra_nada(self):
        for raw in ({"url": "http://exemplo.com/x", "token": TOKEN}, {"url": "https://x/api", "token": "curto"}, {"url": "https://x/api", "token": TOKEN, "profile": "a\nb"}, []):
            self.config.write_text(json.dumps(raw), encoding="utf-8")
            ctx = FakeCtx()
            plugin.register(ctx)
            self.assertEqual(ctx.hooks, {}, raw)

    def test_registra_os_dez_ganchos(self):
        self.config.write_text(json.dumps({"url": "https://mac.ts.net:8443/api/hermes/events", "token": TOKEN, "profile": "Íon"}), encoding="utf-8")
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(sorted(ctx.hooks), sorted(plugin.HOOKS))


class ObserverTest(unittest.TestCase):
    def setUp(self):
        self.sink = Sink()
        self.obs = plugin.Observer(self.sink.url, TOKEN, "Íon")

    def tearDown(self):
        self.sink.close()

    def test_so_os_campos_permitidos_e_sessao_com_hash(self):
        h = {n: self.obs.hook(n) for n in plugin.HOOKS}
        sid = "sessao-crua-123"
        results = [
            h["on_session_start"](session_id=sid, model="gpt-6-luna", platform="Telegram"),
            h["pre_llm_call"](session_id=sid, user_message="CANARIO-MENSAGEM", is_first_turn=True, model="gpt-6-luna", platform="telegram", sender_id="CANARIO-REMETENTE"),
            h["pre_tool_call"](session_id=sid, task_id="t1", tool_call_id="c1", tool_name="terminal", args={"command": "CANARIO-ARG"}),
            h["post_tool_call"](session_id=sid, tool_name="terminal", args={"command": "CANARIO-ARG"}, result="CANARIO-RESULTADO", duration_ms=1234),
            h["post_tool_call"](session_id=sid, tool_name="web_search", result='{"error": "CANARIO-RESULTADO"}'),
            h["post_llm_call"](session_id=sid, user_message="CANARIO-MENSAGEM", assistant_response="CANARIO-RESPOSTA", model="gpt-6-luna", platform="telegram"),
        ]
        self.assertEqual(results, [None] * 6)  # nunca injeta contexto nem bloqueia
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 6))
        raw = json.dumps(self.sink.bodies, ensure_ascii=False)
        for canary in CANARIES:
            self.assertNotIn(canary, raw)
        allowed = {"profile", "platform", "session", "event", "tool", "ok", "duration_ms", "at", "model"}
        for e in self.sink.events():
            self.assertLessEqual(set(e), allowed)
            self.assertRegex(e["session"], r"^[0-9a-f]{16}$")
            self.assertEqual(e["profile"], "Íon")
        evs = self.sink.events()
        self.assertEqual([e["event"] for e in evs], ["on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_tool_call", "post_llm_call"])
        self.assertEqual(evs[0]["platform"], "telegram")
        self.assertEqual(evs[2]["tool"], "terminal")
        self.assertEqual((evs[3]["duration_ms"], evs[3]["ok"]), (1234, True))
        self.assertEqual(evs[4]["ok"], False)
        self.assertEqual(self.sink.headers[0]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(self.sink.headers[0]["Content-Type"], "application/json")

    def test_aprovacao_sem_session_id_usa_a_sessao_da_ferramenta_na_mesma_thread(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_name="terminal")
        self.obs.hook("pre_approval_request")(command="CANARIO-COMANDO", description="x", session_key="CANARIO-REMETENTE", surface="telegram")
        self.obs.hook("post_approval_response")(command="CANARIO-COMANDO", choice="once")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 3))
        evs = self.sink.events()
        self.assertEqual({e["session"] for e in evs}, {evs[0]["session"]})
        self.assertNotIn("CANARIO", json.dumps(self.sink.bodies))

    def test_sem_sessao_nada_sai(self):
        self.assertIsNone(self.obs.hook("pre_llm_call")(user_message="oi"))
        time.sleep(0.2)
        self.assertEqual(self.sink.events(), [])

    def test_campo_fora_do_formato_fica_de_fora(self):
        self.obs.hook("pre_tool_call")(session_id="s", tool_name="rm -rf /", platform="Grupo PND 123")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 1))
        self.assertEqual(set(self.sink.events()[0]), {"profile", "session", "event", "at"})


class NeverBlocksTest(unittest.TestCase):
    def test_servidor_lento_o_gancho_volta_na_hora_e_o_lote_e_descartado_no_timeout(self):
        sink = Sink(delay=1.5)
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.3)
            start = time.perf_counter()
            for _ in range(20):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.05)
            self.assertTrue(wait_until(lambda: obs.dropped >= 20, 3.0))
        finally:
            sink.close()

    def test_fila_cheia_descarta_sem_esperar(self):
        sink = Sink(delay=1.0)
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.2, queue_max=2)
            start = time.perf_counter()
            for _ in range(50):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.05)
            self.assertGreaterEqual(obs.dropped, 40)
        finally:
            sink.close()

    def test_servidor_fora_do_ar_descarta(self):
        obs = plugin.Observer("http://127.0.0.1:9/api/hermes/events", TOKEN, "Íon", timeout=0.3)
        obs.hook("on_session_start")(session_id="s")
        self.assertTrue(wait_until(lambda: obs.dropped == 1))

    def test_erro_inesperado_desliga_o_plugin(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon")

            def boom(*_a):
                raise RuntimeError("assinatura mudou")

            obs.build = boom
            with self.assertLogs("habblaud-observer", level="WARNING"):
                self.assertIsNone(obs.hook("pre_tool_call")(session_id="s", tool_name="terminal"))
            self.assertTrue(obs.disabled)
            del obs.build
            self.assertIsNone(obs.hook("pre_tool_call")(session_id="s", tool_name="terminal"))
            time.sleep(0.2)
            self.assertEqual(sink.events(), [])
        finally:
            sink.close()


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Ver falhar** — `python3 -m unittest discover -s integrations/hermes -v` → erro ao carregar o módulo
  (`FileNotFoundError: … habblaud-observer/__init__.py`).

- [ ] **Step 3: Implementação** — `integrations/hermes/habblaud-observer/plugin.yaml`:

```yaml
name: habblaud-observer
version: 1.0.0
description: "Mostra no Habblaud (escritório em pixel art do Itallo) o que o Hermes está fazendo. Só observa: nunca manda texto de mensagens, argumentos, resultados, comandos nem quem falou."
author: PND Tecnologia
kind: standalone
provides_hooks:
  - on_session_start
  - pre_llm_call
  - post_llm_call
  - pre_tool_call
  - post_tool_call
  - pre_approval_request
  - post_approval_response
  - on_session_end
  - on_session_finalize
  - on_session_reset
```

  `integrations/hermes/habblaud-observer/__init__.py`:

```python
"""habblaud-observer: mostra no Habblaud o que o Hermes está fazendo (Fase 6 do Habblaud do Itallo).

Só observa. Manda ao Habblaud, pela tailnet, só isto por evento: perfil, plataforma, um hash da sessão (o id cru nunca
sai daqui), o nome do gancho, o nome da ferramenta, se deu certo, a duração, o horário e o modelo. NUNCA manda texto
de mensagem (user_message, assistant_response), argumentos ou resultados de ferramentas, comandos, descrições de
aprovação nem ids de quem falou (sender_id): o grupo da PND tem dados de terceiros.

Nunca atrapalha o Hermes: o gancho só põe o evento numa fila em memória (até 500; cheia, descarta) e volta na hora,
sempre com None (não injeta contexto nem bloqueia ferramenta). Uma thread em segundo plano junta até 50 eventos por
requisição, com timeout de 2 s, e descarta o lote se der errado. Um erro inesperado no gancho desliga o plugin até o
próximo restart do gateway.

Configuração: <HERMES_HOME>/habblaud-observer.json (modo 600), {"url": "https://<mac>.ts.net:8443/api/hermes/events",
"token": "<token>", "profile": "Íon"}; sem ela (ou inválida), o plugin não registra nada. "profile" é opcional (o
padrão é o nome da pasta do perfil, ou "default").
"""

import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("habblaud-observer")

HOOKS = (
    "on_session_start",
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "post_approval_response",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
)
END_HOOKS = ("on_session_end", "on_session_finalize", "on_session_reset")
APPROVAL_HOOKS = ("pre_approval_request", "post_approval_response")
QUEUE_MAX = 500
BATCH_MAX = 50
TIMEOUT_S = 2.0
# Os mesmos formatos que o Habblaud confere (server/hermes/http.ts): um campo fora deles derrubaria o lote inteiro.
PLATFORM_RE = re.compile(r"[a-z0-9_-]{1,20}")
TOOL_RE = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
MODEL_RE = re.compile(r"[A-Za-z0-9._:/@+-]{1,80}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,128}")
LOCAL_HTTP_RE = re.compile(r"http://(127\.0\.0\.1|localhost)(:\d+)?/")


def _str(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _profile_ok(value):
    """Letras e números de qualquer língua (Íon), espaço, ponto, _ e -; até 40; começa com letra ou número."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 40
        and value[0].isalnum()
        and all(c.isalnum() or c in " ._-" for c in value)
    )


class Observer:
    def __init__(self, url, token, profile, timeout=TIMEOUT_S, queue_max=QUEUE_MAX):
        self.url = url
        self.token = token
        self.profile = profile
        self.timeout = timeout
        self.q = queue.Queue(maxsize=queue_max)
        self.disabled = False
        self.dropped = 0
        self.sent = 0
        # Aprovação sem session_id: a sessão da última ferramenta que começou nesta mesma thread.
        self._session_of_thread = {}
        self._worker = threading.Thread(target=self._run, name="habblaud-observer", daemon=True)
        self._worker.start()

    def hook(self, name):
        def on_event(*_args, **kwargs):
            if self.disabled:
                return None
            try:
                event = self.build(name, kwargs)
                if event is not None:
                    self.q.put_nowait(event)
            except queue.Full:
                self.dropped += 1
            except Exception:  # noqa: BLE001 - qualquer erro desliga o plugin, nunca o Hermes
                self.disabled = True
                log.warning("habblaud-observer: erro inesperado; desligado até reiniciar o gateway", exc_info=True)
            return None

        return on_event

    def build(self, name, kw):
        thread = threading.get_ident()
        sid = kw.get("session_id")
        if name in APPROVAL_HOOKS and not sid:
            sid = self._session_of_thread.get(thread)
        if not isinstance(sid, str) or not sid:
            return None
        if name == "pre_tool_call":
            self._session_of_thread[thread] = sid
        elif name in END_HOOKS:
            for t, s in list(self._session_of_thread.items()):
                if s == sid:
                    self._session_of_thread.pop(t, None)
        digest = hashlib.sha256(f"{self.profile}\0{sid}".encode("utf-8")).hexdigest()[:16]
        event = {"profile": self.profile, "session": digest, "event": name, "at": int(time.time() * 1000)}
        platform = kw.get("platform")
        if isinstance(platform, str) and PLATFORM_RE.fullmatch(platform.lower()):
            event["platform"] = platform.lower()
        if name in ("pre_tool_call", "post_tool_call"):
            tool = _str(kw.get("tool_name"), TOOL_RE)
            if tool:
                event["tool"] = tool
        if name == "post_tool_call":
            duration = kw.get("duration_ms")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 <= duration <= 86_400_000:
                event["duration_ms"] = int(duration)
            ok = _tool_ok(kw.get("result"))
            if ok is not None:
                event["ok"] = ok
        if name in ("on_session_start", "pre_llm_call", "post_llm_call"):
            model = _str(kw.get("model"), MODEL_RE)
            if model:
                event["model"] = model
        return event

    def _run(self):
        while True:
            batch = [self.q.get()]
            while len(batch) < BATCH_MAX:
                try:
                    batch.append(self.q.get_nowait())
                except queue.Empty:
                    break
            self._send(batch)

    def _send(self, batch):
        body = json.dumps({"v": 1, "events": batch}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read(1024)
            self.sent += len(batch)
        except Exception:  # noqa: BLE001 - descarta: o Hermes nunca espera o Habblaud
            self.dropped += len(batch)


def _tool_ok(result):
    """Se a ferramenta falhou, pelo formato do resultado (o resultado em si nunca sai daqui). None = não dá para saber."""
    # ponytail: heurística pelo começo do JSON de erro das ferramentas do Hermes; trocar por um campo explícito se o
    # post_tool_call ganhar um.
    if isinstance(result, dict):
        return "error" not in result
    if isinstance(result, str):
        head = result.lstrip()[:12]
        return not head.startswith('{"error"')
    return None


def load_config(home):
    """Lê <HERMES_HOME>/habblaud-observer.json (ou HABBLAUD_OBSERVER_CONFIG). Inválida ou ausente: None."""
    path = Path(os.environ.get("HABBLAUD_OBSERVER_CONFIG") or Path(home) / "habblaud-observer.json")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    url, token = raw.get("url"), raw.get("token")
    if not isinstance(url, str) or not (url.startswith("https://") or LOCAL_HTTP_RE.match(url)):
        return None
    if not _str(token, TOKEN_RE):
        return None
    home = Path(home)
    default_profile = "default" if home.name == ".hermes" else home.name
    profile = raw.get("profile") or default_profile
    if not _profile_ok(profile):
        return None
    return {"url": url, "token": token, "profile": profile}


def register(ctx):
    try:
        home = Path(__file__).resolve().parents[2]  # <HERMES_HOME>/plugins/habblaud-observer/__init__.py
        config = load_config(home)
        if config is None:
            log.info("habblaud-observer: sem configuração válida em %s; nada registrado", home / "habblaud-observer.json")
            return
        observer = Observer(config["url"], config["token"], config["profile"])
        for name in HOOKS:
            ctx.register_hook(name, observer.hook(name))
    except Exception:  # noqa: BLE001 - o plugin nunca derruba o Hermes
        log.warning("habblaud-observer: falha ao registrar; desligado", exc_info=True)
```

- [ ] **Step 4: Ver passar** — `python3 -m unittest discover -s integrations/hermes -v` → 11 testes `ok` (uns 3 s).

- [ ] **Step 5: `FORK.md`** — seção nova no fim:

```md
## Hermes no escritório (Fase 6)

O plugin `habblaud-observer` (`integrations/hermes/habblaud-observer/`) mostra no escritório o que o Hermes Agent da
VPS está fazendo. Só observa: manda perfil, plataforma, um hash da sessão, o gancho, o nome da ferramenta, se deu
certo, a duração, o horário e o modelo; nunca texto de mensagem, argumentos, resultados, comandos nem quem falou. O
gancho só enfileira (o Hermes nunca espera o Habblaud) e um erro inesperado desliga o plugin até o próximo restart.

No Mac, o `.env` tem só a hash do token (`HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>`); a rota
`POST /api/hermes/events` existe só na porta da tailnet (4749, publicada na 8443), com o usuário do Tailscale e o
token, sem o login remoto. Nas portas 4747 e 4748 ela não existe. Na VPS, por perfil (`HH=/root/.hermes` é o Íon; os
outros ficam em `/root/.hermes/profiles/<nome>`):

    $HH/plugins/habblaud-observer/{plugin.yaml,__init__.py}   # cópia de integrations/hermes/habblaud-observer/
    $HH/habblaud-observer.json                                # {"url", "token", "profile"}, modo 600
    $HH/config.yaml                                           # "- habblaud-observer" em plugins.enabled (backup antes)

Depois, reiniciar o gateway do jeito que as notas do Hermes mandam (sem turno em andamento). Desligar: tirar a linha
de `plugins.enabled` (o backup é `config.yaml.bak-habblaud-*`), reiniciar o gateway e apagar a pasta do plugin e o
JSON. Testes do plugin: `python3 -m unittest discover -s integrations/hermes`. Agentes do Hermes nunca vão ao Habblaud
World (a projeção só aceita Claude Code e Codex).
```

- [ ] **Step 6: `CHANGELOG.md`** — em `## [Não lançado]`, no topo de `### Adicionado`:

```md
- **Hermes no escritório.** Com o plugin `habblaud-observer` (`integrations/hermes/`) ligado num perfil do Hermes
  Agent, cada sessão do Hermes vira um agente numa sala do perfil, com chip e selo próprios: chega ao receber uma
  mensagem, mostra a ferramenta em uso (só o nome), fica "precisa de você" num pedido de aprovação e à toa no fim do
  turno. Os eventos chegam por `POST /api/hermes/events`, só pela porta da tailnet, com o usuário do Tailscale e um
  token (no `.env`, só a hash: `HABBLAUD_HERMES_TOKEN_HASH`); nenhum texto de mensagem, argumento ou resultado sai da
  VPS, e o plugin nunca faz o Hermes esperar. Agentes do Hermes nunca vão ao Habblaud World (a projeção passou a
  aceitar só Claude Code e Codex).
```

- [ ] **Step 7: Conferir** — `python3 -m unittest discover -s integrations/hermes && git diff --check` → verdes.

- [ ] **Step 8: Commit**

```bash
git add integrations/hermes/habblaud-observer/plugin.yaml integrations/hermes/habblaud-observer/__init__.py integrations/hermes/test_habblaud_observer.py FORK.md CHANGELOG.md
git commit -m "Plugin habblaud-observer do Hermes: só observa, sem texto, nunca espera o Habblaud"
```

---

## Parte B — Operação (cada passo com OK do Itallo)

### Task 8: Suíte completa e revisão de segurança dirigida

- [ ] **Step 1: Suíte** — no worktree:
  `npm run typecheck && npm test && npm run i18n:check && npm run build && python3 -m unittest discover -s integrations/hermes && git diff --check meu-habblaud...HEAD`
  → tudo verde (anotar o total do Vitest; antes desta fase, ~2035 + 2 pulados; esta fase acrescenta 25).
- [ ] **Step 2: Revisão de segurança dirigida** — conferir no diff e anotar no PR:
  - (a) **Só a tailnet:** `grep -n "hermes" server/http/app.ts` → nada (a API das portas 4747/4748 não conhece a rota);
    `grep -n "hermesIngest" server/index.ts` → só a criação e a linha na cadeia da tailnet, entre `tailnetGate` e `gate`.
  - (b) **Ordem dentro da rota:** freio → token → corpo (`readJson(req, HERMES_BODY_MAX)`) → `parseHermesBatch` →
    `apply`; nenhum `readJson` antes do `bearerMatches`; variantes do caminho caem no login (teste da Task 5).
  - (c) **Token:** `grep -rn "HERMES_TOKEN" server shared client` → só `config.ts` (leitura, `SECRET_ENV`) e testes;
    nenhum `log.` com o cabeçalho `authorization`.
  - (d) **World:** `git diff --stat meu-habblaud...HEAD -- shared/world server/world` → só `projection.ts`,
    `projection.test.ts`, `office-from-world.ts` e `uplink.test.ts`; `git diff meu-habblaud...HEAD -- shared/world/office-from-world.ts`
    só troca tipos; `protocol.ts`/`schema.json`/`city.ts`/`floor-names.ts` sem diff. Conferir `docs/world/privacidade.md`
    contra o pacote (regra do `shared/world/README.md`).
  - (e) **Agente do Hermes não age:** assumir/encerrar pelo PTY dá 400 (`PtyManager.plan`: conta `hermes` não está nas
    contas do Claude Code; `stop` exige id `<conta>:<pid>`); mensagens: `composerMode` desligado e
    `MessageRegistry.reachable` nunca inclui o Hermes (só sessões com o plugin `habblaud-mensagens` ou Codex).
  - (f) **Plugin:** só stdlib; nenhum `subprocess`/`os.system`; ganchos devolvem `None`; thread `daemon`; os testes de
    canário cobrem `user_message`, `assistant_response`, `args`, `result`, `command`, `session_key`, `sender_id` e o
    `session_id` cru.
  - (g) **Textos da fonte:** `HermesSource` só cria texto de `tr()` fixo + nome da ferramenta + perfil/plataforma
    (validados por regex no servidor).

### Task 9: Push, PR e merge (pedir OK do Itallo)

- [ ] **Step 1: Pedir OK** no chat para: `git push fork fase-6-hermes`; PR `fase-6-hermes` → `meu-habblaud`; merge.
  Nada antes do OK.
- [ ] **Step 2: Depois do OK**

```bash
git push fork fase-6-hermes
gh pr create --repo itallopenedo/habblaud --base meu-habblaud --head fase-6-hermes \
  --title "Fase 6: Hermes no escritório" \
  --body "$(cat <<'EOF'
Plano: docs/superpowers/plans/2026-11-01-fase-6-hermes.md

- Plugin habblaud-observer (integrations/hermes/): só observa; manda perfil, plataforma, hash da sessão, gancho,
  ferramenta, ok, duração, horário e modelo. Nunca texto de mensagem, argumentos, resultados, comandos nem remetente.
  Fila em memória, thread em segundo plano, timeout 2 s, descarta na falha.
- POST /api/hermes/events só na porta da tailnet (127.0.0.1:4749), depois do Tailscale-User-Login e antes do login:
  freio, Bearer (só a sha256 em HABBLAUD_HERMES_TOKEN_HASH), 64 KB, formato estrito. 404 nas portas 4747 e 4748.
- HermesSource: um agente provider "hermes" por sessão, sala por perfil; à toa no fim do turno, "precisa de você" na
  aprovação, offline no finalize/reset ou após 6 h sem eventos.
- Habblaud World: a projeção passa a aceitar só claude e codex (antes, um provider desconhecido subia como claude).
  O que sobe de Claude Code e Codex não muda; protocol.ts e schema.json intactos. Testes na projeção e no uplink.
- Checks: typecheck, Vitest (<total>), i18n, build, python3 -m unittest (11), git diff --check.
- Fica para depois do merge (com OK): token e reinício do Habblaud no Mac, plugin no perfil Íon da VPS, testes ao vivo.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr view --repo itallopenedo/habblaud fase-6-hermes --json state,mergeable     # OPEN, MERGEABLE
gh pr merge --repo itallopenedo/habblaud fase-6-hermes --merge
```

- [ ] **Step 3: Conferir** — `gh pr view --repo itallopenedo/habblaud fase-6-hermes --json state` → `MERGED`.

### Task 10: Habblaud do Mac atualizado e o token (pedir OK do Itallo)

- [ ] **Step 1: Retrato antes (só leitura)**

```bash
git -C ~/habblaud log --oneline -1
curl -s http://127.0.0.1:4747/api/health | jq '{version, pty}'
grep -c '^HABBLAUD_HERMES_TOKEN_HASH=' ~/habblaud/.env          # 0
grep -E '^HABBLAUD_(TAILNET_USER|ALLOWED_HOSTS)=' ~/habblaud/.env | sed 's/=.*/=…/'   # as duas existem
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status   # :8443 → http://127.0.0.1:4749
```

- [ ] **Step 2: Pedir OK** no chat com os comandos dos Steps 3-5 e o rollback do Step 6, e perguntar ao Itallo o
  nome que o perfil terá no escritório (padrão: `Íon`, para o `default`). Avisar: o Habblaud fica fora do ar por uns
  20 s duas vezes (reinstalação e reinício); sessões do Claude Code/Codex não são afetadas.

- [ ] **Step 3: Código novo no ar** (depois do OK)

```bash
git -C ~/habblaud pull --ff-only fork meu-habblaud
git -C ~/habblaud log --oneline -1                     # o merge da Fase 6
cd ~/habblaud && npm run native:install                # build + reinstala o serviço; termina com "no ar"
grep "Hermes:" ~/.habblaud/logs/habblaud.log | tail -1   # "Hermes: desligado (defina HABBLAUD_HERMES_TOKEN_HASH)."
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:4747/api/hermes/events   # 404
```

- [ ] **Step 4: Token** — o token cru vai só para um arquivo `0600` (o JSON que a VPS vai usar); no `.env`, só a hash.
  Nada é impresso. `PERFIL` é o nome escolhido no Step 2.

```bash
cd ~/habblaud
cp -p .env ~/.habblaud/env.backup-fase6-$(date +%Y%m%d%H%M)
PERFIL='Íon'
umask 077
node -e '
const c = require("node:crypto"), fs = require("node:fs");
const [out, profile] = process.argv.slice(1);
const t = c.randomBytes(32).toString("base64url");
fs.writeFileSync(out, JSON.stringify({ url: "https://macbook-pro-de-itallo.taile846b7.ts.net:8443/api/hermes/events", token: t, profile }, null, 2) + "\n", { mode: 0o600 });
fs.appendFileSync(".env", "\nHABBLAUD_HERMES_TOKEN_HASH=sha256:" + c.createHash("sha256").update(t).digest("hex") + "\n");
' "$HOME/.habblaud/habblaud-observer.json" "$PERFIL"
ls -l ~/.habblaud/habblaud-observer.json                                       # -rw-------
grep -c '^HABBLAUD_HERMES_TOKEN_HASH=sha256:[0-9a-f]\{64\}$' .env              # 1
launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud
sleep 5; grep "Hermes:" ~/.habblaud/logs/habblaud.log | tail -1                # "Hermes: recebendo eventos pela porta da tailnet (/api/hermes/events)."
```

- [ ] **Step 5: Conferir as portas** (o token entra no `curl` pelo stdin, nunca na linha de comando)

```bash
H=(-H 'Host: macbook-pro-de-itallo.taile846b7.ts.net' -H 'Tailscale-User-Login: itallo@pndtecnologia.com.br' -H 'Content-Type: application/json')
curl -s -o /dev/null -w '%{http_code}\n' -X POST "${H[@]}" --data '{"v":1,"events":[]}' http://127.0.0.1:4749/api/hermes/events   # 401 (sem token)
node -p '"header = \"Authorization: Bearer " + require(process.env.HOME + "/.habblaud/habblaud-observer.json").token + "\""' \
  | curl -s -o /dev/null -w '%{http_code}\n' --config - -X POST "${H[@]}" --data '{"v":1,"events":[]}' http://127.0.0.1:4749/api/hermes/events   # 400 (token aceito; lote vazio não aplica nada)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:4747/api/hermes/events   # 404
curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.habblaud/remote-tls/ca/ca.crt -X POST -H 'Content-Type: application/json' --data '{}' https://habblaud.local:4748/api/hermes/events   # 401 (login; logado seria 404, nos testes)
curl -s -o /dev/null -w '%{http_code}\n' https://macbook-pro-de-itallo.taile846b7.ts.net:8443/api/snapshot   # 401 (o resto da 8443 continua pedindo login)
curl -s http://127.0.0.1:4747/api/health | jq '.sources[] | select(.provider == "hermes")'   # {label: "hermes", sessions: 0, ok: true, …}
```

- [ ] **Step 6: Rollback (só se preciso, com OK)**

```bash
cp -p ~/.habblaud/env.backup-fase6-<data> ~/habblaud/.env
launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud
rm ~/.habblaud/habblaud-observer.json
```

  (Voltar o código: `git -C ~/habblaud reset --hard <commit do Step 1>` + `npm run native:install`, só com OK.)

### Task 11: Plugin na VPS, só no perfil escolhido (pedir OK do Itallo)

Perfil padrão: Íon = `default` = `HERMES_HOME=/root/.hermes`. Para outro perfil, trocar `HH` por
`/root/.hermes/profiles/<nome>` e o nome no JSON (Task 10, Step 4). Usar o `$PY` e as respostas da Task 1.

- [ ] **Step 1: Latência antes (só leitura)** — o Itallo manda ao Íon pelo Telegram, em DM, três vezes, com uns 30 s
  entre elas: `responda só: ok`. Depois:

```bash
ssh openclaw-aapanel "grep -E 'conversation turn|Turn ended' /root/.hermes/logs/agent.log | tail -6"
```

  Anotar no chat a duração de cada turno (do `conversation turn` ao `Turn ended`) e a mediana.

- [ ] **Step 2: Pedir OK** no chat com os comandos dos Steps 3-6 e o rollback do Step 9, as respostas da Task 1 (em
  especial a (c), multiplexação) e a pergunta: **"Qual comando de reinício do gateway você confirma agora?"**
  (proposta, pelas notas: `systemctl restart hermes-gateway`, depois da conferência dos logs do Step 5, de preferência
  com a sessão que coordena a VPS confirmando que não há turno em andamento). Avisar: o Íon (e os outros perfis do
  mesmo gateway) fica fora do ar por uns 15-25 s.

- [ ] **Step 3: Copiar o plugin e a configuração** (depois do OK)

```bash
HH=/root/.hermes
ssh openclaw-aapanel "test ! -e $HH/plugins/habblaud-observer && mkdir -p $HH/plugins/habblaud-observer && echo pasta-criada"
scp ~/habblaud/integrations/hermes/habblaud-observer/plugin.yaml ~/habblaud/integrations/hermes/habblaud-observer/__init__.py openclaw-aapanel:$HH/plugins/habblaud-observer/
scp ~/.habblaud/habblaud-observer.json openclaw-aapanel:$HH/habblaud-observer.json
ssh openclaw-aapanel "chown root:root $HH/habblaud-observer.json && chmod 600 $HH/habblaud-observer.json && chmod 644 $HH/plugins/habblaud-observer/* && ls -l $HH/habblaud-observer.json $HH/plugins/habblaud-observer/"
ssh openclaw-aapanel "PY=<python da Task 1>; \$PY -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' $HH/plugins/habblaud-observer/__init__.py && echo sintaxe-ok"
shasum -a 256 ~/habblaud/integrations/hermes/habblaud-observer/__init__.py; ssh openclaw-aapanel "sha256sum $HH/plugins/habblaud-observer/__init__.py"   # iguais
rm ~/.habblaud/habblaud-observer.json     # o token cru fica só na VPS
```

- [ ] **Step 4: Ligar no `config.yaml` do perfil (com backup)**

```bash
ssh openclaw-aapanel "cp -p $HH/config.yaml $HH/config.yaml.bak-habblaud-\$(date -u +%Y%m%dT%H%M%SZ) && ls -1 $HH/config.yaml.bak-habblaud-*"
```

  Se a Task 1 mostrou `hermes plugins enable`:
  `ssh openclaw-aapanel "HERMES_HOME=$HH hermes plugins enable habblaud-observer"`. Senão (o bloco tem `- orca-status`
  em `plugins.enabled`, como mostrou a Task 1):

```bash
ssh openclaw-aapanel "sed -i '/^plugins:/,/^[^[:space:]]/{s/^\([[:space:]]*\)- orca-status[[:space:]]*\$/&\n\1- habblaud-observer/}' $HH/config.yaml"
```

  Conferir:

```bash
ssh openclaw-aapanel "PY=<python da Task 1>; \$PY -c 'import yaml,sys; print(yaml.safe_load(open(sys.argv[1]))[\"plugins\"][\"enabled\"])' $HH/config.yaml"   # [..., 'orca-status', 'habblaud-observer']
ssh openclaw-aapanel "diff $HH/config.yaml.bak-habblaud-<data> $HH/config.yaml"   # só '> - habblaud-observer'
```

- [ ] **Step 5: Conferir que não há turno em andamento** (regra das notas)

```bash
ssh openclaw-aapanel 'for f in /root/.hermes/logs/agent.log /root/.hermes/profiles/guedola/logs/agent.log; do echo "== $f"; grep -E "conversation turn|Turn ended" "$f" | tail -2; done'
```

  Só seguir se, nos dois arquivos, a última linha for `Turn ended`. Senão, esperar e repetir.

- [ ] **Step 6: Reiniciar com o comando confirmado no Step 2** (proposta):

```bash
ssh openclaw-aapanel 'systemctl restart hermes-gateway; sleep 30; systemctl is-active hermes-gateway; journalctl -u hermes-gateway --since "-2 min" --no-pager | grep -E -i "habblaud-observer|plugin|ERROR|Telegram" | tail -20'
```

  Esperado: `active`, Telegram conectado, nenhum `ERROR` novo, e nada de `habblaud-observer: sem configuração válida`
  nem `falha ao registrar`.

- [ ] **Step 7: Eventos chegando** — o Itallo manda ao Íon em DM: `que horas são? confira com um comando no terminal`.
  No Mac:

```bash
curl -s http://127.0.0.1:4747/api/snapshot | jq '[.agents[] | select(.provider == "hermes") | {id, name, title, status, account, activity: .activity.text}]'
```

  Esperado: um agente `hermes:<16 hex>`, `title` "Hermes · Íon (telegram)", status `working` com "Rodando um comando"
  e, ao fim, `idle` com "Concluiu…". Se nada aparecer em 1 min: `tail -20 ~/.habblaud/logs/habblaud.error.log` e, na
  VPS, `journalctl -u hermes-gateway --since "-5 min" | grep -i habblaud`; não insistir: rollback (Step 9) e voltar ao
  chat com a evidência.

- [ ] **Step 8: Latência depois** — repetir o Step 1 (as mesmas três mensagens) e comparar: aceitar se a mediana não
  subir mais de 10 % (ou 1 s). Se subir, rollback (Step 9) e investigar.

- [ ] **Step 9: Rollback (só se preciso, com OK)**

```bash
ssh openclaw-aapanel "cp -p $HH/config.yaml.bak-habblaud-<data> $HH/config.yaml"     # ou: HERMES_HOME=$HH hermes plugins disable habblaud-observer
# Step 5 de novo (sem turno em andamento), depois o reinício confirmado no Step 2:
ssh openclaw-aapanel 'systemctl restart hermes-gateway; sleep 30; systemctl is-active hermes-gateway'
ssh openclaw-aapanel "rm -r $HH/plugins/habblaud-observer && rm $HH/habblaud-observer.json"
```

  No Mac, se for desligar de vez: Task 10, Step 6.

### Task 12: Ao vivo e registro

- [ ] **Step 1: Mensagem do Itallo** — no escritório (`http://localhost:4747` e no iPhone pela 8443): o agente do Hermes
  chega na sala "Íon" com o chip redondo "H" e o selo "Hermes"; o balão mostra "Recebeu uma mensagem", depois a
  ferramenta ("Rodando um comando", "Pesquisando na web"…), e "Concluiu" no fim. Na gaveta: título "Hermes · Íon
  (telegram)", modelo, nenhum texto da conversa; a caixa de mensagem diz "O Hermes só é acompanhado aqui: responda no
  canal dele". Prova de que nenhum texto chegou (trocar pelo texto exato que o Itallo mandou e pela resposta do Íon):

```bash
ID=$(curl -s http://127.0.0.1:4747/api/snapshot | jq -r '[.agents[] | select(.provider == "hermes")][0].id')
curl -s http://127.0.0.1:4747/api/snapshot | grep -c -F 'que horas são'                      # 0
curl -s "http://127.0.0.1:4747/api/agents/$(jq -rn --arg v "$ID" '$v|@uri')" | grep -c -F 'que horas são'   # 0
```

- [ ] **Step 2: Aprovação** — o Itallo pede ao Íon um comando que o Hermes manda aprovar (o Itallo escolhe um inofensivo
  que caia nos padrões perigosos, por exemplo apagar uma pasta de teste em `/tmp` criada antes). No escritório: o
  agente fica "precisa de você" ("aprovar um comando"), com o aviso e a notificação do celular (`tail -2
  ~/.habblaud/logs/phone-notify.log`). O Itallo nega no Telegram: o agente volta a "trabalhando" e depois "Concluiu".
  Se a aprovação não aparecer, anotar com a resposta (a) da Task 1.
- [ ] **Step 3: Nada do Hermes no World** — com o agente do Hermes presente:

```bash
curl -s http://127.0.0.1:4747/api/world/last-uplink | grep -c -i hermes                     # 0
curl -s http://127.0.0.1:4747/api/world/last-uplink | jq '[.uplink.floors[].agents[].provider] | group_by(.) | map({(.[0]): length}) | add'
curl -s http://127.0.0.1:4747/api/snapshot | jq '[.agents[] | select((.provider // "claude") != "hermes" and (.id | startswith("demo:") | not) and (.status as $s | ["working","waiting","idle","shell"] | index($s))) | .provider // "claude"] | group_by(.) | map({(.[0]): length}) | add'
```

  As duas contagens por provider batem (só `claude`/`codex`); sem conta no World, o `last-uplink` vem vazio e o
  primeiro `grep` dá 0 do mesmo jeito (anotar qual dos dois casos).
- [ ] **Step 4: Latência** — a comparação do Step 8 da Task 11, anotada.
- [ ] **Step 5: Outros perfis (opcional, cada um com OK)** — repetir a Task 10, Step 4 (um JSON por perfil, com o nome
  dele; `.env` ganha só a primeira hash: usar o MESMO token nos perfis ou trocar a decisão com o Itallo) e a Task 11
  inteira com `HH=/root/.hermes/profiles/<nome>`. O `guedola` atende o grupo PND (dados de terceiros): o plugin não
  manda texto, mas confirmar com o Itallo antes.
- [ ] **Step 6: Registrar** — em `/Users/itallopenedo/dev/pnd-tecnologia/projetos/habblaud.md` (seção nova com a data:
  commits, PR, onde está o token (só o arquivo `0600` na VPS; a hash no `.env` do Mac), backups do `.env` e do
  `config.yaml`, as respostas da Task 1, latência antes/depois, o que foi verificado ao vivo e o que não) e em
  `projetos/hermes.md` (o plugin ligado no perfil, como desligar). Atualizar a linha do `_indice.md`.

---

## Autorrevisão

- **Cobertura do spec:** plugin `habblaud-observer` com os ganchos de sessão, LLM e ferramenta, só os campos permitidos,
  fila em memória, envio assíncrono, timeout de 2 s e descarte → Task 7 (testes de canário, lento, fila cheia, fora
  do ar, erro inesperado); aprovação → Tasks 3 e 7; "se desliga sozinho se a assinatura mudar" → erro inesperado
  desliga (Task 7); transporte pela tailnet → Task 1 (Step 1, `curl`), Tasks 10-11; `POST /api/hermes/events` só no
  listener da tailnet, sem login, com Bearer (só a hash no `.env`), 64 KB, formato e freio → Tasks 4-5 (testes: token
  errado 401, corpo inválido 400, 413, 405, 429, 4747/4748 404, sem cabeçalho 403, outras rotas 401); `HermesSource`
  (um agente por sessão, à toa após inatividade, offline no fim) → Task 3; provider `hermes` → Task 2 (tipo) e Task 6
  (ícone/rótulo); excluído do World → Task 2 (projeção e uplink) e Task 12 (Step 3); i18n en/es/fr → Tasks 3-6;
  CHANGELOG → Task 7; caso real no Telegram → Task 11 (Step 7) e Task 12; latência → Tasks 11-12; checks e revisão de
  segurança → Task 8; PR com OK → Task 9.
- **Placeholders:** nenhum "TBD". `<data>` nos rollbacks é o sufixo do backup criado na mesma task; `<python da Task 1>`
  é o caminho que a Task 1 mostra; `<total>` no PR é o número do Step 1 da Task 8; `<commit do Step 1>` é o que o
  Step 1 da Task 10 mostra.
- **Nomes conferidos entre tarefas:** `Provider`/`AliasTool`/`PROVIDER_NAME` (2 → 6); `HERMES_EVENTS`,
  `HermesEvent`/`HermesEventName`, `HERMES_ACCOUNT`, `hermesAgentId`, `describeHermesTool`, `HermesSource.apply/tick`
  (3 → 4, 5); `parseHermesTokenHash`/`bearerMatches` (4, `config.ts`), `HERMES_EVENTS_PATH`, `parseHermesBatch`,
  `FixedWindowLimiter`, `createHermesIngest`, `ServerConfig.hermes`/`hermesWarning` (4 → 5); formato do lote
  `{v: 1, events}` e `duration_ms` (4 ↔ 7). O código das Tasks 2-7 foi rodado numa cópia do HEAD `9b8d88d`: typecheck,
  Vitest inteiro (171 arquivos verdes), `i18n:check` (3080/3080) e os 11 testes do plugin.
- **Fora desta fase (de propósito):** subagentes do Hermes (`subagent_start/stop`); responder ao Hermes pelo
  escritório; uso/tokens do Hermes no "Meu dia" (os stats ficam zerados: o World também não ganha números); conta do
  Hermes no painel de contas; um token por perfil; contrato automático entre o teste Python e o TS (o formato está
  nos dois e a Task 11, Step 7, confere de ponta a ponta).
