import type { AgentToolCall } from './types';

export const DECK_AGENT_TOOLS = [
  {
    name: 'get_scryfall_card',
    description:
      'Scryfallで1枚のカードを名前から取得する。カードの能力、色、統率者戦での適法性を確認するときに使う。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '英語のカード名' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_scryfall_cards',
    description:
      'Scryfall構文で候補カードを検索する。統率者の固有色、EDH適法性、役割、予算などの条件で候補を絞るときに使う。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Scryfall検索構文' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;

const REQUEST_INTERVAL_MS = 100;
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
let queueTail: Promise<unknown> = Promise.resolve();
const toolCache = new Map<string, { text: string; at: number }>();

/** Scryfallのレート制限を守るため、AI経由の問い合わせも既存機能と同様に直列化する。 */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(fn);
  queueTail = result
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS)));
  return result;
}

async function getScryfallJson(url: string): Promise<unknown> {
  const cached = toolCache.get(url);
  if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
    return JSON.parse(cached.text) as unknown;
  }
  return enqueue(async () => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    const json: unknown = await res.json();
    toolCache.set(url, { text: JSON.stringify(json), at: Date.now() });
    return json;
  });
}

interface ScryfallCard {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  color_identity?: string[];
  legalities?: Record<string, string>;
  prices?: { usd?: string | null; eur?: string | null };
  scryfall_uri?: string;
}

function summarize(card: ScryfallCard): Record<string, unknown> {
  return {
    name: card.name,
    manaCost: card.mana_cost,
    type: card.type_line,
    oracleText: card.oracle_text,
    colorIdentity: card.color_identity,
    commanderLegality: card.legalities?.commander,
    usd: card.prices?.usd,
    scryfallUrl: card.scryfall_uri,
  };
}

function parseArgs(call: AgentToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments);
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** モデルに公開するのは読み取り専用のScryfallツールだけ。 */
export async function executeDeckAgentTool(call: AgentToolCall): Promise<string> {
  const args = parseArgs(call);
  try {
    if (call.name === 'get_scryfall_card' && typeof args.name === 'string') {
      const card = (await getScryfallJson(
        `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(args.name)}`,
      )) as ScryfallCard;
      return JSON.stringify(summarize(card));
    }
    if (call.name === 'search_scryfall_cards' && typeof args.query === 'string') {
      const body = (await getScryfallJson(
        `https://api.scryfall.com/cards/search?order=edhrec&q=${encodeURIComponent(args.query)}`,
      )) as { data?: ScryfallCard[]; total_cards?: number };
      return JSON.stringify({
        totalCards: body.total_cards ?? 0,
        cards: (body.data ?? []).slice(0, 12).map(summarize),
      });
    }
    return JSON.stringify({ error: '許可されていないツールです' });
  } catch (error) {
    return JSON.stringify({
      error:
        error instanceof Error ? error.message : 'Scryfallへの接続に失敗しました',
    });
  }
}
