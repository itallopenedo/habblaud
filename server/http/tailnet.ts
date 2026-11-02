// Terceira porta (Fase 5, C2): o terminal interativo pelo iPhone, só pela tailnet.
//
// Escuta HTTP puro e SÓ em 127.0.0.1 (HABBLAUD_TAILNET_PORT, padrão 4749): ninguém da rede local alcança. Quem publica
// é o `tailscale serve --bg --https=8443 http://127.0.0.1:4749`, com o TLS e o nome .ts.net, e que põe em cada pedido
// de um usuário da tailnet o cabeçalho Tailscale-User-Login (o que vier do cliente ele descarta). Toda requisição aqui
// precisa desse cabeçalho igual a HABBLAUD_TAILNET_USER; depois passa pelo mesmo login da porta do celular
// (http/remote.ts) e vira "remota" (o que é só do computador continua recusado). Só aqui o terminal interativo vale,
// com `pty` em HABBLAUD_REMOTE_ALLOW e, para abrir/assumir/encerrar, a senha conferida há menos de 10 min.
// Um processo do próprio Mac consegue imitar o cabeçalho, mas ainda precisa da senha, e esse processo já teria a 4747.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { createRemoteGate, LoginThrottle, safeEqual, type RemoteConfig, type RemoteSessions } from './remote';

export const DEFAULT_TAILNET_PORT = 4749;
export const TAILNET_HOST = '127.0.0.1';

export interface TailnetConfig {
  port: number;
  /** Login do Tailscale liberado (minúsculas). */
  user: string;
}

export function parseTailnetConfig(env: NodeJS.ProcessEnv, inDocker: boolean, remoteOn: boolean): { config?: TailnetConfig; warning?: string } {
  const user = env.HABBLAUD_TAILNET_USER?.trim().toLowerCase() ?? '';
  if (!user) return {};
  if (inDocker) return { warning: tr('porta da tailnet desligada: indisponível no Docker (rode com npm start)') };
  if (!remoteOn) return { warning: tr('porta da tailnet desligada: precisa do acesso remoto com login (npm run remote:setup)') };
  const raw = Number.parseInt(env.HABBLAUD_TAILNET_PORT ?? '', 10);
  return { config: { port: Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_TAILNET_PORT, user } };
}

/** Requisições que chegaram pela porta da tailnet com o usuário do Tailscale conferido. */
const tailnetRequests = new WeakSet<IncomingMessage>();

export function isTailnetRequest(req: IncomingMessage): boolean {
  return tailnetRequests.has(req);
}

/** Antes do login: confere o usuário que o tailscale serve pôs no pedido. Devolve true quando já respondeu (403). */
export function createTailnetGate(cfg: Pick<TailnetConfig, 'user'>): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const raw = req.headers['tailscale-user-login'];
    const login = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    // Pelo Funnel (a internet pública), nunca: só a tailnet do dono.
    const funnel = req.headers['tailscale-funnel-request'] !== undefined;
    if (login && !funnel && safeEqual(login, cfg.user)) {
      tailnetRequests.add(req);
      return false;
    }
    req.resume();
    const body = `${tr('Só pela tailnet, com o usuário liberado em HABBLAUD_TAILNET_USER.')}\n`;
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  };
}

/**
 * O login da porta da tailnet: as mesmas sessões da 4748, mas com freio próprio (senhas erradas de qualquer aparelho da
 * rede local não travam a senha de novo pelo celular aqui) e sem o download da CA (o certificado do .ts.net é público).
 */
export function createTailnetRemoteGate(
  remote: Pick<RemoteConfig, 'user' | 'passwordHash'>,
  sessions: RemoteSessions,
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  return createRemoteGate({ config: remote, sessions, secure: true, caFile: undefined, throttle: new LoginThrottle() });
}

export function startTailnetListener(
  port: number,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  log: { error(m: string): void },
): http.Server {
  const server = http.createServer(onRequest);
  server.on('error', (err) => log.error(tr('Porta da tailnet: não deu para escutar em {0}:{1} ({2}).', [TAILNET_HOST, port, (err as Error).message])));
  server.listen(port, TAILNET_HOST);
  return server;
}

const PTY_KEYS_ROUTE = /^\/api\/pty\/([^/]+)\/(input|resize|close)$/;

/**
 * O que uma sessão remota precisa para uma rota do terminal interativo, falhando fechado: `null` só para a lista
 * (GET /api/pty); `{ owner }` para teclas, tamanho e fechar (o terminal tem de ser um que esta sessão abriu, assumiu ou
 * ligou com a senha recente); `'confirm'` (a senha conferida há pouco) para todo o resto, inclusive qualquer variante do
 * caminho (barra no fim, segmento vazio ou a mais).
 */
export function ptyRemoteNeeds(method: string, path: string): null | 'confirm' | { owner: string } {
  if (method === 'GET' && path === '/api/pty') return null;
  const keys = method === 'POST' ? PTY_KEYS_ROUTE.exec(path) : null;
  if (!keys) return 'confirm';
  try {
    return { owner: decodeURIComponent(keys[1]) };
  } catch {
    return 'confirm';
  }
}
