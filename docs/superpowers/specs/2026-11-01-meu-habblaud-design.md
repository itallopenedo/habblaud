# Meu Habblaud — design

Data: 2026-11-01. Branch base: `meu-habblaud` (fork `itallopenedo/habblaud`). Upstream: `marmottajr/habblaud`.

## Objetivo

Acompanhar e controlar, do Mac e do iPhone (inclusive fora de casa), todas as sessões de Claude Code, Codex e Hermes:
perguntas sempre visíveis e respondíveis, mídia nos dois sentidos, terminal completo e alertas. Manter o fork
atualizável com o upstream.

## Regras que valem para todas as fases

- Uma fase = um branch `fase-N-<nome>` a partir de `meu-habblaud` → PR para `meu-habblaud` no fork. Nunca para o
  upstream sem pedido explícito.
- Todo passo tem um check executável (comando, teste ou comportamento observado). Passo só fecha com o check rodado.
- TDD nos trechos com lógica (teste visto falhar antes da correção).
- Antes de abrir PR: `npm run typecheck`, `npm test`, `npm run i18n:check`, `git diff --check`.
- Texto visível passa por `tr()` com traduções em `shared/locales/`; mudança visível entra em `## [Não lançado]` no
  `CHANGELOG.md`.
- Push, rebuild/restart do Habblaud, `remote:setup`, Tailscale e qualquer mudança na VPS do Hermes: só com OK do Itallo
  no chat.
- `.env` e segredos: nunca no repositório. Editar o `.env` só junto com o Itallo.
- `shared/world/` e `server/world/`: não alterar o que é enviado ao Habblaud World. Agentes Hermes nunca vão ao World.
- Arquivos novos em vez de reescrever arquivos do upstream sempre que possível (menos conflito no `upstream:sync`).

## Fase 1 — Base (A + H)

**A. Perguntas ao vivo.** O código já está em `meu-habblaud` (wrap_up do Claude Desktop, `request_user_input_async`
do Codex, lembrete interno junto da resposta).

1. Rebuild do Habblaud com `meu-habblaud` (OK do Itallo). Check: `/api/health` mostra 1.0.4 e as fontes Claude/Codex.
2. Caso real Claude: sessão descartável faz `AskUserQuestion` e outra faz `wrap_up` com `ask`. Check: o agente aparece
   `waiting` em `/api/snapshot` e em "precisam de você"; depois da resposta, deixa de estar `waiting`.
3. Caso real Codex: sessão descartável chama `request_user_input_async`. Mesmo check.
4. `CHANGELOG.md` `[Não lançado]` com as mudanças de Codex, Fable e uso que vieram do backup.
5. `server/world/uplink.test.ts` ("o tema e as opções do jogador"), que já falha em `faa1a01`: diagnosticar. Se for o
   teste, corrigir só o teste; se for o código, registrar issue no upstream e não alterar o envio. Check: teste
   passando ou issue aberta com a reprodução.

**H. `npm run upstream:sync`** (`scripts/upstream-sync.ts`, novo):

1. Recusa rodar com árvore suja. `git fetch origin`; `main` avança só por fast-forward até `origin/main`.
2. Cria um worktree temporário de `meu-habblaud`, faz o merge de `main`, roda typecheck, Vitest e i18n.
3. Sem conflito e com checks verdes: avança `meu-habblaud` local e imprime o resumo. Com conflito ou check vermelho:
   deixa o worktree para resolver e imprime o caminho. Nunca faz push.
4. Check: teste com repositório fixture (merge limpo, conflito, `main` divergente que recusa o ff).

Remotes em `~/habblaud`: `origin` (upstream) e `fork`; `main` acompanha `origin/main`, `meu-habblaud` acompanha
`fork/meu-habblaud`. `FORK.md` explica o fluxo em poucas linhas.

## Fase 2 — iPhone fora de casa (B)

Só configuração, com o Itallo:

1. Tailscale no Mac e no iPhone, mesma tailnet.
2. `tailscale serve --bg --https=443 https+insecure://127.0.0.1:4748` (sempre a porta remota com login, nunca a 4747).
3. Nome `<mac>.<tailnet>.ts.net` em `HABBLAUD_ALLOWED_HOSTS`.
4. Check: iPhone no 4G (Wi-Fi desligado) abre o endereço, faz login, vê o escritório e aprova uma permissão de teste.

