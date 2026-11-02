// Modo chat do terminal: as ferramentas, os resultados e o "pensando" entre duas mensagens viram um grupo recolhido
// ("Usou 5 ferramentas"), como no Claude Desktop. Puro (testado em chatruns.test.ts); o painel aplica no DOM.
import type { TerminalItem } from './terminal';
import { tr } from '../../../shared/i18n';

export interface ChatRun {
  /** Chave do primeiro item do grupo (estável enquanto o grupo cresce no fim). */
  key: string;
  keys: string[];
  /** Ferramentas no grupo (com ou sem resultado, mais resultados órfãos). */
  tools: number;
  /** Nome da última ferramenta ainda sem resultado, só no grupo que fecha a conversa. */
  running?: string;
}

/** Entra no grupo recolhido? Tudo que não é prompt, resposta ou aviso do sistema. */
export function inRun(item: TerminalItem): boolean {
  return item.type !== 'entry' || item.entry.kind === 'thinking';
}

/** Grupos seguidos de itens recolhíveis, na ordem da conversa. */
export function chatRuns(items: Iterable<TerminalItem>): ChatRun[] {
  const runs: ChatRun[] = [];
  let cur: ChatRun | null = null;
  let pending: string | undefined;
  for (const item of items) {
    if (!inRun(item)) {
      cur = null;
      continue;
    }
    if (!cur) {
      runs.push((cur = { key: item.key, keys: [], tools: 0 }));
      pending = undefined;
    }
    cur.keys.push(item.key);
    if (item.type !== 'entry') cur.tools++;
    if (item.type === 'tool') pending = item.result ? undefined : item.tool.title.split('(')[0] || item.tool.title;
  }
  // Uma ferramenta sem resultado no meio da conversa foi interrompida: só o grupo do fim pode estar rodando.
  if (cur && pending) cur.running = pending;
  return runs;
}

/** Rótulo do grupo: "Usando Bash…", "Usou 5 ferramentas" ou, só com raciocínio, "Pensou". */
export function runLabel(run: Pick<ChatRun, 'tools' | 'running'>): string {
  if (run.running) return tr('Usando {0}…', [run.running]);
  if (!run.tools) return tr('Pensou');
  return run.tools === 1 ? tr('Usou 1 ferramenta') : tr('Usou {0} ferramentas', [run.tools]);
}
