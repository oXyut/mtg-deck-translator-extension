import type { CardRef } from '../scryfall';
import type { DeckContextData } from '../deck-context';
import type { DeckEntry, SiteAdapter } from '../swapper';

/**
 * 対象画面のURL: /decks/{publicId}(デッキビュー)とその配下
 * (/goldfish = Playtest、/primer 等を含む)
 */
const DECK_PATH = /^\/decks\/([^/]+)/;
/**
 * カード画像URL(実測):
 * - 通常カード:   https://assets.moxfield.net/cards/card-{moxfieldId}-normal.webp
 * - 両面カード等: https://assets.moxfield.net/cards/card-face-{moxfieldId}-normal.webp
 */
const CARD_IMAGE_SRC = /moxfield\.[a-z]+\/cards\/card-(?:(?:face|back)-)*([A-Za-z0-9]+)-/;
/**
 * Moxfield自身がScryfall画像を直接使う箇所(両面カードのプレビュー等)。
 * URLに印刷のScryfall IDが入っているのでそのまま使える。
 */
const SCRYFALL_IMAGE_SRC =
  /cards\.scryfall\.io\/[a-z_]+\/(?:front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/** カード名ではないaltの値(プレースホルダやフリップウィジェットのボタン) */
const NON_CARD_ALTS = new Set(['Card Image', 'Front', 'Back', 'Transform']);

/** MoxfieldカードID(または面ID)1つ分の情報 */
interface CardEntry {
  scryfallId: string;
  /** カードの英語名(両面カードはフルネーム "A // B") */
  name: string;
  /** 両面カードの裏面のIDか */
  back: boolean;
}

/**
 * MoxfieldのPlaytest画像は alt="Card Image" でカード名を持たないため、
 * デッキの公開APIからMoxfieldカードID→Scryfall IDの対応表を作って識別する。
 */
export function createMoxfieldAdapter(): SiteAdapter {
  /** moxfieldのカードID・面ID → Scryfall ID と表裏 */
  let cardMap = new Map<string, CardEntry>();
  /** メインデッキ+統率者の一覧(デッキ合計金額用) */
  let deckList: DeckEntry[] = [];
  let deckContext: DeckContextData | null = null;
  let loadedDeckId: string | null = null;
  let loading: Promise<void> | null = null;

  function currentDeckId(): string | null {
    return DECK_PATH.exec(location.pathname)?.[1] ?? null;
  }

  async function ensureDeckData(): Promise<void> {
    const deckId = currentDeckId();
    if (!deckId || deckId === loadedDeckId) return;
    if (loading) return loading;

    loading = (async () => {
      try {
        // ページ自身も呼んでいる公開API。非公開デッキでは失敗するがその場合は諦める
        const res = await fetch(
          `https://api2.moxfield.com/v3/decks/all/${deckId}`,
        );
        if (!res.ok) throw new Error(`Moxfield API ${res.status}`);
        const json: unknown = await res.json();
        cardMap = collectCards(json);
        deckContext = collectDeckContext(json);
        deckList = deckContext.entries;
        loadedDeckId = deckId;
      } catch (e) {
        console.info('[MTG デッキ日本語化] デッキ情報の取得に失敗:', e);
        deckContext = null;
        loadedDeckId = deckId; // リトライの嵐を避けるため失敗も記録
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  return {
    isTargetPage: () => currentDeckId() !== null,

    async identify(img: HTMLImageElement): Promise<CardRef | null> {
      const src = img.getAttribute('src') ?? '';

      const scryfall = SCRYFALL_IMAGE_SRC.exec(src);
      if (scryfall) return { kind: 'scryfallId', id: scryfall[1] };

      const match = CARD_IMAGE_SRC.exec(src);
      if (!match) return null;
      await ensureDeckData();
      const entry = cardMap.get(match[1]);
      if (entry) return { kind: 'scryfallId', id: entry.scryfallId };
      // 対応表に無い場合(非公開デッキ等)はaltのカード名で引く。
      // フリップウィジェットのボタン等のaltは除外する
      const alt = img.getAttribute('alt')?.trim() ?? '';
      if (alt && !NON_CARD_ALTS.has(alt)) return { kind: 'name', name: alt };
      return null;
    },

    async getCardName(img: HTMLImageElement): Promise<string | null> {
      const src = img.getAttribute('src') ?? '';
      if (CARD_IMAGE_SRC.test(src) || SCRYFALL_IMAGE_SRC.test(src)) {
        await ensureDeckData();
        const id = CARD_IMAGE_SRC.exec(src)?.[1];
        const entry = id !== undefined ? cardMap.get(id) : undefined;
        if (entry) return entry.name;
        const alt = img.getAttribute('alt')?.trim() ?? '';
        if (alt && !NON_CARD_ALTS.has(alt)) return alt;
      }
      return null;
    },

    async getDeckList(): Promise<DeckEntry[] | null> {
      await ensureDeckData();
      return deckList.length > 0 ? deckList : null;
    },

    async getDeckContext(): Promise<DeckContextData | null> {
      await ensureDeckData();
      return deckContext;
    },

    isBackFace: (img) => {
      const src = img.getAttribute('src') ?? '';
      // 面IDが対応表にあればそれが正(card-face-{裏面ID} のURLには
      // "back" が含まれないため、URLだけでは判定できない)
      const id = CARD_IMAGE_SRC.exec(src)?.[1];
      const entry = id !== undefined ? cardMap.get(id) : undefined;
      if (entry) return entry.back;
      return (
        src.includes('-back') || src.includes('back-') || src.includes('/back/')
      );
    },
  };
}

/**
 * デッキJSONを再帰的に走査し、`id` と `scryfall_id` を両方持つ
 * カードオブジェクトを全て拾う。APIレスポンスの構造変化(v2/v3、
 * boards/tokensの配置)に依存しないための総当たり方式。
 * 両面カードは card_faces の各面が固有の `id` を持ち、面画像のURL
 * (card-face-{面ID}-...)に使われるため、面IDも親のScryfall IDに紐づける。
 */
function collectCards(
  node: unknown,
  map = new Map<string, CardEntry>(),
): Map<string, CardEntry> {
  if (Array.isArray(node)) {
    for (const item of node) collectCards(item, map);
  } else if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.id === 'string' && typeof obj.scryfall_id === 'string') {
      const scryfallId = obj.scryfall_id;
      const name = typeof obj.name === 'string' ? obj.name : '';
      map.set(obj.id, { scryfallId, name, back: false });
      if (Array.isArray(obj.card_faces)) {
        obj.card_faces.forEach((face, index) => {
          const faceId = (face as Record<string, unknown> | null)?.id;
          if (typeof faceId === 'string') {
            map.set(faceId, { scryfallId, name, back: index > 0 });
          }
        });
      }
    }
    for (const value of Object.values(obj)) {
      if (value !== null && typeof value === 'object') collectCards(value, map);
    }
  }
  return map;
}

/**
 * デッキ合計金額の対象になるボードだけから {英語名, 枚数} を集める。
 * サイドボード・検討中(maybeboard)は合計に含めない。
 */
function collectDeckContext(json: unknown): DeckContextData {
  const boards = (json as { boards?: Record<string, unknown> } | null)?.boards;
  const entries: DeckEntry[] = [];
  const candidates: NonNullable<DeckContextData['candidates']> = [];
  if (boards === null || typeof boards !== 'object') return { entries };

  const boardEntries = (boardName: string): DeckEntry[] => {
    const out: DeckEntry[] = [];
    const cards = (boards[boardName] as { cards?: Record<string, unknown> } | undefined)
      ?.cards;
    if (cards === null || typeof cards !== 'object') return out;
    for (const entry of Object.values(cards)) {
      const e = entry as {
        quantity?: unknown;
        card?: { name?: unknown; scryfall_id?: unknown } | null;
      } | null;
      const name = e?.card?.name;
      const quantity = e?.quantity;
      const scryfallId = e?.card?.scryfall_id;
      if (typeof name === 'string' && typeof quantity === 'number' && quantity > 0) {
        out.push({
          name,
          quantity,
          isCommander: boardName === 'commanders',
          scryfallId: typeof scryfallId === 'string' ? scryfallId : undefined,
        });
      }
    }
    return out;
  };

  let mainboard = boardEntries('mainboard');
  const sideboard = boardEntries('sideboard');
  // 一部のMoxfieldレスポンスではmainboardがサイド込みの総数になり、sideboardにも
  // 同じカードが重複して入る。全サイドカードがmainboard内に存在する場合だけ差し引く。
  // 通常の「mainboardとsideboardが別」レスポンスには適用しない。
  const mainboardCount = mainboard.reduce((total, entry) => total + entry.quantity, 0);
  const sideboardCount = sideboard.reduce((total, entry) => total + entry.quantity, 0);
  if (
    // 75/15は通常の構築フォーマットのmain+side合算と判別できる場合だけ補正する。
    // 同じカードをメインとサイド双方で採用する通常のレスポンスを誤って差し引かない。
    mainboardCount === 75 &&
    sideboardCount === 15 &&
    sideboard.every((side) => {
      const main = mainboard.find(
        (entry) => entry.scryfallId === side.scryfallId || entry.name === side.name,
      );
      return main !== undefined && main.quantity >= side.quantity;
    })
  ) {
    mainboard = mainboard
      .map((entry) => {
        const side = sideboard.find(
          (candidate) =>
            candidate.scryfallId === entry.scryfallId || candidate.name === entry.name,
        );
        return side ? { ...entry, quantity: entry.quantity - side.quantity } : entry;
      })
      .filter((entry) => entry.quantity > 0);
  }
  entries.push(...mainboard, ...boardEntries('commanders'), ...boardEntries('companions'));
  for (const boardName of Object.keys(boards)) {
    if (['mainboard', 'commanders', 'companions'].includes(boardName)) continue;
    if (!/side|maybe|consider/i.test(boardName)) continue;
    const cards = boardEntries(boardName);
    if (cards.length > 0) candidates.push({ label: boardName, entries: cards });
  }
  const root = json as Record<string, unknown>;
  const string = (key: string): string | undefined =>
    typeof root[key] === 'string' ? (root[key] as string) : undefined;
  const scalar = (key: string): string | undefined => {
    const value = root[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  return {
    entries,
    candidates,
    metadata: {
      name: string('name'),
      description: string('description'),
      format: scalar('format') ?? string('formatName'),
      bracket: scalar('bracket'),
    },
  };
}
