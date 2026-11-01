# Fase 3 — Alertas e perguntas do Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avisar no iPhone quando um agente trava ou para com erro, tirar a espera falsa de um Codex que morreu no meio
de uma pergunta e dizer no cartão como responder o Codex.

**Architecture:** Três mudanças independentes. (1) `scripts/phone-notify.mjs` ganha dois motivos de aviso além da espera,
com a mesma deduplicação. (2) `CodexSource` só conta a pergunta aberta como espera enquanto o Codex dá sinal de vida.
(3) O drawer mostra as perguntas do Codex (só leitura) e a dica "⇧←".

**Tech Stack:** Node 24 + TypeScript (tsx), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-meu-habblaud-design.md` (Fase 3). Mudança registrada: o spike mostrou que
`codex queue` não entrega a resposta enquanto o turno está aberto esperando por ela (impasse), e o plano B (texto comum)
cai no mesmo impasse. A parte F vira só exibição: responder o Codex continua no Codex.

## Global Constraints

- Branch `fase-3-alertas` a partir de `meu-habblaud` → PR para `meu-habblaud` no fork `itallopenedo/habblaud`.
- Avisos do ntfy só com texto genérico: nada de títulos, projetos, comandos, caminhos ou ids. Mesma deduplicação persistente.
- `shared/world/` e `server/world/`: não mexer.
- Texto visível do app passa por `tr()` com traduções em `shared/locales/{en,es,fr}.ts`; `npm run i18n:check` verde.
- Mudança visível entra em `## [Não lançado]` do `CHANGELOG.md`.
- Commits terminam com `Co-Authored-By:` do modelo que escreveu.
- Antes do PR: `npm run typecheck`, `npm test`, `npm run i18n:check`, `git diff --check` verdes.
- Nunca `git add -A`.

---

### Task 1: Alertas de travado e de erro no ntfy

**Files:**
- Modify: `scripts/phone-notify.mjs`
- Test: `server/test/phone-notify.test.ts`

**Regras:**
- Espera: igual a hoje (`status === 'waiting'`).
- Travado: `status === 'working'`, sem shells em andamento (`!agent.shells?.length`) e `now() - agent.lastEventAt >
  stuckMs`. `stuckMs` vem da opção `stuckMs` ou de `HABBLAUD_STUCK_MIN` (minutos, padrão 15).
- Erro: status diferente de `working`/`waiting` e `agent.activity?.error === true`.
- Chaves de deduplicação (sha256 de JSON): espera como hoje; travado `['stuck', id, sessionId, lastEventAt]`; erro
  `['error', id, sessionId, activity.id]`.
- Mensagem: `Há ${partes.join(', ')}. Abra o Habblaud.`, com as partes `${n} agentes aguardando sua resposta`,
  `${n} agentes sem novidade há mais de ${min} min`, `${n} agentes parados com erro` (só as que têm n > 0). Só com
  espera, o texto é exatamente o de hoje.

- [ ] **Step 1: Testes (falhando)** — em `server/test/phone-notify.test.ts`, dentro do `describe`:

```ts
  it('avisa agente travado (working sem novidade além do limite) uma vez por episódio', async () => {
    const notifier = await createNotifier({ ...options, stuckMs: 15 * 60_000 });
    clock = 20 * 60_000;
    snapshot = { agents: [{ ...agent('busy', 'act-1', 'working'), lastEventAt: 0 }] };
    await notifier.poll();
    await notifier.poll();
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe('Há 1 agentes sem novidade há mais de 15 min. Abra o Habblaud.');
    // Voltou a ter novidade e travou de novo: novo episódio.
    snapshot = { agents: [{ ...agent('busy', 'act-2', 'working'), lastEventAt: 19 * 60_000 }] };
    await notifier.poll();
    clock = 40 * 60_000;
    await notifier.poll();
    expect(messages).toHaveLength(2);
  });

  it('não avisa travado com shell rodando nem dentro do limite', async () => {
    const notifier = await createNotifier({ ...options, stuckMs: 15 * 60_000 });
    clock = 20 * 60_000;
    snapshot = { agents: [
      { ...agent('shell', 'a', 'working'), lastEventAt: 0, shells: [{ id: 's1' }] },
      { ...agent('fresh', 'b', 'working'), lastEventAt: 10 * 60_000 },
    ] };
    await notifier.poll();
    expect(messages).toHaveLength(0);
  });

  it('avisa agente parado com erro, junto da espera, com texto genérico', async () => {
    const notifier = await createNotifier(options);
    snapshot = { agents: [
      agent(),
      { ...agent('broken', 'err-1', 'idle'), activity: { id: 'err-1', text: 'PRIVATE ERROR', kind: 'error', error: true } },
    ] };
    await notifier.poll();
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe('Há 1 agentes aguardando sua resposta, 1 agentes parados com erro. Abra o Habblaud.');
    expect(JSON.stringify(messages[0])).not.toContain('PRIVATE');
  });
```

