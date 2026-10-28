import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Load the standalone host script without adding it to the server's TypeScript build.
const script = '../../scripts/phone-notify.mjs';
const { createNotifier } = await import(script);
const agent = (id = 'private-session', question = 'question-1', status = 'waiting') => ({
  id, sessionId: id, status, title: 'PRIVATE CLIENT PROJECT', roomId: '/private/project',
  activity: { id: question, text: 'PRIVATE QUESTION', kind: 'ask' },
});

describe('phone notification bridge', () => {
  let directory: string;
  let snapshot: unknown;
  let messages: Record<string, unknown>[];
  let failSend: boolean;
  let failSnapshot: boolean;
  let clock: number;
  let snapshotCalls: number;
  let logs: string[];
  let options: Record<string, unknown>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'habblaud-phone-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ topic: 'test-topic', url: 'https://office.example', user: 'PRIVATE USER', password: 'PRIVATE PASSWORD' }));
    snapshot = { agents: [agent()] };
    messages = []; logs = []; failSend = false; failSnapshot = false; clock = 0; snapshotCalls = 0;
    options = {
      configPath, statePath: join(directory, 'state.json'), now: () => clock,
      log: (message: string) => logs.push(message),
      fetchImpl: async (url: string, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.redirect).toBe('error');
        if (url === 'http://127.0.0.1:4747/api/snapshot') {
          snapshotCalls++;
          if (failSnapshot) throw new Error('PRIVATE FETCH ERROR');
          return new Response(JSON.stringify(snapshot));
        }
        expect(url).toBe('https://ntfy.sh');
        if (failSend) return new Response('PRIVATE ERROR', { status: 503 });
        messages.push(JSON.parse(String(init.body)));
        return new Response('{}');
      },
    };
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('sends initial pending once and retains dedupe across restarts with private state', async () => {
    const notifier = await createNotifier(options);
    await notifier.poll();
    await notifier.poll();
    await (await createNotifier(options)).poll();
    expect(messages).toHaveLength(1);
    const state = await readFile(join(directory, 'state.json'), 'utf8');
    expect(state).not.toContain('private-session');
    expect((await stat(join(directory, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('notifies new questions for the same agent and new waits after an answer', async () => {
    const notifier = await createNotifier(options);
    await notifier.poll();
    snapshot = { agents: [agent('private-session', 'question-2')] };
    await notifier.poll();
    snapshot = { agents: [agent('private-session', 'question-2', 'offline')] };
    await notifier.poll();
    snapshot = { agents: [agent('private-session', 'question-2')] };
    await notifier.poll();
    expect(messages).toHaveLength(3);
  });

  it('uses permission identity before changing background activity', async () => {
    const notifier = await createNotifier(options);
    snapshot = { agents: [{ ...agent(), permission: { id: 'permission-1' } }] };
    await notifier.poll();
    snapshot = { agents: [{ ...agent('private-session', 'background'), permission: { id: 'permission-1' } }] };
    await notifier.poll();
    snapshot = { agents: [{ ...agent(), permission: { id: 'permission-2' } }] };
    await notifier.poll();
    expect(messages).toHaveLength(2);
  });

  it('retries an undelivered push after backoff without losing the episode', async () => {
    const notifier = await createNotifier(options);
    failSend = true;
    expect(await notifier.poll()).toBe('error');
    failSend = false;
    await notifier.poll();
    expect(messages).toHaveLength(0);
    clock = 3000;
    await notifier.poll();
    expect(messages).toHaveLength(1);
    expect(logs.join(' ')).not.toMatch(/PRIVATE|test-topic|https:/);
  });

  it('keeps dedupe after failed or malformed snapshots', async () => {
    const notifier = await createNotifier(options);
    await notifier.poll();
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    for (const invalid of [{}, { agents: [{ status: 'waiting' }] }, { agents: [null] }]) {
      snapshot = invalid;
      expect(await notifier.poll()).toBe('error');
    }
    failSnapshot = true;
    expect(await notifier.poll()).toBe('error');
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe(before);
    failSnapshot = false; clock = 60000; snapshot = { agents: [agent()] };
    await notifier.poll();
    expect(messages).toHaveLength(1);
  });

  it('aggregates counts and sends only generic notification fields', async () => {
    snapshot = { agents: [agent(), agent('another-private-session')] };
    await (await createNotifier(options)).poll();
    expect(messages).toEqual([{
      topic: 'test-topic', title: 'Habblaud: precisa de você',
      message: 'Há 2 agentes aguardando sua resposta. Abra o Habblaud.',
      click: 'https://office.example', priority: 4, tags: ['raised_hand'],
    }]);
    expect(JSON.stringify(messages)).not.toMatch(/PRIVATE|private-session|\/private\/project/);
  });

  it('sends a generic test without marking pending episodes delivered', async () => {
    const notifier = await createNotifier(options);
    await notifier.test();
    expect(snapshotCalls).toBe(0);
    await notifier.poll();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE');
  });

  it('does not overlap concurrent polls', async () => {
    const notifier = await createNotifier(options);
    await Promise.all([notifier.poll(), notifier.poll(), notifier.poll()]);
    expect(snapshotCalls).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it('rejects malformed config before sending or exposing its contents', async () => {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ topic: 12345, url: 'https://office.example' }));
    await expect(createNotifier(options)).rejects.toThrow();
    expect(messages).toHaveLength(0);
  });

  it('fails closed on corrupt persisted dedupe instead of sending duplicates', async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ delivered: ['not-a-hash'] }));
    await expect(createNotifier(options)).rejects.toThrow();
    expect(messages).toHaveLength(0);
  });

  it('uses stable reasons without activity ids and removes answered agents', async () => {
    const notifier = await createNotifier(options);
    snapshot = { agents: [{ id: 'a', sessionId: 's', status: 'waiting', waitingFor: 'responder' }] };
    await notifier.poll();
    await notifier.poll();
    snapshot = { agents: [] };
    await notifier.poll();
    snapshot = { agents: [{ id: 'a', sessionId: 's', status: 'waiting', waitingFor: 'responder' }] };
    await notifier.poll();
    expect(messages).toHaveLength(2);
  });

  it('caps repeated delivery failures at a one minute retry interval', async () => {
    const notifier = await createNotifier(options);
    failSend = true;
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await notifier.poll()).toBe('error');
      if (attempt < 9) clock += 60000;
    }
    failSend = false;
    clock += 59999;
    await notifier.poll();
    expect(messages).toHaveLength(0);
    clock++;
    await notifier.poll();
    expect(messages).toHaveLength(1);
  });
});
