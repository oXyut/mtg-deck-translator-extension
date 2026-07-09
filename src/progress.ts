/**
 * 日本語版検索の進捗(カード単位)。scryfall.ts が報告し、UIが購読する。
 * 全件完了すると自動でリセットされ、次のバッチは0から数え直す。
 */
export type ProgressListener = (done: number, total: number) => void;

let listener: ProgressListener | null = null;
let done = 0;
let total = 0;

export function setProgressListener(l: ProgressListener): void {
  listener = l;
}

export function lookupQueued(): void {
  total++;
  listener?.(done, total);
}

export function lookupSettled(): void {
  done++;
  listener?.(done, total);
  if (done >= total) {
    done = 0;
    total = 0;
  }
}
