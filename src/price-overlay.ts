import { browser } from 'wxt/browser';
import { frontFaceName, type JpPrice } from './prices';
import { lookupJapaneseImages } from './scryfall';
import type { DeckEntry, SiteAdapter } from './swapper';

/**
 * デッキ合計金額の円建てバッジ(クリックで内訳パネル)を表示する。
 * 価格の取得自体はbackground service worker(entrypoints/background.ts)が行う。
 * ※ページ上のドル価格を個別に円へ置き換える機能は、Moxfieldのプレビュー価格が
 *   カード画像と共通コンテナを持たずカードの特定が安定しなかったため撤去した
 *   (v0.11.0)。経緯は git log を参照。
 */

type RequestPrice = (name: string) => Promise<JpPrice>;

/** localStorage.mtgJpDebug = '1' で価格処理のデバッグログを出す */
function debug(...args: unknown[]): void {
  try {
    if (localStorage.getItem('mtgJpDebug') === '1') {
      console.log('[MTGデッキ日本語化]', ...args);
    }
  } catch {
    /* localStorage不可の環境では黙る */
  }
}

function fmt(yen: number): string {
  return '¥' + yen.toLocaleString('ja-JP');
}

/** 設定値から店舗モードの表示名 */
function storeLabel(store: string): string {
  if (store === 'hareruya') return '晴れる屋';
  if (store === 'lowest') return '店舗問わず最安';
  if (store.startsWith('wg:')) return store.slice(3);
  return store;
}

/** 価格源のページURL(晴れる屋の商品検索 / Wisdom Guildのカードページ) */
function sourceUrl(name: string, linkHareruya: boolean): string {
  const front = encodeURIComponent(frontFaceName(name));
  return linkHareruya
    ? `https://www.hareruyamtg.com/ja/products/search?product=${front}`
    : `https://wonder.wisdom-guild.net/price/${front}/`;
}

export function startPriceOverlay(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
  getStore: () => string,
  bottomPx: number,
): void {
  const requestPrice: RequestPrice = (name) =>
    browser.runtime.sendMessage({
      type: 'jp-price',
      name,
      store: getStore(),
    }) as Promise<JpPrice>;

  startTotalBadge(adapter, isEnabled, requestPrice, getStore, bottomPx);
}

/** 内訳パネル1行分 */
interface PricedRow {
  name: string;
  jaName?: string;
  quantity: number;
  /** 1枚あたりの円。取得できなかったカードは null */
  unit: number | null;
  approximate: boolean;
  linkHareruya: boolean;
}

