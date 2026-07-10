import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { lookupChatCard, type ChatCardDisplay } from './scryfall';
import type { AgentCitation } from './agent/types';

const CARD_TOKEN = /\{\{card:([^{}\n]+)\}\}/gi;
// annotationに対応しない内部citationマーカーだけを最後に除去する。
const OPENAI_CITATION = /cite[^]*/g;
// 異常な応答でScryfallを大量照会しない安全弁。通常のデッキ提案を十分に上回る数。
const MAX_CARDS_PER_MESSAGE = 120;

interface CardToken {
  placeholder: string;
  englishName: string;
}

export interface ChatCardPrice {
  value: number | null;
  approximate: boolean;
  sourceLabel: string | null;
  linkHareruya: boolean;
}

export type ResolveChatCardPrice = (name: string) => Promise<ChatCardPrice>;
export type GetChatCardPageUrl = (
  name: string,
  price?: ChatCardPrice,
) => string;

const preview = document.createElement('div');
preview.style.cssText = [
  'display:none',
  'position:fixed',
  'z-index:2147483647',
  'width:244px',
  'padding:5px',
  'border-radius:8px',
  'background:rgba(12,12,16,.96)',
  'box-shadow:0 5px 18px rgba(0,0,0,.55)',
  'pointer-events:none',
].join(';');
const previewImage = document.createElement('img');
previewImage.style.cssText = 'display:block;width:100%;border-radius:5px;';
const previewTitle = document.createElement('div');
previewTitle.style.cssText =
  'margin:4px 2px 0;color:#fff;font:12px/1.35 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
const previewPrice = document.createElement('div');
previewPrice.style.cssText =
  'margin:1px 2px 0;color:#a8d1ff;font:12px/1.35 system-ui,sans-serif;';
preview.append(previewImage, previewTitle, previewPrice);
let previewAttached = false;

function attachPreview(): void {
  if (previewAttached) return;
  document.documentElement.appendChild(preview);
  previewAttached = true;
}

function showPreview(
  anchor: HTMLElement,
  card: ChatCardDisplay,
  price?: ChatCardPrice | null,
): void {
  if (!card.imageUrl) return;
  attachPreview();
  previewImage.src = card.imageUrl;
  previewImage.alt = card.displayName;
  previewTitle.textContent = `${card.displayName} (${card.englishName})`;
  previewPrice.textContent =
    price === undefined
      ? '日本価格を取得中…'
      : price?.value !== null && price !== null
        ? `¥${price.value.toLocaleString('ja-JP')}${price.approximate ? '*' : ''}${price.sourceLabel ? ` — ${price.sourceLabel}` : ''}`
        : '日本価格は取得できませんでした';
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - 260);
  const top = Math.max(8, rect.top - 350);
  preview.style.left = `${Math.max(8, left)}px`;
  preview.style.top = `${top}px`;
  preview.style.display = 'block';
}

function hidePreview(): void {
  preview.style.display = 'none';
}

function cardChip(
  englishName: string,
  resolvePrice?: ResolveChatCardPrice,
  getCardPageUrl?: GetChatCardPageUrl,
): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.textContent = englishName;
  chip.title = `${englishName} を読み込み中`;
  chip.style.cssText =
    'display:inline;border:0;border-radius:4px;padding:1px 4px;background:rgba(76,117,235,.26);color:#9bc0ff;font:inherit;cursor:pointer;';

  let resolved: ChatCardDisplay | undefined;
  let resolvedPrice: ChatCardPrice | undefined;
  const load = async (): Promise<ChatCardDisplay | undefined> => {
    if (resolved !== undefined) return resolved;
    const card = await lookupChatCard(englishName);
    if (!card) {
      chip.title = `${englishName} をScryfallで解決できませんでした`;
      return undefined;
    }
    resolved = card;
    chip.textContent = card.displayName;
    chip.title = card.englishName;
    return card;
  };

  // まず日本語名へ置換する。画像は実際にホバーされたときだけ描画する。
  void load();
  chip.addEventListener('pointerenter', () => {
    void load().then((card) => {
      if (!card || !chip.matches(':hover')) return;
      showPreview(chip, card);
      if (resolvePrice) {
        void resolvePrice(englishName)
          .then((price) => {
            resolvedPrice = price;
            if (chip.matches(':hover')) showPreview(chip, card, price);
          })
          .catch(() => {
            if (chip.matches(':hover')) showPreview(chip, card, null);
          });
      }
    });
  });
  chip.addEventListener('pointerleave', hidePreview);
  chip.addEventListener('click', () => {
    const url = getCardPageUrl?.(englishName, resolvedPrice);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });
  return chip;
}

