// Fonte do Hermes (server/sources/hermes/source.ts) com o Office de verdade e um relógio manual: a sessão abre, a
// ferramenta vira atividade, a aprovação vira "precisa de você", o fim fecha, o silêncio põe à toa e tira. Dados
// sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { describeHermesTool, HERMES_MAX_SESSIONS, HERMES_QUIET_MS, HERMES_STALE_MS, HermesSource, hermesAgentId, type HermesEvent } from './source';

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

  it('ferramenta mais longa que o silêncio: o tick põe à toa, o post_tool_call devolve a "trabalhando" (e nunca tira de "precisa de você")', () => {
    const { clock, office, source, ev } = setup();
    source.apply([ev('pre_tool_call', { tool: 'terminal' })]);
    clock.t += HERMES_QUIET_MS;
    source.tick();
    expect(office.get(ID)!.status).toBe('idle');
    source.apply([ev('post_tool_call', { tool: 'terminal', ok: true })]);
    expect(office.get(ID)!.status).toBe('working');
    source.apply([ev('pre_approval_request'), ev('post_tool_call', { tool: 'terminal', ok: true })]);
    expect(office.get(ID)!.status).toBe('waiting');
  });

  it('evento tardio (post_llm_call, on_session_end) de sessão fechada ou desconhecida não cria nem revive o agente', () => {
    const { office, source, ev } = setup();
    source.apply([ev('post_llm_call'), ev('on_session_end')]);
    expect(office.get(ID)).toBeUndefined();
    source.apply([ev('pre_llm_call'), ev('on_session_finalize')]);
    source.apply([ev('post_llm_call'), ev('on_session_end')]);
    expect(office.get(ID)!.status).toBe('offline');
    expect(source.sources()[0].sessions).toBe(0);
  });

  it('cron e subagente: o fim da conversa fecha o agente (nada de fantasma por 6 h); telegram continua à toa', () => {
    const { office, source, ev } = setup();
    source.apply([ev('pre_llm_call', { platform: 'cron' }), ev('on_session_end', { platform: 'cron' })]);
    expect(office.get(ID)!.status).toBe('offline');
    expect(source.sources()[0].sessions).toBe(0);
    const SUB = '1123456789abcdef';
    source.apply([ev('pre_llm_call', { platform: 'subagent', session: SUB }), ev('post_llm_call', { platform: 'subagent', session: SUB })]);
    expect(office.get(hermesAgentId(SUB))!.status).toBe('offline');
    expect(source.sources()[0].sessions).toBe(0);
    source.apply([ev('pre_llm_call', { session: '2123456789abcdef' }), ev('on_session_end', { session: '2123456789abcdef' })]);
    expect(office.get(hermesAgentId('2123456789abcdef'))!.status).toBe('idle');
    expect(source.sources()[0].sessions).toBe(1);
  });

  it('teto de sessões vivas: a seguinte não cria agente; sessão existente continua recebendo eventos', () => {
    const { office, source, ev } = setup();
    const sid = (n: number) => n.toString(16).padStart(16, '0');
    for (let n = 0; n < HERMES_MAX_SESSIONS; n++) source.apply([ev('pre_llm_call', { session: sid(n) })]);
    expect(source.sources()[0].sessions).toBe(HERMES_MAX_SESSIONS);
    source.apply([ev('pre_llm_call', { session: sid(HERMES_MAX_SESSIONS) })]);
    expect(office.get(hermesAgentId(sid(HERMES_MAX_SESSIONS)))).toBeUndefined();
    expect(source.sources()[0].sessions).toBe(HERMES_MAX_SESSIONS);
    source.apply([ev('pre_tool_call', { session: sid(0), tool: 'terminal' })]);
    expect(office.get(hermesAgentId(sid(0)))!.activity).toMatchObject({ kind: 'run' });
  });

  it('o início do turno usa o relógio daqui, não o da VPS (atrasado)', () => {
    const { clock, office, source, ev } = setup();
    source.apply([ev('pre_llm_call', { at: clock.t - 3_600_000 })]);
    expect(office.get(ID)!.activity!.at).toBe(clock.t);
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
