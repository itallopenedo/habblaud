# Iniciar sessões do Claude e do Codex pelo Habblaud — plano curto

Data: 2026-11-02. Estado: proposta, sem código. Base: `meu-habblaud` em `7d0ec42`.

Pedido: começar uma sessão nova do Claude Code ou do Codex pelo próprio Habblaud (computador e celular), escolhendo
modelo e esforço, como no Orca, onde se escolhe o agente e as opções na hora de criar, sem abrir um terminal antes.

## Ponto de partida: o que já existe

- **Novo agente** (`client/src/ui/spawn.ts`, `server/spawn/spawn.ts`). A pessoa escolhe a pasta, escreve o pedido
  (com anexos e ditado) e o servidor roda `claude --bg -n "Habblaud: …" -- <pedido>` nessa pasta. Se a pasta ainda
  não é confiável para o Claude Code, cai no link `claude://code/new`, que abre o app com o pedido preenchido (a
  pessoa aperta Enter no Mac). O recurso depende de `HABBLAUD_PTY=1` e das mensagens ligadas. No acesso remoto, precisa
  de `spawn` em `HABBLAUD_REMOTE_ALLOW`. No Docker, quem roda é o auxiliar do host (`npm run codex:bridge`).
- **Terminal interativo** (`server/pty/manager.ts`, rotas em `server/http/pty.ts`). `POST /api/pty` abre `claude` (ou
  `claude --resume <id>`) num pseudo-terminal, com a conta escolhida (`CLAUDE_CONFIG_DIR`). Só aceita o Claude. Pela
  tailnet, exige a senha recente.
- **Codex**: o Habblaud só observa (hooks em `CODEX_HOME` mais os arquivos de rollout) e manda mensagens
  (`codex queue`, em `server/messages/codex.ts`). Ele não começa sessões do Codex.

Então o trabalho tem duas partes: (1) modelo e esforço no Novo agente do Claude; (2) o Codex como segunda opção.

## O que muda na tela

A folha do Novo agente ganha três controles acima da pasta:

1. **Agente**: um seletor `Claude | Codex`, igual ao `Chat | Terminal` do terminal. A opção Codex só aparece quando o
   servidor achou o `codex` no Mac.
2. **Modelo**: uma lista. A primeira opção é "Padrão da conta", que não passa nenhuma opção ao CLI.
3. **Esforço**: um seletor com só os níveis que o modelo escolhido aceita. A primeira opção é "Padrão".

O botão de começar resume a escolha ("Começar · Opus · alto"). Cada aparelho lembra a última escolha de cada agente
no `localStorage` (`habblaud.spawn.claude` e `habblaud.spawn.codex`), do mesmo jeito que já lembra a pasta
(`habblaud.spawn.folder`). No celular, os três controles ficam empilhados, com alvos de toque grandes e sem depender
de hover. O resto da folha (pasta, pedido, anexos, ditado, estado do pedido) continua igual.

## Como a sessão nova é criada

### Claude

O mesmo `claude --bg` de hoje, com duas opções a mais, sempre antes do `--`:

```
claude --bg -n "Habblaud: <começo do pedido>" [--model <modelo>] [--effort <nível>] -- <pedido>
```

A sessão continua independente do Habblaud: ela sobrevive a um reinício do servidor e aparece no escritório como
qualquer sessão. O link do app (`claude://code/new`) não leva modelo nem esforço. Quando o pedido cair nele, a tela
avisa que a sessão abriu no app com o modelo padrão.

### Codex

O Codex não tem um modo em segundo plano como o `claude --bg`. Há três caminhos:

- **A (recomendado): Codex interativo no terminal do Habblaud.** O `PtyManager` passa a aceitar o binário do Codex,
  além do `claude`, e roda:

  ```
  codex -C <pasta> [-m <modelo>] [-c model_reasoning_effort="<nível>"] -- <pedido>
  ```

  Os hooks que já estão instalados mostram a sessão no escritório. O `codex queue` funciona porque a tela do Codex é
  dona do thread e consulta a fila. Os pedidos de permissão aparecem no próprio terminal, e o navegador já abre esse
  terminal (xterm). Custo: a sessão vive enquanto o servidor do Habblaud vive. Um reinício encerra a sessão, mas a
  conversa fica no rollout e continua com `codex resume <id>`. Antes de implementar, conferir se o `--` antes do
  pedido funciona no `codex` (o `--help` mostra `codex [OPTIONS] [PROMPT]`).
