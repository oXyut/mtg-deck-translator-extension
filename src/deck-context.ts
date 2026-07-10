import type { DeckEntry } from './swapper';

/** デッキサイトから取得できる、フォーマットに依存しない補助情報。 */
export interface DeckMetadata {
  name?: string;
  format?: string;
  bracket?: string;
  description?: string;
}

/** 本体とは分けて保持するサイドボード・検討中カード。 */
export interface DeckCandidateSection {
  label: string;
  entries: DeckEntry[];
}

export interface DeckContextData {
  entries: DeckEntry[];
  metadata?: DeckMetadata;
  candidates?: DeckCandidateSection[];
}
