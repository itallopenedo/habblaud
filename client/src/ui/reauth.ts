// Senha de novo antes de abrir, assumir ou encerrar um terminal interativo pelo celular (Fase 5, C2). O servidor
// responde 401 {code: 'reauth'} quando a última conferência da senha passou de 10 min (server/http/app.ts); aqui a
// pessoa digita a senha num <dialog> e o pedido é refeito uma vez. O EventSource da tela não lê o 401: quem liga a
// tela pergunta antes (confirmedRecently). A senha só vai no corpo do POST: não é guardada nem registrada.
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';

export class ReauthError extends Error {}

export function isReauth(status: number, body: unknown): boolean {
  return status === 401 && !!body && (body as { code?: unknown }).code === 'reauth';
}

/** POST /api/remote/confirm: '' quando a senha foi aceita; senão, o motivo. */
export async function confirmPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl('/api/remote/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ password }),
    });
    if (res.ok) return '';
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? tr('erro {0}', [res.status]);
  } catch {
    return tr('o Habblaud não respondeu');
  }
}

/** GET /api/remote/confirm: a senha foi conferida há menos de 10 min? Sem resposta: false (pergunta de novo). */
export async function confirmedRecently(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/remote/confirm', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok && ((await res.json()) as { fresh?: unknown }).fresh === true;
  } catch {
    return false;
  }
}

/** Roda `fn`; se o servidor pedir a senha, pergunta (`ask`) e tenta mais uma vez. Cancelou: undefined. */
export async function withReauth<T>(fn: () => Promise<T>, ask: () => Promise<boolean> = askPassword): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ReauthError)) throw err;
    if (!(await ask())) return undefined;
    return fn();
  }
}

let asking: Promise<boolean> | null = null;

/** Diálogo da senha: true quando o servidor aceitou, false se a pessoa cancelou. Um por vez. */
export function askPassword(): Promise<boolean> {
  asking ??= new Promise<boolean>((done) => {
    const input = h('input', { class: 'ui-reauth__input', attrs: { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': tr('Senha') } });
    const err = h('p', { class: 'ui-reauth__err', role: 'alert', hidden: true });
    const ok = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: tr('Confirmar') });
    const cancel = h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar') });
    const form = h(
      'form',
      { class: 'ui-reauth' },
      h('h2', { class: 'ui-reauth__title', text: tr('Confirme a senha') }),
      h('p', { class: 'ui-muted ui-small', text: tr('Para abrir o terminal pelo celular, digite de novo a senha do acesso remoto. Vale por 10 min.') }),
      input,
      err,
      h('div', { class: 'ui-reauth__actions' }, cancel, ok),
    );
    const dialog = h('dialog', { class: 'ui-reauth-dialog' }, form);
    const finish = (accepted: boolean) => {
      dialog.close();
      dialog.remove();
      asking = null;
      done(accepted);
    };
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    // As teclas do diálogo não vão para os atalhos do escritório.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ok.disabled = true;
      void confirmPassword(input.value).then((problem) => {
        ok.disabled = false;
        if (!problem) return finish(true);
        setText(err, problem);
        setHidden(err, false);
        input.select();
      });
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
  return asking;
}
