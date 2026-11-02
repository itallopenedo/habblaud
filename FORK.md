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
    npm run native:uninstall   # tira o serviço (para voltar ao Docker: npm run docker:up)

O serviço lê o mesmo `.env` do projeto (`node --env-file-if-exists`); logs em `~/.habblaud/logs/habblaud.log` e
`habblaud.error.log`. Não rode o Docker e o serviço ao mesmo tempo (mesma porta). Dados: `~/.habblaud` (no Docker, o
volume `habblaud_habblaud-data`; a migração copiou o volume para `~/.habblaud` e deixou um backup em
`~/.habblaud/docker-data-backup-<data>`). O `npm run codex:bridge` não é necessário no modo nativo.

## Terminal interativo no iPhone (só pela tailnet)

No `.env`: `HABBLAUD_TAILNET_USER=<login do Tailscale>` e `pty` em `HABBLAUD_REMOTE_ALLOW`. O Habblaud abre a porta
`127.0.0.1:4749` (`HABBLAUD_TAILNET_PORT`), que o Tailscale publica com HTTPS:

    tailscale serve --bg --https=8443 http://127.0.0.1:4749     # desligar: tailscale serve --https=8443 off

No iPhone: `https://<mac>.<tailnet>.ts.net:8443` (o mesmo login da 443). Abrir, assumir ou encerrar um terminal pede a
senha de novo quando a última conferência passou de 10 min; sem a senha recente, digitar e fechar só valem nos
terminais que a mesma sessão abriu ou ligou. Pela rede local (4748) o terminal interativo continua recusado.

O que protege: a 4749 só escuta no `127.0.0.1` (ninguém da rede a alcança); toda requisição precisa do cabeçalho
`Tailscale-User-Login` igual a `HABBLAUD_TAILNET_USER` (o `tailscale serve` põe o do usuário da tailnet e descarta o
que vier do cliente), do login remoto (as mesmas sessões e o mesmo freio de senha da 4748) e de `pty` liberado; as
rotas só do computador (`/api/host/*`, hooks, World) seguem recusadas. Limite conhecido: um processo do próprio Mac
consegue imitar o cabeçalho, mas ainda precisa do login, de `pty` e da senha recente, e esse processo já teria a 4747.
