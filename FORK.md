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
conferir, `git push fork meu-habblaud` e `npm run docker:up` (ou o serviço nativo, a partir da Fase 5).
