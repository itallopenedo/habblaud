// Token do plugin habblaud-observer (Fase 6): só a sha256 dele fica no .env (HABBLAUD_HERMES_TOKEN_HASH=sha256:<64 hex>).
// O token é aleatório de 32 bytes, então uma hash lenta (scrypt) não protege mais nada e custaria CPU a cada evento.
import { createHash, timingSafeEqual } from 'node:crypto';

/** `sha256:<64 hex>` → os 32 bytes da hash; qualquer outra coisa → undefined. */
export function parseHermesTokenHash(raw: string | undefined): Buffer | undefined {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(raw?.trim() ?? '');
  return m ? Buffer.from(m[1], 'hex') : undefined;
}

/** `Authorization: Bearer <token>` com a sha256 igual a `hash` (comparação em tempo constante). */
export function bearerMatches(header: string | undefined, hash: Buffer): boolean {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '');
  return !!m && hash.length === 32 && timingSafeEqual(createHash('sha256').update(m[1]).digest(), hash);
}