- [ ] **Step 2: Ver falhar** — `npx vitest run server/test/phone-notify.test.ts` → os 3 novos falham.

- [ ] **Step 3: Implementar** em `scripts/phone-notify.mjs`:
  - `createNotifier({ ..., stuckMs = Number(process.env.HABBLAUD_STUCK_MIN || 15) * 60000 } = {})`.
  - Na validação do snapshot, aceitar `lastEventAt` número ou ausente e `activity.error` booleano ou ausente
    (snapshot com outro tipo continua inválido).
  - Montar `waiting`, `stuck` e `errors` (listas de agentes) pelas regras acima; `pending` = união das chaves.
  - A mensagem conforme a regra; o resto (dedupe, persist, retry, logs) igual.

- [ ] **Step 4: Ver passar** — `npx vitest run server/test/phone-notify.test.ts` → todos verdes (os antigos também).

- [ ] **Step 5: Commit** — `git add scripts/phone-notify.mjs server/test/phone-notify.test.ts` e commit
  "Avisos no iPhone: agente travado ou parado com erro".

---

### Task 2: Pergunta do Codex só conta como espera enquanto o Codex dá sinal de vida

**Problema:** um Codex morto no meio de uma pergunta (aba fechada) deixa o lock; a pergunta aberta vence tudo
(`settleStatus` e `decide`) e o agente aparece "esperando você" por até 12 h. Enquanto espera de verdade, o Codex chama
`sleep` sem parar (hooks e escritas no rollout a cada poucos segundos).

**Files:**
- Modify: `server/sources/codex/source.ts`
- Test: `server/sources/codex/source.test.ts` (no `describe('fonte do Codex: eventos de hook')`)

- [ ] **Step 1: Teste (falhando)**

```ts
  it('pergunta aberta sem sinal de vida por QUESTION_QUIET_MS deixa de contar como espera', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook(ev('UserPromptSubmit', { prompt: 'me pergunte' }));
    const q = { questions: [{ title: 'Qual cor?', options: ['Azul', 'Verde'] }] };
    ctx.home.rollout(T, [
      R.meta(T, { at: ctx.now() - 5_000, cwd: '/projetos/api' }),
      R.taskStarted('turn1', ctx.now() - 4_000),
      R.functionCall('q1', 'request_user_input_async', q, ctx.now() - 3_000),
      R.functionOutput('q1', '{"accepted":true}', ctx.now() - 2_000),
    ]);
    ctx.home.lock(T, ctx.now() - 5_000);
    ctx.advance(3_100);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('waiting');
    // O processo morreu: nenhum hook, nenhuma escrita. O lock fica.
    ctx.advance(QUESTION_QUIET_MS + 1_000);
    ctx.poll();
    expect(ctx.agent()?.status).not.toBe('waiting');
  });
```

  Importar `QUESTION_QUIET_MS` de `./source`.

- [ ] **Step 2: Ver falhar** — `npx vitest run server/sources/codex/source.test.ts -t "sinal de vida"`.

- [ ] **Step 3: Implementar** em `server/sources/codex/source.ts`:

```ts
/** Pergunta aberta sem hook nem escrita no rollout por este tempo: o Codex morreu esperando (lock órfão), não espera mais. */
export const QUESTION_QUIET_MS = 10 * 60_000;
```

  e, na classe:

