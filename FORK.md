# Este fork

`itallopenedo/habblaud` é o Habblaud do Itallo, em cima do [marmottajr/habblaud](https://github.com/marmottajr/habblaud).

- `main`: espelho do upstream. Nunca recebe commit próprio.
- `meu-habblaud`: o que roda neste Mac (`~/habblaud`). Recebe as fases por PR no fork.
- `fase-N-<nome>`: trabalho em andamento, um por fase do plano em `docs/superpowers/`.

Versão nova do upstream:

    npm run upstream:sync

Ele avança a `main` (só fast-forward), faz o merge em `meu-habblaud` num worktree temporário e roda typecheck,
testes e i18n. Com conflito ou teste vermelho, o worktree fica para resolver e `meu-habblaud` não anda (a `main` pode
ter avançado, pois só espelha o upstream). Nunca faz push: depois de
conferir, `git push fork meu-habblaud` e `npm run native:install` (ou `npm run docker:up`, no Docker).

## Habblaud nativo (sem Docker)

Neste Mac o Habblaud roda como serviço do macOS, não no Docker (o terminal interativo só existe fora do container):

    npm run native:install     # build + LaunchAgent com.pnd.habblaud (KeepAlive, HABBLAUD_PTY=1); também serve para atualizar
    npm run native:status      # serviço, versão e se o terminal interativo está ligado
    npm run native:uninstall   # tira o serviço

Rode o `native:install` de dentro de `~/habblaud`, com o Node que o serviço deve usar: o projeto do serviço é a pasta
do próprio script (rodar de um worktree aponta o serviço para o worktree) e o plist grava o caminho real desse Node.
A troca (bootout, esperar o serviço sumir, bootstrap) roda num processo à parte, e o instalador só dá sucesso quando
responde um Habblaud que subiu depois da reinstalação. Por isso dá para rodar pelo terminal interativo do próprio
Habblaud: o terminal fecha quando o servidor cai, mas a reinstalação segue sozinha; confira depois com
`npm run native:status` (não testado ao vivo ainda). Para só reiniciar, sem mudar o plist:

    launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud

Apagar a versão do Node do fnm usada no plist (`fnm uninstall`) quebra o serviço: rode `npm run native:install` de
novo com a versão nova.

O serviço lê o mesmo `.env` do projeto (`node --env-file-if-exists`), e a senha (hash) e os usuários do acesso remoto
saem do ambiente logo ao iniciar (os terminais e agentes abertos pelo Habblaud não os herdam); logs em
`~/.habblaud/logs/habblaud.log` e `habblaud.error.log`. Não rode o Docker e o serviço ao mesmo tempo (mesma porta).
Dados: `~/.habblaud` (no Docker, o volume `habblaud_habblaud-data`; a migração, quando for feita, vai copiar o volume
para `~/.habblaud` e deixar um backup em `~/.habblaud/docker-data-backup-<data>`). O `npm run codex:bridge` não é
necessário no modo nativo (a migração vai desligar o `com.pnd.habblaud-codex-bridge`).

Voltar ao Docker: `npm run native:uninstall`, religar o auxiliar
(`launchctl enable gui/$(id -u)/com.pnd.habblaud-codex-bridge` e
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pnd.habblaud-codex-bridge.plist`) e `npm run docker:up`.

## Terminal interativo no iPhone (só pela tailnet)

No `.env`: `HABBLAUD_TAILNET_USER=<login do Tailscale>` e `pty` em `HABBLAUD_REMOTE_ALLOW`. O Habblaud abre a porta
`127.0.0.1:4749` (`HABBLAUD_TAILNET_PORT`), que o Tailscale publica com HTTPS:

    tailscale serve --bg --https=8443 http://127.0.0.1:4749     # desligar: tailscale serve --https=8443 off

No iPhone: `https://<mac>.<tailnet>.ts.net:8443` (o mesmo login da 443). Abrir, assumir ou encerrar um terminal pede a
senha de novo quando a última conferência passou de 10 min; sem a senha recente, digitar e fechar só valem nos
terminais que a mesma sessão abriu ou ligou, por até 12 h depois disso. Pela rede local (4748) o terminal interativo continua recusado.

O que protege: a 4749 só escuta no `127.0.0.1` (ninguém da rede a alcança); toda requisição precisa do cabeçalho
`Tailscale-User-Login` igual a `HABBLAUD_TAILNET_USER` (o `tailscale serve` põe o do usuário da tailnet e descarta o
que vier do cliente), do login remoto (as mesmas sessões da 4748, com freio de senha próprio: erros na rede local não travam a 8443) e de
`pty` liberado; pedidos pelo Funnel (cabeçalho `Tailscale-Funnel-Request`) são recusados; as
rotas só do computador (`/api/host/*`, hooks, World) seguem recusadas. Limite conhecido: um processo do próprio Mac
consegue imitar o cabeçalho, mas ainda precisa do login, de `pty` e da senha recente, e esse processo já teria a 4747.

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

O arquivo precisa ser só do dono (`chmod 600`): com permissão de grupo ou de outros o plugin o recusa e não registra
nada. `HABBLAUD_OBSERVER_CONFIG` (outro caminho para o JSON) vale para o processo inteiro, ou seja, para todos os perfis
do gateway: existe só para os testes; em produção cada perfil usa o seu `<HERMES_HOME>/habblaud-observer.json`. O plugin
junta os eventos por até 1 s (até 50 por requisição), porque o Habblaud tem um freio único de 60 requisições por 10 s
para todos os perfis, e não usa proxy nem segue redirecionamento. Esse freio vale para todos os perfis juntos: cada perfil
manda cerca de 1 requisição por segundo, então muitos perfis ativos ao mesmo tempo podem perder lotes (o Habblaud responde
"tente de novo" e o escritório se corrige nos eventos seguintes).

Limites e cuidados:

- O token fica legível para o próprio Hermes (ele roda como root e tem a ferramenta terminal, então consegue ler o JSON).
  Trocar o token: gerar outro, pôr a nova hash no `.env` do Mac (`HABBLAUD_HERMES_TOKEN_HASH`), reiniciar o Habblaud e
  atualizar o JSON de cada perfil na VPS.
- O escritório mostra no máximo 50 sessões do Hermes vivas ao mesmo tempo (`HERMES_MAX_SESSIONS`); sessão nova além disso é
  descartada (com um aviso no log) até alguma sair. Sessões de cron e de subagente saem no fim da primeira conversa.
- Instalar copiando a pasta do plugin para a VPS, nunca com symlink.

Depois, reiniciar o gateway do jeito que as notas do Hermes mandam (sem turno em andamento). Desligar: tirar a linha
de `plugins.enabled` (o backup é `config.yaml.bak-habblaud-*`), reiniciar o gateway e apagar a pasta do plugin e o
JSON. Testes do plugin: `python3 -m unittest discover -s integrations/hermes`. Agentes do Hermes nunca vão ao Habblaud
World (a projeção só aceita Claude Code e Codex).