## Fase 3 — Responder Codex e alertas (F + G)

**F. Responder perguntas do Codex pelo Habblaud.**

1. Spike: numa sessão Codex descartável, abrir `request_user_input_async` e entregar pelo caminho atual
   (`codex queue --thread=<id> --message=<texto>`) o formato
   `<send_user_message_question_reply>\n[{"questionItemId":"[\"request_user_input_async\",\"<callId>\",<i>]","answer":"<rótulo>"}]`.
   Check: o rollout registra a resposta e a pergunta fecha.
2. Se o spike passar: `codexAnswer(agentId, questionId, option)` no `CodexSource`, no mesmo contrato do
   `desktopAnswer` (só a pergunta atual, opção dentro do intervalo), ligado ao `MessageRegistry`; o drawer mostra
   botões também para perguntas do Codex. Se falhar: os botões mandam o rótulo como mensagem de texto comum, e o
   CHANGELOG diz isso.
3. Check: testes de registry (opção antiga recusada, duplicidade recusada) e de rollout; caso real no Codex.
4. Resultado do spike (2026-11-01): a fila do Codex (`codex queue`) só entrega depois que o turno termina e a pergunta aberta
   mantém o turno aberto; responder o Codex continua sendo no Codex. O escritório mostra a pergunta e a dica ⇧←.

**G. Alertas de travado e de erro** em `scripts/phone-notify.mjs`:

- Travado: `status === 'working'` e `lastEventAt` mais velho que `HABBLAUD_STUCK_MIN` (padrão 15 min).
- Erro: atividade atual com `error: true`.
- Mesmo texto genérico e mesma deduplicação do aviso atual; nada de títulos, projetos, comandos ou caminhos.
- Check: casos novos em `server/test/phone-notify.test.ts` (dispara uma vez, não repete, volta a disparar após
  normalizar).

## Fase 4 — Mídia (D)

**D1. Imagens na conversa.** Hoje `server/sources/terminal.ts` troca imagens por `[imagem]`.

- `TerminalEntry` ganha `images?: { id: string; mime: string }[]` (só referência, sem base64 no snapshot).
- `GET /api/terminal/image/:agentId/:imageId` lê a imagem sob demanda, com cache em memória limitado (mesmos tipos e
  limites das capturas de `server/deliveries/`). Mesmo gate do terminal (local, ou remoto com `terminal`).
- Cliente: miniatura no bloco; toque abre ampliada.
- Check: teste do parser com imagem em prompt e em `tool_result`; teste da rota (404 de id inválido, 403 sem gate).

**D2. Foto ou arquivo na mensagem.**

- Generalizar o armazenamento de `server/spawn/attachments.ts` para `/api/attachments` (mesmos limites: 15 MB, 8 por
  envio, TTL 30 min, pasta 700, arquivos 600). `/api/spawn/attachments` continua funcionando.
- `parseSend` aceita `attachments: string[]`; o texto entregue recebe os caminhos por `promptWithAttachments`.
  Funciona para Claude e Codex. Gate `messages`.
- Composer: botão de anexo (câmera/fotos/arquivos no iPhone).
- Check: testes de `parseSend` (id desconhecido, expirado, limite) e envio real de uma foto a uma sessão descartável.

**D3. Áudio.** O ditado já existe. Instalar `whisper-cpp`, `ffmpeg` e `ggml-small.bin` em `~/.local/share/whisper/`.
Check: botão Ditar aparece no iPhone e transcreve uma frase em português.

**D4. Arquivos gerados.** Aba "Arquivos" no drawer do agente com os `file_path` de Write/Edit da sessão, abertos pelo
`FileFetcher` das entregas (tipos permitidos, blocklist de segredos, 25 MB, HTML/SVG com CSP sandbox). Gate
`terminal`. Check: teste da lista (dedup, ordem) e do bloqueio de `.env`/chaves.

## Fase 5 — Terminal completo (C)