function extractCardTokens(markdown: string): { text: string; cards: CardToken[] } {
  const cards: CardToken[] = [];
  const text = markdown.replace(CARD_TOKEN, (whole, rawName: string) => {
    const englishName = rawName.trim();
    if (!englishName || cards.length >= MAX_CARDS_PER_MESSAGE) return whole;
    const placeholder = `MTG_CARD_TOKEN_${cards.length}_X`;
    cards.push({ placeholder, englishName });
    return placeholder;
  });
  return { text, cards };
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** annotationの該当範囲を、安全なMarkdownリンクへ置き換える。 */
function applyCitations(markdown: string, citations: AgentCitation[]): string {
  let text = markdown;
  const unresolved: AgentCitation[] = [];
  const valid = citations
    .filter(
      (citation) =>
        isSafeExternalUrl(citation.url) &&
        citation.startIndex >= 0 &&
        citation.endIndex > citation.startIndex &&
        citation.endIndex <= markdown.length,
    )
    .sort((a, b) => b.startIndex - a.startIndex);
  let number = valid.length;
  for (const citation of valid) {
    text =
      text.slice(0, citation.startIndex) +
      `[出典 ${number}](<${citation.url}>)` +
      text.slice(citation.endIndex);
    number--;
  }
  for (const citation of citations) {
    if (!valid.includes(citation) && isSafeExternalUrl(citation.url)) {
      unresolved.push(citation);
    }
  }
  text = text.replace(OPENAI_CITATION, '');
  if (unresolved.length > 0) {
    text += `\n\n出典: ${unresolved
      .map((citation, index) => `[${citation.title || `出典 ${index + 1}`}](<${citation.url}>)`)
      .join(' · ')}`;
  }
  return text;
}

function replaceCardTokens(
  root: HTMLElement,
  cards: CardToken[],
  resolvePrice?: ResolveChatCardPrice,
  getCardPageUrl?: GetChatCardPageUrl,
): void {
  if (cards.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const matches = cards.filter((card) => value.includes(card.placeholder));
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let rest = value;
    while (rest) {
      const index = Math.min(
        ...matches
          .map((card) => rest.indexOf(card.placeholder))
          .filter((position) => position >= 0),
      );
      if (!Number.isFinite(index)) {
        fragment.append(rest);
        break;
      }
      if (index > 0) fragment.append(rest.slice(0, index));
      const token = matches.find((card) => rest.startsWith(card.placeholder, index));
      if (!token) break;
      fragment.append(cardChip(token.englishName, resolvePrice, getCardPageUrl));
      rest = rest.slice(index + token.placeholder.length);
    }
    node.replaceWith(fragment);
  }
}

/** AI出力を安全なMarkdownとして描画し、カードトークンをインタラクティブなチップへ置換する。 */
export function renderChatMarkdown(
  container: HTMLElement,
  markdown: string,
  resolvePrice?: ResolveChatCardPrice,
  getCardPageUrl?: GetChatCardPageUrl,
  citations: AgentCitation[] = [],
): void {
  const { text, cards } = extractCardTokens(applyCitations(markdown, citations));
  const rawHtml = marked.parse(text, { async: false, gfm: true, breaks: true });
  container.innerHTML = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
    ],
    ALLOWED_ATTR: ['href', 'title'],
  });
  for (const link of container.querySelectorAll('a')) {
    try {
      const url = new URL(link.href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } catch {
      link.removeAttribute('href');
    }
  }
  replaceCardTokens(container, cards, resolvePrice, getCardPageUrl);
}