```ts
  /** Pergunta aberta e o Codex ainda dando sinal de vida (hooks e escritas do `sleep` da espera). */
  private asking(t: ThreadTracker, now: number): boolean {
    if (!t.state.questions.size) return false;
    return now - Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.state.lastAt ?? 0) < QUESTION_QUIET_MS;
  }
```

  - `decide`: trocar `t.state.questions.size` por `this.asking(t, at)`.
  - `settleStatus`: trocar `if (s.questions.size)` por `if (this.asking(t, this.now()))`.
  - `quietCheck`: antes do `if (t.status !== 'working') return;`, acrescentar:

```ts
    // Espera por pergunta de um Codex que parou de dar sinal (processo morto, lock órfão): deixa de esperar.
    if (t.status === 'waiting' && t.state.questions.size && !this.asking(t, now)) {
      this.decide(t, 'idle', now, undefined, true);
      return;
    }
```

- [ ] **Step 4: Ver passar** — `npx vitest run server/sources/codex` → todos verdes (inclui o teste dos hooks da espera,
  que continua `waiting` porque os hooks chegam dentro do limite).

- [ ] **Step 5: Commit** — arquivos explícitos, "Codex: pergunta sem sinal de vida deixa de contar como espera".

---

### Task 3: Cartão das perguntas do Codex

**Files:**
- Modify: `client/src/ui/drawer.ts`, `shared/locales/en.ts`, `shared/locales/es.ts`, `shared/locales/fr.ts`, `CHANGELOG.md`

- [ ] **Step 1:** Em `drawer.ts`:
  - `const asking = waiting && a.activity?.kind === 'ask' ? a.activity : undefined;` (sem `!codex`): as perguntas do
    Codex aparecem com as opções, só leitura (`<strong>`, o caminho que não é o do Claude Desktop). O comentário acima
    passa a dizer que o Codex também aparece, só leitura.
  - No texto do alerta, quando `codex && a.activity?.kind === 'ask'`:
    `tr('Responda no Codex: no terminal, ⇧← abre a pergunta.')` no lugar do "Vá ao Codex…".
- [ ] **Step 2:** Traduções da string nova:
  - en: `"Reply in Codex: in the terminal, ⇧← opens the question."`
  - es: `"Responde en Codex: en la terminal, ⇧← abre la pregunta."`
  - fr: `"Répondez dans Codex : dans le terminal, ⇧← ouvre la question."`
- [ ] **Step 3:** `CHANGELOG.md`, `## [Não lançado]`, `### Adicionado`:
  - `- **Avisos de travado e de erro no iPhone:** o \`scripts/phone-notify.mjs\` também avisa quando um agente fica
    trabalhando sem novidade por mais de 15 min (\`HABBLAUD_STUCK_MIN\`; não conta comandos ainda rodando) e quando
    para com erro. Texto genérico, como o aviso de espera.`
  - `### Corrigido`: `- **Codex morto no meio de uma pergunta não fica “esperando você”.** Sem sinal de vida por 10 min,
    a pergunta deixa de contar. O cartão das perguntas do Codex mostra as opções e como responder (⇧← no terminal do
    Codex): responder pelo escritório não é possível, porque o Codex só lê mensagens novas quando o turno termina.`
- [ ] **Step 4:** `npm run typecheck && npm run i18n:check` verdes.
- [ ] **Step 5:** Commit com os arquivos explícitos, "Cartão do Codex: perguntas visíveis e como responder".

---

### Task 4: Suíte, PR e ao vivo (com OK do Itallo)

- [ ] `npm run typecheck && npm test && npm run i18n:check && git diff --check` verdes.
- [ ] Pedir OK; push, PR para `meu-habblaud`, merge, `git -C ~/habblaud pull --ff-only fork meu-habblaud`,
  `npm run docker:up` em `~/habblaud`, reiniciar o serviço de avisos:
  `launchctl kickstart -k gui/$(id -u)/com.pnd.habblaud-phone-notify`.
- [ ] Ao vivo: abrir uma sessão Codex de teste com pergunta, fechar a aba e conferir que em até ~10 min ela sai de
  "esperando você" (sem apagar o lock à mão).
- [ ] Registrar em `projetos/habblaud.md`.