**C1. Habblaud nativo no Mac.** Trocar o Docker por `npm start` num LaunchAgent (`com.pnd.habblaud`, KeepAlive,
Node absoluto, `HABBLAUD_PTY=1`, logs em `~/.habblaud/logs/`). Docker desligado, volume preservado para rollback.
Migração de dados do volume para `~/.habblaud` conforme o README. Check: `/api/health` com `pty: true`, terminal
interativo abre no Mac, reinício do Mac sobe o serviço sozinho. Rollback: `launchctl bootout` + `npm run docker:up`.

**C2. Terminal interativo no iPhone, só pela tailnet.**

- Terceiro listener em `127.0.0.1:4749` (`HABBLAUD_TAILNET_PORT`), HTTP só em loopback, sem exposição na LAN; o TLS
  fica com o `tailscale serve`, que publica esse listener numa segunda porta HTTPS da tailnet
  (`tailscale serve --bg --https=8443 http://127.0.0.1:4749`). A 443 da tailnet continua apontando para a 4748.
- Requisição nesse listener precisa de: login remoto válido; cabeçalho `Tailscale-User-Login` igual a
  `HABBLAUD_TAILNET_USER` (o `tailscale serve` remove o enviado pelo cliente e põe o verdadeiro); capacidade nova
  `pty` em `HABBLAUD_REMOTE_ALLOW`.
- Abrir ou assumir um PTY pede a senha de novo se a última confirmação tiver mais de 10 min.
- Na 4748 (LAN) o PTY continua recusado, como hoje.
- Cliente móvel: barra de teclas (Esc, Tab, Ctrl, setas) acima do teclado do iPhone.
- Check: testes do gate (LAN → 403; tailnet sem cabeçalho → 403; usuário errado → 403; sem `pty` → 403; ok → 200;
  confirmação vencida → 401) e caso real no 4G.

## Fase 6 — Hermes no escritório (E)

Integração pelo mecanismo oficial do Hermes (Event Hooks / Observer Hooks), sem mudar núcleo, modelos ou rotas.

- **Plugin `habblaud-observer`** (VPS): registra `on_session_start`, `on_session_end`, `pre_tool_call`,
  `post_tool_call`, `pre_llm_call`, `post_llm_call`, `subagent_start`, `subagent_stop`. Envia `{profile, platform,
  session_id, event, tool_name, status, duration_ms, at}`. Não envia texto de mensagens, argumentos de ferramentas nem
  resultados (o grupo PND tem dados de terceiros). Fila em memória, envio assíncrono, timeout de 2 s, descarta na
  falha: o Hermes nunca espera o Habblaud.
- **Transporte:** VPS entra na tailnet (OK do Itallo, com backup e rollback: desligar o plugin e sair da tailnet).
- **Habblaud:** `POST /api/hermes/events` no listener da tailnet. A VPS é um nó da tailnet sem login de usuário,
  então essa rota é a única do listener que não pede login nem `Tailscale-User-Login`: exige token Bearer (só o hash
  no `.env`), corpo até 64 KB e validação do formato. Qualquer outra rota segue as regras do C2. `HermesSource` (contrato `AgentSource`) cria um agente por sessão ativa; ocioso após
  inatividade; `offline` em `on_session_end`. Provider novo `hermes` em `shared/types.ts`, excluído do Habblaud World.
- Check: testes da rota (token errado → 401, corpo inválido → 400) e da fonte (sessão abre, ferramenta vira
  atividade, fim fecha); teste do plugin com servidor falso (timeout não bloqueia); caso real com uma mensagem no
  Telegram aparecendo no escritório.

## Fora do escopo

Push automático; PR para o upstream; PTY pela LAN; mudanças no núcleo do Hermes; resposta ao Hermes pelo Habblaud;
envio de agentes Hermes ao Habblaud World.

## Riscos

- `codex queue` pode não aceitar a resposta estruturada (spike da Fase 3 decide).
- Docker Desktop deixa de ser o modo de execução (Fase 5); rollback documentado.
- Hooks do Hermes mudam entre versões; o plugin valida a versão e se desliga sozinho se a assinatura mudar.
