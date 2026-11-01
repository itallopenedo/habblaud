#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const home = join(homedir(), '.habblaud');

export async function createNotifier({
  configPath = join(home, 'iphone-access.json'), statePath = join(home, 'phone-notify-state.json'),
  fetchImpl = fetch, now = Date.now, log = console.log,
  stuckMs = Number(process.env.HABBLAUD_STUCK_MIN || 15) * 60000,
} = {}) {
  const { topic, url } = JSON.parse(await readFile(configPath, 'utf8'));
  const click = new URL(url);
  if (typeof topic !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(topic) || !['http:', 'https:'].includes(click.protocol)
      || click.username || click.password) throw new Error('Configuração inválida.');
  let delivered = new Set();
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Array.isArray(state.delivered) || state.delivered.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
      throw new Error('Estado inválido.');
    }
    delivered = new Set(state.delivered);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let busy = false, failures = 0, retryAt = 0;
  const request = (target, init = {}) => fetchImpl(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
  async function send(message) {
    const response = await request('https://ntfy.sh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: 'Habblaud: precisa de você', message, click: url, priority: 4, tags: ['raised_hand'] }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Envio falhou.');
  }
  async function persist(keys) {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ delivered: [...keys] }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, statePath);
    } finally { await rm(temporary, { force: true }); }
    delivered = keys;
  }
  return {
    async poll() {
      if (busy) return 'busy';
      busy = true;
      try {
        const response = await request('http://127.0.0.1:4747/api/snapshot');
        if (!response.ok) throw new Error('Snapshot indisponível.');
        const snapshot = await response.json();
        if (!snapshot || !Array.isArray(snapshot.agents) || snapshot.agents.some((agent) => !agent
            || typeof agent.id !== 'string' || !agent.id || typeof agent.sessionId !== 'string'
            || !['working', 'waiting', 'idle', 'shell', 'done', 'offline'].includes(agent.status)
            || (agent.permission != null && typeof agent.permission.id !== 'string')
            || (agent.activity != null && (typeof agent.activity.id !== 'string'
              || (agent.activity.error != null && typeof agent.activity.error !== 'boolean')))
            || (agent.lastEventAt != null && typeof agent.lastEventAt !== 'number')
            || (agent.waitingFor != null && typeof agent.waitingFor !== 'string'))) throw new Error('Snapshot inválido.');
        const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
        const waiting = snapshot.agents.filter((agent) => agent.status === 'waiting');
        const stuck = snapshot.agents.filter((agent) => agent.status === 'working' && !agent.shells?.length
          && now() - agent.lastEventAt > stuckMs);
        const errors = snapshot.agents.filter((agent) => !['working', 'waiting'].includes(agent.status)
          && agent.activity?.error === true);
        const pending = new Set([
          ...waiting.map((agent) => key(agent.id, agent.sessionId,
            agent.permission?.id || agent.activity?.id || agent.waitingFor || 'waiting')),
          ...stuck.map((agent) => key('stuck', agent.id, agent.sessionId, agent.lastEventAt)),
          ...errors.map((agent) => key('error', agent.id, agent.sessionId, agent.activity.id)),
        ]);
        const kept = new Set([...delivered].filter((key) => pending.has(key)));
        const hasNew = [...pending].some((key) => !delivered.has(key));
        if (hasNew && now() >= retryAt) {
          const parts = [
            waiting.length && `${waiting.length} agentes aguardando sua resposta`,
            stuck.length && `${stuck.length} agentes sem novidade há mais de ${Math.round(stuckMs / 60000)} min`,
            errors.length && `${errors.length} agentes parados com erro`,
          ].filter(Boolean);
          await send(`Há ${parts.join(', ')}. Abra o Habblaud.`);
          await persist(pending);
          failures = 0; retryAt = 0;
          log(`Notificação enviada (${pending.size}).`);
          return 'sent';
        }
        if (kept.size !== delivered.size) await persist(kept);
        return 'unchanged';
      } catch {
        retryAt = now() + Math.min(60000, 3000 * 2 ** Math.min(failures++, 5));
        log('Falha temporária na notificação; nova tentativa automática.');
        return 'error';
      } finally { busy = false; }
    },
    async test() {
      await send('Teste de notificação. Abra o Habblaud.');
      log('Notificação de teste enviada.');
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !['--once', '--test'].includes(arg))) throw new Error('Uso: phone-notify.mjs [--once | --test]');
  const notifier = await createNotifier();
  if (args.includes('--test')) { await notifier.test(); return; }
  if (args.includes('--once')) { if (await notifier.poll() === 'error') process.exitCode = 1; return; }
  for (;;) { await notifier.poll(); await sleep(3000); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Não foi possível iniciar a notificação. Verifique a configuração local.'); process.exitCode = 1; });
}