- **B: `codex exec` separado do Habblaud.** A sessão sobrevive ao reinício, mas termina no fim do turno. Sem dono, o
  `codex queue` não anda, e cada mensagem teria de virar um `codex exec resume <thread> <texto>`. Os pedidos de
  permissão não têm onde aparecer. Dá mais trabalho e dá menos controle.
- **C: daemon `app-server` ou `remote-control`.** Os dois são experimentais na versão 0.163.0. Fica fora por ora.

## Onde ficam modelo e esforço

- **Lista de opções no servidor**: uma rota nova, `GET /api/spawn/options`, devolve
  `{claude: {models, efforts}, codex: {available, models: [{id, name, efforts, default}]}}`.
  - Claude: lista fixa no código. O CLI não tem um comando que liste os modelos. Os apelidos citados no `--help` são
    `fable`, `opus` e `sonnet` (conferir também `haiku`). Os níveis são `low`, `medium`, `high`, `xhigh` e `max`.
  - Codex: vem de `codex debug models` (JSON), só com os modelos de `visibility: "list"` e com os níveis de
    `supported_reasoning_levels` de cada um. Fica em cache por 10 minutos e é lido com o `CODEX_HOME` da conta.
- **Validação**: `POST /api/spawn` passa a aceitar `agent`, `model` e `effort`. O servidor só aceita valores que estão
  na lista e recusa o resto com 400. Nenhum texto livre vira argumento do CLI, e o pedido continua depois do `--`.
- **Nada novo no servidor**: a última escolha fica no aparelho. O padrão de verdade continua na configuração de cada
  CLI (`~/.claude/settings.json` e `~/.codex/config.toml`).

## Opções de cada CLI (conferidas no Mac em 2026-11-02)

| | Claude Code 2.1.316 | Codex 0.163.0 |
|---|---|---|
| Modelo | `--model <apelido ou nome completo>` | `-m, --model <slug>` |
| Esforço | `--effort low\|medium\|high\|xhigh\|max` | sem opção própria: `-c model_reasoning_effort="<nível>"` |
| Pasta | `cwd` do processo | `-C, --cd <pasta>` (ou `cwd`) |
| Segundo plano | `--bg`, mais `-n <nome>` | não tem |
| Lista de modelos | não tem | `codex debug models` (JSON) |
| Outras opções (fora desta fase) | `--permission-mode`, `--fallback-model` | `-p` (perfil), `-s` (sandbox), `-a` (aprovação) |

Modelos do Codex listados hoje: `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`,
`gpt-5.6-sol`, `gpt-5.6-terra` e `gpt-5.6-luna`. Todos aceitam de `low` a `max`. Os modelos `luna` não aceitam
`ultra`, e os demais aceitam. O `config.toml` do Itallo também habilita `none` e `minimal`, mas o catálogo não os
lista para nenhum modelo: a tela mostra só o que o catálogo diz.

## Riscos

- **Reinício do Habblaud encerra o Codex (caminho A).** Um `launchctl kickstart` ou uma atualização fecha os terminais
  abertos. A tela do Codex avisa isso, e retomar com `codex resume` fica como próximo passo.
- **`-c` no Codex.** `server/messages/codex.ts` proíbe `-c` no `codex queue` porque ele mudaria a configuração do
  servidor da sessão. Aqui só entra uma chave fixa, `model_reasoning_effort`, com um valor que vem da lista. A regra
  continua: texto da pessoa nunca vai para `-c`.
- **Nomes de modelos mudam com as versões dos CLIs.** O catálogo do Codex se ajusta sozinho. A lista do Claude usa só
  apelidos, que são estáveis. Um valor que o CLI recusar volta como erro na tela, com a primeira linha do stderr, como
  hoje.
- **Começar sessões pelo celular executa código no Mac.** As travas atuais continuam: `spawn` em
  `HABBLAUD_REMOTE_ALLOW` para o Claude e as travas do terminal (conexão local ou tailnet com senha recente) para o
  Codex.
- **Gasto.** `max` e `ultra` consomem a cota mais depressa. A tela não esconde esses níveis, mas eles ficam no fim da
  lista.
- **Docker.** O auxiliar do host precisa levar os campos novos. O Mac roda no modo Node, então o Docker pode vir
  depois (ver pergunta 6).
- **Habblaud World.** Nada muda em `shared/world/` nem em `server/world/`. A escolha de modelo e de esforço não vai
  para o servidor do World.

## Como testar

