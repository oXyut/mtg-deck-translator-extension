import { lookupJapaneseImages, type CardRef } from './scryfall';

export interface SiteAdapter {
  /** 現在のURLがPlaytest画面か(SPA遷移があるため毎回チェックする) */
  isPlaytestPage(): boolean;
  /** imgからカード識別子を得る。対象外のimgなら null */
  identify(img: HTMLImageElement): CardRef | Promise<CardRef | null> | null;
  /** 両面カードの裏面画像を表示中か */
  isBackFace(img: HTMLImageElement): boolean;
  /** ホバー拡大用の高解像度画像URL。拡大対象外のimgなら null */
  zoomSrc?(img: HTMLImageElement): string | null;
}

const SCRYFALL_IMAGE_HOST = 'cards.scryfall.io';
const ORIGINAL_SRC = 'jpOriginalSrc';
const ORIGINAL_SRCSET = 'jpOriginalSrcset';

export function startSwapper(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
): { rescan: () => void; restoreAll: () => void } {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLImageElement) {
            void processImg(node);
          } else if (node instanceof Element) {
            node.querySelectorAll('img').forEach((img) => void processImg(img));
          }
        }
      } else if (
        m.type === 'attributes' &&
        m.target instanceof HTMLImageElement
      ) {
        void processImg(m.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  const rescan = () => {
    document.querySelectorAll('img').forEach((img) => void processImg(img));
  };
  rescan();

  async function processImg(img: HTMLImageElement): Promise<void> {
    if (!isEnabled() || !adapter.isPlaytestPage()) return;

    const src = img.getAttribute('src') ?? '';
    // 差し替え済み(または元々Scryfall画像)なら何もしない。これが無限ループ防止も兼ねる
    if (!src || src.includes(SCRYFALL_IMAGE_HOST)) return;

    const ref = await adapter.identify(img);
    if (!ref) return;

    const jp = await lookupJapaneseImages(ref);
    if (!jp) return;

    const target = adapter.isBackFace(img) ? jp.back : jp.front;
    // 裏面の日本語画像が取れないケースは英語のままにする
    if (!target) return;

    // 待っている間にsrcが変わっていたら、その変更分のmutationで再処理される
    if (img.getAttribute('src') !== src) return;

    img.dataset[ORIGINAL_SRC] = src;
    if (img.srcset) {
      img.dataset[ORIGINAL_SRCSET] = img.srcset;
      img.srcset = '';
    }
    img.src = target;
  }

  const restoreAll = () => {
    document
      .querySelectorAll<HTMLImageElement>(`img[data-jp-original-src]`)
      .forEach((img) => {
        const original = img.dataset[ORIGINAL_SRC];
        if (original) img.src = original;
        const originalSrcset = img.dataset[ORIGINAL_SRCSET];
        if (originalSrcset) img.srcset = originalSrcset;
        delete img.dataset[ORIGINAL_SRC];
        delete img.dataset[ORIGINAL_SRCSET];
      });
  };

  return { rescan, restoreAll };
}
