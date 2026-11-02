// Seção "Arquivos" da gaveta do agente (Fase 4, D4): os arquivos de ver que o agente escreveu ou editou na sessão
// (GET /api/agents/:id/files), do mais recente para o mais antigo. Carrega só quando você toca em "Ver arquivos"; um
// toque num arquivo o abre numa aba nova (GET /api/agents/:id/files/:fileId: imagem, PDF, vídeo, página em sandbox,
// texto). Mesma trava do terminal.
import { tr } from '../../../shared/i18n';
import type { AgentFileInfo, AgentInfo } from '../../../shared/types';
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { relativeTime } from './format';

export function agentFilesUrl(agentId: string, fileId?: string): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/files`;
  return fileId === undefined ? base : `${base}/${encodeURIComponent(fileId)}`;
}

/** Itens válidos da resposta (o resto é ignorado). */
export function parseAgentFiles(body: unknown): AgentFileInfo[] {
  const list = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f): f is AgentFileInfo => !!f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.path === 'string' && typeof f.kind === 'string' && typeof f.at === 'number',
  );
}

export class AgentFilesSection {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly loadBtn: HTMLButtonElement;
  private agentId = '';
  /** Pedido em andamento: trocar de agente invalida a resposta que ainda vai chegar. */
  private req = 0;

  constructor(private readonly ctx: UiContext) {
    this.list = h('ul', { class: 'ui-files' });
    this.note = h('p', { class: 'ui-muted ui-small', hidden: true });
    this.loadBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Ver arquivos'), on: { click: () => void this.load() } });
    this.el = h(
      'section',
      { class: 'ui-sec' },
      h('div', { class: 'ui-sec__head' }, h('h3', { class: 'ui-sec__title', text: tr('Arquivos') }), this.loadBtn),
      this.list,
      this.note,
    );
  }

  /** Some sem a trava do terminal, no demo e no replay. Outro agente: a lista volta a ficar por carregar. */
  render(agent: AgentInfo | undefined): void {
    const store = this.ctx.store;
    setHidden(this.el, !agent || !access().terminal || !store.snapshot?.meta.terminal || store.mock || store.replaying);
    if (!agent || agent.id === this.agentId) return;
    this.agentId = agent.id;
    this.req++;
    this.list.replaceChildren();
    setHidden(this.note, true);
    setText(this.loadBtn, tr('Ver arquivos'));
  }

  private async load(): Promise<void> {
    const id = this.agentId;
    const req = ++this.req;
    setText(this.loadBtn, tr('Carregando…'));
    let files: AgentFileInfo[] = [];
    let error = '';
    try {
      const res = await fetch(agentFilesUrl(id), { credentials: 'same-origin', cache: 'no-store' });
      const body: unknown = await res.json().catch(() => ({}));
      if (res.ok) files = parseAgentFiles(body);
      else error = (body as { error?: string }).error ?? tr('erro {0}', [res.status]);
    } catch {
      error = tr('o Habblaud não respondeu');
    }
    if (req !== this.req) return;
    setText(this.loadBtn, tr('Atualizar'));
    const now = this.ctx.now();
    this.list.replaceChildren(
      ...files.map((f) =>
        h(
          'li',
          { class: 'ui-files__item' },
          h('a', { class: 'ui-files__link', text: f.name, attrs: { href: agentFilesUrl(id, f.id), target: '_blank', rel: 'noopener', title: f.path } }),
          h('span', { class: 'ui-files__meta', text: f.at ? `${f.path} · ${relativeTime(f.at, now)}` : f.path }),
        ),
      ),
    );
    const msg = error || (!files.length ? tr('Nenhum arquivo de ver (imagem, PDF, página, texto) escrito nesta sessão.') : '');
    setText(this.note, msg);
    setHidden(this.note, !msg);
  }
}
