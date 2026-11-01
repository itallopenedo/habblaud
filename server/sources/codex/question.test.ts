// Pergunta ao usuário do Codex (request_user_input_async): aberta até o resultado da chamada.
import { describe, expect, it } from 'vitest';
import { R, threadId } from '../../test/codex-fixtures';
import { createCodexState, parseRolloutLine, type CodexLineResult, type CodexState } from './rollout';

const T = threadId(1);
const ctx = { idPrefix: 'acc:t', now: 0 };

function feed(lines: string[], state: CodexState = createCodexState()): { state: CodexState; results: CodexLineResult[] } {
  return { state, results: lines.map((l) => parseRolloutLine(state, l, ctx)) };
}

describe('rollout do Codex: pergunta ao usuário', () => {
  it('pergunta aberta vira ask com opções e espera; a resposta fecha a espera', () => {
    const at = Date.parse('2026-10-30T12:00:00Z');
    const open = feed([
      R.meta(T, { at }),
      R.taskStarted('turn1', at + 1),
      R.functionCall('c1', 'request_user_input_async', { questions: [{ title: 'Aprova?', options: ['Sim', 'Não'] }] }, at + 2),
    ]);
    const asks = open.results.flatMap((r) => r.activities.map((a) => a.activity)).filter((a) => a.kind === 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0].questions).toEqual([
      { index: 0, question: 'Aprova?', options: [{ index: 0, label: 'Sim' }, { index: 1, label: 'Não' }] },
    ]);
    expect(open.results.flatMap((r) => r.signals)).toContainEqual({ type: 'question', open: true });
    expect(open.state.questions.has('c1')).toBe(true);

    // O resultado da chamada ({accepted}) não é a resposta: a pergunta segue aberta.
    const accepted = feed([R.functionOutput('c1', '{"accepted":true}', at + 3)], open.state);
    expect(accepted.results.flatMap((r) => r.signals)).not.toContainEqual({ type: 'question', open: false });
    expect(accepted.state.questions.has('c1')).toBe(true);

    // A resposta do usuário (mensagem com o call_id) fecha a pergunta.
    const reply = `<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"c1\\",0]","answer":"Sim"}]`;
    const answered = feed([R.message('user', reply, at + 4)], accepted.state);
    expect(answered.results.flatMap((r) => r.signals)).toContainEqual({ type: 'question', open: false });
    expect(answered.results.flatMap((r) => r.activities.map((a) => a.activity.text))).toContain('Recebeu a sua resposta');
    expect(answered.state.questions.size).toBe(0);
  });

  it('pergunta recusada pelo Codex (erro em vez de {accepted}) não fica aberta', () => {
    const at = Date.parse('2026-11-01T17:55:00Z');
    const open = feed([
      R.meta(T, { at }),
      R.taskStarted('turn1', at + 1),
      R.functionCall('c0', 'request_user_input', { questions: [{ title: 'Qual cor?', options: ['Azul', 'Verde'] }] }, at + 2),
    ]);
    expect(open.state.questions.has('c0')).toBe(true);
    const refused = feed([R.functionOutput('c0', 'request_user_input is unavailable in Default mode', at + 3)], open.state);
    expect(refused.state.questions.size).toBe(0);
    expect(refused.results.flatMap((r) => r.signals)).toContainEqual({ type: 'question', open: false });
  });
});
