// Rotas do terminal interativo (PtyManager, server/pty/manager.ts):
//   GET  /api/pty                      estado do recurso e terminais abertos
//   POST /api/pty                      {cwd, account?, cols?, rows?}: sessão nova do Claude Code
//   GET  /api/pty/:id/stream           SSE: reset (tela guardada) | data | exit
//   POST /api/pty/:id/input|resize|close
//   POST /api/agents/:id/stop          encerra o agente (aqui ou noutro terminal)
//   POST /api/agents/:id/takeover      assume a sessão: encerra lá e retoma aqui
// Quem controla um terminal destes executa comandos na máquina: só conexões do próprio computador (o tailscale serve
// também conecta pelo loopback), com Host local — ou o nome da tailnet, na porta da tailnet — e (quando o navegador
// manda) Origin da mesma origem. A borda (http/guard.ts) já exige JSON nos POST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PtyError, type PtyManager } from '../pty/manager';
import { HttpError, ptyRequestProblem, readJson, sendJson } from './app';
import { tr } from '../../shared/i18n';

/** /api/agents/:id/(stop|takeover) (ids nunca contêm '/'). */
const AGENT_ACTION_ROUTE = /^\/api\/agents\/([^/]+)\/(stop|takeover)$/;

/**
 * `tailnet`: a requisição veio pela porta da tailnet. `claim`: o terminal que uma requisição da tailnet abriu, assumiu
 * ou ligou (o app já exigiu a senha recente para isso) passa a ser desta sessão.
 */
export function createPtyRoutes(
  ptys: PtyManager,
  opts: { tailnet?: (req: IncomingMessage) => boolean; claim?: (req: IncomingMessage, ptyId: string) => void } = {},
): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError || err instanceof PtyError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('erro interno') });
  };
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  };
  const decode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, tr('id inválido'));
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const tailnet = !!opts.tailnet?.(req);
    const problem = ptyRequestProblem(req, tailnet);
    if (problem) throw new HttpError(403, problem);
    const claim = (id: string) => {
      if (tailnet) opts.claim?.(req, id);
    };
    const method = req.method ?? 'GET';
    const action = AGENT_ACTION_ROUTE.exec(path);
    if (action) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const id = decode(action[1]);
      if (action[2] === 'stop') {
        await ptys.stop(id);
        return noContent(res);
      }
      const info = await ptys.takeover(id, { cols: body?.cols, rows: body?.rows });
      claim(info.id);
      return sendJson(res, 201, info);
    }
    // Rota estrita: /api/pty ou /api/pty/:id/:ação, sem segmento vazio nem a mais (barra no fim, '//').
    const rest = path.slice('/api/pty'.length);
    const parts = rest ? rest.slice(1).split('/') : [];
    if ((rest && rest[0] !== '/') || parts.some((p) => !p) || parts.length === 1 || parts.length > 2) {
      throw new HttpError(404, tr('rota desconhecida'));
    }
    const [rawId, act] = parts;
    if (!rawId) {
      if (method === 'GET') return sendJson(res, 200, { status: ptys.status(), ptys: ptys.list() });
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const info = ptys.create({ cwd: body?.cwd, account: body?.account, cols: body?.cols, rows: body?.rows });
      claim(info.id);
      return sendJson(res, 201, info);
    }
    const id = decode(rawId);
    if (act === 'stream') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      ptys.attach(id, req, res);
      return claim(id);
    }
    if (method !== 'POST') return notAllowed(res, 'POST');
    const body = (await readJson(req)) as Record<string, unknown>;
    if (act === 'input') ptys.input(id, body?.data);
    else if (act === 'resize') ptys.resize(id, body?.cols, body?.rows);
    else if (act === 'close') ptys.close(id);
    else throw new HttpError(404, tr('rota desconhecida'));
    noContent(res);
  };

  return (req, res, path) => {
    handle(req, res, path).catch((err) => fail(res, err));
  };
}
