import { getCached, setCached, type JpLookupResult } from './cache';
import { lookupQueued, lookupSettled } from './progress';

/**
 * imgが指すカードの識別子。
 * - scryfallId: 印刷(printing)のScryfall UUID。ここからoracle_id経由で日本語版を探す
 * - name: カードの英語名。完全一致で日本語版printingを探す
 */
export type CardRef =
  | { kind: 'scryfallId'; id: string }
  | { kind: 'name'; name: string };

const API = 'https://api.scryfall.com';
/** Scryfallのレート制限(50-100ms間隔の推奨)に合わせたリクエスト間隔 */
const REQUEST_INTERVAL_MS = 100;

interface ScryfallImageUris {
  normal: string;
}

interface ScryfallCardFace {
  name: string;
  printed_name?: string;
  printed_text?: string;
  image_uris?: ScryfallImageUris;
}

interface ScryfallCard {
  name: string;
  lang: string;
  oracle_id?: string;
  image_status: string;
  printed_name?: string;
  printed_text?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
}

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/**
 * lang:ja のprintingでも実際の印刷は変種によって差がある:
 * - 通常版: カード名もテキストも日本語
 * - 特殊枠(FF系ボーダーレス等): カード名は英語のままテキストのみ日本語
 * - まれにScryfall上lang:jaでも印刷データが英語のみのものがある
 */
function hasJapaneseText(card: ScryfallCard): boolean {
  const texts = [
    card.printed_name,
    card.printed_text,
    ...(card.card_faces ?? []).flatMap((f) => [f.printed_name, f.printed_text]),
  ];
  return texts.some((t) => t !== undefined && CJK.test(t));
}

/** カード名まで日本語で印刷されているか(通常の日本語版) */
function hasJapaneseName(card: ScryfallCard): boolean {
  const names = [
    card.printed_name,
    ...(card.card_faces ?? []).map((f) => f.printed_name),
  ];
  return names.some((t) => t !== undefined && CJK.test(t));
}

interface ScryfallList {
  data?: ScryfallCard[];
}

let queueTail: Promise<unknown> = Promise.resolve();

/** 全リクエストを1本の直列キューに載せ、REQUEST_INTERVAL_MSの間隔を保証する */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(fn);
  queueTail = result
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS)));
  return result;
}

/** 進行中の同一カードのリクエストをまとめる */
const inflight = new Map<string, Promise<JpLookupResult>>();

function cacheKey(ref: CardRef): string {
  return ref.kind === 'scryfallId'
    ? `sid:${ref.id}`
    : `name:${ref.name.toLowerCase()}`;
}

/**
 * カードの日本語版printingの画像URLを引く。
 * - 日本語版が存在しない場合は null(キャッシュされる)
 * - ネットワーク/レート制限エラー時は undefined(キャッシュせず次回再試行)
 */
export async function lookupJapaneseImages(
  ref: CardRef,
): Promise<JpLookupResult | undefined> {
  const key = cacheKey(ref);

  const cached = await getCached(key);
  if (cached !== undefined) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  lookupQueued();
  const promise = (async () => {
    const result =
      ref.kind === 'scryfallId'
        ? await lookupByScryfallId(ref.id)
        : await enqueue(() => searchJapanesePrinting(`!"${ref.name}"`, ref.name));
    return result;
  })();

  inflight.set(key, promise);
  try {
    const result = await promise;
    await setCached(key, result);
    return result;
  } catch {
    return undefined;
  } finally {
    inflight.delete(key);
    lookupSettled();
  }
}

async function lookupByScryfallId(id: string): Promise<JpLookupResult> {
  const card = await enqueue(async () => {
    const res = await fetch(`${API}/cards/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    return (await res.json()) as ScryfallCard;
  });
  if (!card) return null;

  // 元々日本語(の文字で印刷された)printingが選ばれているならそのまま使う
  if (card.lang === 'ja' && hasJapaneseText(card)) return extractImages(card);
  if (!card.oracle_id) return null;

  return enqueue(() => searchJapanesePrinting(`oracleid:${card.oracle_id}`));
}

/**
 * 日本語版printingを検索して画像URLを返す。
 * exactName指定時は、片面の名前だけが一致する別カード(分割カード等)を除外する。
 */
async function searchJapanesePrinting(
  baseQuery: string,
  exactName?: string,
): Promise<JpLookupResult> {
  const query = `${baseQuery} lang:ja game:paper`;
  const url =
    `${API}/cards/search?unique=prints&order=released&dir=desc&q=` +
    encodeURIComponent(query);
  const res = await fetch(url);

  // 404 = 日本語版printingなし
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall ${res.status}`);

  const list = (await res.json()) as ScryfallList;
  let candidates = list.data ?? [];
  if (exactName) {
    const lower = exactName.toLowerCase();
    candidates = candidates.filter((c) => {
      const full = c.name.toLowerCase();
      return full === lower || full.split(' // ')[0] === lower;
    });
  }
  // 実際に日本語で印刷されたものに限定し、
  // その中でもカード名まで日本語の通常版を最優先する
  candidates = candidates.filter(hasJapaneseText);
  if (candidates.length === 0) return null;
  const fullyJapanese = candidates.filter(hasJapaneseName);
  const pool = fullyJapanese.length > 0 ? fullyJapanese : candidates;

  const best = pool.find((c) => c.image_status === 'highres_scan') ?? pool[0];
  return extractImages(best);
}

function extractImages(card: ScryfallCard): JpLookupResult {
  if (card.image_uris) return { front: card.image_uris.normal };
  const faces = card.card_faces ?? [];
  const front = faces[0]?.image_uris?.normal;
  if (!front) return null;
  return { front, back: faces[1]?.image_uris?.normal };
}