/** デッキ合計金額のバッジ(画面左下)。クリックで内訳パネルを開く */
function startTotalBadge(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
  requestPrice: RequestPrice,
  getStore: () => string,
  bottomPx: number,
): void {
  if (!adapter.getDeckList) return;
  const getDeckList = adapter.getDeckList.bind(adapter);

  let badge: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let computedForPath: string | null = null;
  let rows: PricedRow[] = [];

  function ensureBadge(): HTMLDivElement {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.style.cssText = [
      'position: fixed',
      'left: 16px',
      `bottom: ${bottomPx}px`,
      'z-index: 2147483647',
      'background: rgba(20, 20, 24, 0.88)',
      'color: #fff',
      'font: 12px/1.4 system-ui, sans-serif',
      'padding: 6px 12px',
      'border-radius: 8px',
      'box-shadow: 0 2px 10px rgba(0,0,0,0.35)',
      'cursor: pointer',
      'user-select: none',
    ].join(';');
    badge.addEventListener('click', togglePanel);
    document.documentElement.appendChild(badge);
    return badge;
  }

  function render(text: string, title: string): void {
    const el = ensureBadge();
    el.textContent = text;
    el.title = title + '\nクリックで内訳を表示';
    el.style.display = 'block';
  }

  function hide(): void {
    if (badge) badge.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }

  function togglePanel(): void {
    if (panel && panel.style.display !== 'none') {
      panel.style.display = 'none';
      return;
    }
    renderPanel();
  }

  function renderPanel(): void {
    if (!panel) {
      panel = document.createElement('div');
      // バッジ(bottomPx) → 進捗バッジ(+36px) → 内訳パネル(+76px) の順に積む
      panel.style.cssText = [
        'position: fixed',
        'left: 16px',
        `bottom: ${bottomPx + 76}px`,
        'z-index: 2147483647',
        'width: 360px',
        'max-height: 60vh',
        'overflow-y: auto',
        'background: rgba(20, 20, 24, 0.95)',
        'color: #fff',
        'font: 12px/1.6 system-ui, sans-serif',
        'padding: 10px 14px',
        'border-radius: 8px',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.45)',
      ].join(';');
      document.documentElement.appendChild(panel);
    }
    panel.replaceChildren();

    const header = document.createElement('div');
    header.textContent = '価格内訳(クリックで店舗ページへ)';
    header.style.cssText =
      'font-weight: 600; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 4px;';
    panel.appendChild(header);

    const sorted = [...rows].sort(
      (a, b) => (b.unit ?? -1) * b.quantity - (a.unit ?? -1) * a.quantity,
    );
    for (const row of sorted) {
      const line = document.createElement('div');
      line.style.cssText =
        'display: flex; justify-content: space-between; gap: 8px;';
      const link = document.createElement('a');
      const label = row.jaName ?? row.name;
      link.textContent = `${label}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`;
      link.title = row.name;
      link.href = sourceUrl(row.name, row.linkHareruya);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.cssText =
        'color: #7ec8ff; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
      const value = document.createElement('span');
      value.style.cssText = 'flex-shrink: 0; text-align: right;';
      value.textContent =
        row.unit !== null
          ? fmt(row.unit * row.quantity) + (row.approximate ? '*' : '')
          : '—';
      line.append(link, value);
      panel.appendChild(line);
    }

    const note = document.createElement('div');
    note.textContent =
      '* はWisdom Guild平均による近似。— は価格を取得できなかったカード。';
    note.style.cssText =
      'margin-top: 6px; color: rgba(255,255,255,0.6); font-size: 11px;';
    panel.appendChild(note);
    panel.style.display = 'block';
  }

  async function compute(): Promise<void> {
    const path = location.pathname;
    if (computedForPath === path) return;
    computedForPath = path;

    const list = await getDeckList();
    if (!list || list.length === 0) return;

    // 集計に使った店舗モード(集計中に設定が変わっても表示と中身がずれないよう固定)
    const usedStore = storeLabel(getStore());
    debug('デッキ合計の集計開始:', usedStore, list.length, '種');
    rows = [];
    const totalCards = list.reduce((s, e) => s + e.quantity, 0);
    let sum = 0;
    let pricedCards = 0;
    let usedFallback = false;
    let settled = 0;

    await Promise.all(
      list.map(async (entry: DeckEntry) => {
        const { name, quantity } = entry;
        let row: PricedRow = {
          name,
          quantity,
          unit: null,
          approximate: false,
          linkHareruya: false,
        };
        try {
          // 日本語名(画像差し替えで温まったキャッシュから引けることが多い)
          const jaName = entry.scryfallId
            ? (await lookupJapaneseImages({ kind: 'scryfallId', id: entry.scryfallId }))
                ?.jaName
            : undefined;
          const price = await requestPrice(name);
          if (price.value !== null) {
            row = {
              name,
              jaName,
              quantity,
              unit: price.value,
              approximate: price.approximate,
              linkHareruya: price.linkHareruya,
            };
            sum += price.value * quantity;
            pricedCards += quantity;
            if (price.approximate) usedFallback = true;
          } else {
            row.jaName = jaName;
          }
        } catch {
          // 取得失敗は合計から除外するだけ
        } finally {
          rows.push(row);
          settled++;
          if (!isEnabled() || location.pathname !== path) return;
          const suffix = settled < list.length ? ' 取得中…' : '';
          render(
            `デッキ合計(${usedStore}) ${fmt(sum)}${usedFallback ? '*' : ''} (${pricedCards}/${totalCards}枚)${suffix}`,
            `${usedStore}モードでの合計。* はWisdom Guild平均で近似したカードを含む。` +
              '価格が取得できなかったカードは合計に含まれません。',
          );
          if (panel && panel.style.display !== 'none') renderPanel();
        }
      }),
    );
  }

  // SPAなのでページ遷移でデッキが変わったら再計算(computedForPathで抑制)
  setInterval(() => {
    if (!isEnabled()) {
      hide();
      return;
    }
    if (badge && computedForPath === location.pathname) {
      badge.style.display = 'block'; // OFF→ONの復帰
    }
    void compute();
  }, 1500);
}