Automático, no padrão dos testes que já existem em `server/spawn/` e `server/pty/`, com dados sintéticos:

- `parseSpawn` com `agent`, `model` e `effort`: aceita os valores da lista e recusa valor desconhecido, nível que o
  modelo não aceita e texto com `-` no começo.
- `cliArgs` do Claude: ordem das opções e o pedido sempre depois do `--`.
- Argumentos do Codex: `-C`, `-m`, `-c model_reasoning_effort=…` e o `--`.
- Leitura de `codex debug models` a partir de um JSON de exemplo: filtra `visibility` e monta os níveis por modelo.
- `npm run typecheck`, `npm run i18n:check`, `npx vitest run` e `npm run build`.

No Mac, usando o servidor de teste (`habblaud-teste`, porta 4790, em `.claude/launch.json`), sem tocar no Habblaud do
launchd:

1. Claude com `opus` e `high` numa pasta de rascunho já confiável. Conferir em `claude agents` e no escritório. O
   modelo aparece na linha de status ou no transcript.
2. Codex com `gpt-6.1-terra` e `low`. A sessão aparece no escritório, o terminal abre e uma mensagem pelo escritório
   (`codex queue`) chega.
3. Reiniciar só o servidor de teste: a sessão do Codex termina e o rollout continua lá.
4. Valor fora da lista enviado direto para `POST /api/spawn`: a resposta é 400 e nada roda.

No celular:

1. Painel do navegador em 375×812 apontando para a porta 4790: layout da folha, seletores e teclado.
2. Depois do deploy (só com OK do Itallo), no iPhone pela tailnet (porta 8443): abrir a folha, escolher, começar e
   ver o agente aparecer. Para o Codex, confirmar que a senha recente é pedida.

## Perguntas de decisão

1. **Codex**: caminho A (terminal do Habblaud, recomendado) ou B (`codex exec` separado)?
2. **Conta**: a folha deixa escolher a conta (há várias do Claude e do Codex) ou usa sempre a padrão?
3. **Modelos do Claude**: só os apelidos (`fable`, `opus`, `sonnet`, `haiku`) ou também nomes completos, como
   `claude-opus-5-5`?
4. **Modo de permissão** (`--permission-mode` no Claude, `-s` e `-a` no Codex): entra nesta fase ou fica para depois?
   Recomendação: depois.
5. **Mostrar modelo e esforço no cartão do agente** depois de criado: sim ou não?
6. **Docker**: o auxiliar do host entra nesta fase ou fica só o modo Node, que é o do Mac? Recomendação: só o modo
   Node agora.
7. **Codex sem pedido**: permitir abrir uma sessão vazia do Codex, como já dá para fazer com o Claude?

## Decisões (Itallo, 2026-11-02)

1. Codex pelo caminho A: interativo no terminal do Habblaud.
2. Conta: a folha começa na conta padrão e deixa trocar.
3. Modelos pelo nome completo (ex.: `claude-opus-5-5`, `gpt-6.1-sol`), com modelo e esforço nos dois agentes.
4. Modo de permissão entra nesta fase. As opções que tiram todas as travas (`bypassPermissions` no Claude,
   `danger-full-access` no Codex) ficam fora da folha: quem já usa isso na configuração do CLI escolhe "Padrão".
5. O cartão do agente mostra modelo e esforço. Codex: o esforço vem do rollout (`turn_context`). Claude: o
   transcript não grava o esforço, então o cartão mostra o esforço só das sessões que o Habblaud começou (pelo id
   que o `claude --bg` devolve, que é o começo do id da sessão), enquanto o servidor estiver no ar.
6. Só o Mac (modo Node). O auxiliar do host (Docker) continua sem as opções novas.
7. O Codex pode começar sem pedido.

Ligação entre o terminal do Codex e o agente do escritório: os hooks do Codex rodam no ambiente do daemon, então
não dá para marcar a sessão por variável de ambiente. O servidor liga o terminal ao primeiro agente principal do
Codex que aparece na mesma pasta e na mesma conta depois que o terminal abriu e que ainda não está ligado a outro
terminal.

Atualização (revisão do código, 2026-11-02): a ligação só acontece sem dúvida, com um único terminal esperando
naquela pasta e conta e um único agente novo nos 2 minutos depois que ele abriu. Na dúvida o terminal fica sem
ligar: ele funciona igual, só o cartão do agente não o abre. Uma conta que não é a padrão também não cai no app do
Claude (ele abriria na conta errada): o erro do `claude --bg` aparece na folha.
