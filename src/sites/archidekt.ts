import type { CardRef } from '../scryfall';
import type { SiteAdapter } from '../swapper';

/** Playtest画面のURL: /playtester-v2/{deckId} (旧 /playtester/ も許容) */
const PLAYTESTER_PATH = /^\/playtester(-v2)?\//;

/**
 * カード画像URL(実測 2026-07):
 * https://card-images.archidekt.com/normal/front/7/9/{scryfallId}.jpg?...
 * Scryfall (cards.scryfall.io) と同じパス構造のプロキシで、UUIDは印刷のScryfall ID。
 */
const CARD_IMAGE_SRC =
  /card-images\.archidekt\.com\/[^/]+\/(?:front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** 旧形式: https://storage.googleapis.com/archidekt-card-images/{set}/{uid}_normal.jpg */
const LEGACY_IMAGE_SRC =
  /archidekt-card-images\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** altの形式: "Mowu, Loyal Companion (j25) 79" */
const ALT_NAME = /^(.+?) \([a-z0-9]+\) \S+$/;

export function createArchidektAdapter(): SiteAdapter {
  return {
    isPlaytestPage: () => PLAYTESTER_PATH.test(location.pathname),

    identify(img: HTMLImageElement): CardRef | null {
      const src = img.getAttribute('src') ?? '';
      // アートのみの切り抜きと、裏向きカードのスリーブ画像は対象外。
      // 特にスリーブ画像をalt由来で差し替えると非公開のカードが公開されてしまう
      if (src.includes('art_crop') || src.includes('card_back')) return null;

      const id = CARD_IMAGE_SRC.exec(src)?.[1] ?? LEGACY_IMAGE_SRC.exec(src)?.[1];
      if (id) return { kind: 'scryfallId', id };

      // フォールバック: 画像URL形式が変わってもalt("名前 (set) 番号")から引ける
      if (img.className.includes('basicCard_image')) {
        const alt = ALT_NAME.exec(img.getAttribute('alt') ?? '');
        if (alt) return { kind: 'name', name: alt[1] };
      }
      return null;
    },

    isBackFace: (img) => {
      const src = img.getAttribute('src') ?? '';
      return src.includes('/back/') || src.includes('_back');
    },

    zoomSrc(img: HTMLImageElement): string | null {
      const src = img.getAttribute('src') ?? '';
      // 裏向きカードのスリーブや切り抜きは拡大しない(非公開情報を出さない)
      if (src.includes('art_crop') || src.includes('card_back')) return null;
      // 差し替え済み(cards.scryfall.io)・未差し替え(card-images.archidekt.com)とも
      // Scryfallと同じパス構造なので /normal/ → /large/ で高解像度になる
      if (
        CARD_IMAGE_SRC.test(src) ||
        (src.includes('cards.scryfall.io') && img.className.includes('basicCard_image'))
      ) {
        return src.replace('/normal/', '/large/');
      }
      if (LEGACY_IMAGE_SRC.test(src)) return src;
      return null;
    },
  };
}
