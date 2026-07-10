import { browser } from 'wxt/browser';
import {
  renderChatMarkdown,
  type ChatCardPrice,
} from './chat-markdown';
import { priceSourceUrl, type JpPrice } from './prices';
import type { DeckEntry, SiteAdapter } from './swapper';
import type {
  AgentAnswer,
  AgentChatMessage,
  AgentProgress,
  DeckContext,
} from './agent/types';

const ROOT_ID = 'mtg-jp-deck-agent';
const FULLSCREEN_STYLE_ID = 'mtg-jp-agent-fullscreen-style';

function ensureFullscreenOverlayStyle(): void {
  if (document.getElementById(FULLSCREEN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FULLSCREEN_STYLE_ID;
  style.textContent =
    'html[data-mtg-agent-fullscreen="1"] #mtg-jp-price-badge,html[data-mtg-agent-fullscreen="1"] #mtg-jp-price-panel,html[data-mtg-agent-fullscreen="1"] #mtg-jp-progress-badge{display:none!important}';
  document.documentElement.appendChild(style);
}

function emitFullscreenChange(active: boolean): void {
  document.dispatchEvent(
    new CustomEvent('mtg-agent-fullscreen-change', { detail: { active } }),
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'AIへの接続に失敗しました。';
}

/** 現在のデッキを渡して会話する、ページ内の最小限の協働UI。 */
export function startDeckAgentOverlay(
  adapter: SiteAdapter,
  bottomPx: number,
  enabled: boolean,
  getPriceStore: () => string,
): { setEnabled: (next: boolean) => void } | undefined {
  if (!adapter.getDeckList || document.getElementById(ROOT_ID)) return undefined;
  ensureFullscreenOverlayStyle();
  const getDeckList = adapter.getDeckList.bind(adapter);
  const getDeckContext = adapter.getDeckContext?.bind(adapter);
  const messages: AgentChatMessage[] = [];
  let activeRequestId: string | undefined;
  let receiveProgress: ((progress: AgentProgress) => void) | undefined;
  const resolvePrice = (name: string): Promise<ChatCardPrice> =>
    browser.runtime.sendMessage({
      type: 'jp-price',
      name,
      store: getPriceStore(),
    }) as Promise<JpPrice>;
  const getCardPageUrl = (name: string, price?: ChatCardPrice): string =>
    priceSourceUrl(
      name,
      price?.linkHareruya ?? getPriceStore() === 'hareruya',
    );

  const root = element('div');
  root.id = ROOT_ID;
  root.style.cssText = `position:fixed;right:16px;bottom:${bottomPx}px;z-index:2147483647;font:13px/1.5 system-ui,sans-serif;display:${enabled ? 'block' : 'none'};`;

  const toggle = element('button', 'AIデッキ相談');
  toggle.type = 'button';
  toggle.style.cssText =
    'border:0;border-radius:8px;background:#3a5ccc;color:#fff;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;font:inherit;';

  const panel = element('section');
  panel.style.cssText =
    'display:none;position:absolute;right:0;bottom:42px;width:390px;max-width:calc(100vw - 32px);max-height:70vh;box-sizing:border-box;padding:12px;background:rgba(20,20,24,.97);color:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.45);flex-direction:column;';
  const titleRow = element('div');
  titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
  const title = element('strong', 'AIデッキ相談');
  const titleActions = element('div');
  titleActions.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const expand = element('button', '⛶');
  expand.type = 'button';
  expand.title = 'ほぼ全画面に拡大';
  expand.style.cssText =
    'border:0;background:transparent;color:#fff;font-size:18px;line-height:1;cursor:pointer;';
  const close = element('button', '×');
  close.type = 'button';
  close.title = '閉じる';
  close.style.cssText =
    'border:0;background:transparent;color:#fff;font-size:20px;line-height:1;cursor:pointer;';
  titleActions.append(expand, close);
  titleRow.append(title, titleActions);

  const notice = element(
    'p',
    '現在のデッキリストと、EDHREC・Commander Spellbook・公式ルール・Scryfallを参照して提案します。カードは自動変更されません。',
  );
  notice.style.cssText = 'margin:6px 0;color:#c6cbd5;font-size:11px;';

  const thread = element('div');
  thread.style.cssText =
    'display:flex;flex:1;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;max-height:42vh;padding:4px 1px;margin:4px 0 8px;';
  const empty = element('div', '例: このデッキの土地配分とドロー源を改善したい');
  empty.style.cssText = 'color:#aeb6c4;font-size:12px;';
  thread.appendChild(empty);

  const form = element('form');
  form.style.cssText = 'display:flex;gap:6px;align-items:end;';
  const textarea = element('textarea') as HTMLTextAreaElement;
  textarea.rows = 3;
  textarea.placeholder = '相談したいことを入力…';
  textarea.style.cssText =
    'flex:1;resize:vertical;min-height:42px;max-height:120px;box-sizing:border-box;border:1px solid #667;border-radius:6px;padding:6px;background:#292a32;color:#fff;font:inherit;';
  const send = element('button', '送信');
  send.type = 'submit';
  send.style.cssText =
    'border:0;border-radius:6px;background:#4c75eb;color:#fff;padding:7px 10px;cursor:pointer;font:inherit;';
  form.append(textarea, send);
  const starters = element('div');
  starters.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px;';
  const starterPrompts = [
    'このデッキの勝ち筋と弱点を整理して',
    '土地・マナ加速・ドローのバランスを診断して',
    '現在のフォーマットのメタと比較して改善候補を出して',
    '予算を抑えて入れ替え候補を提案して',
  ];
  for (const prompt of starterPrompts) {
    const starter = element('button', prompt);
    starter.type = 'button';
    starter.style.cssText =
      'border:1px solid rgba(150,180,255,.4);border-radius:999px;padding:3px 7px;background:rgba(76,117,235,.13);color:#c9dcff;font:11px/1.25 system-ui,sans-serif;cursor:pointer;';
    starter.addEventListener('click', () => {
      textarea.value = prompt;
      form.requestSubmit();
    });
    starters.appendChild(starter);
  }
  const resizeHandle = element('div');
  resizeHandle.title = 'ドラッグして横幅を変更';
  resizeHandle.style.cssText =
    'position:absolute;left:-5px;top:14px;bottom:14px;width:10px;cursor:ew-resize;';
  panel.append(resizeHandle, titleRow, notice, starters, thread, form);
  root.append(toggle, panel);
  document.documentElement.appendChild(root);

  let expanded = false;
  let panelWidth = 390;
  const MIN_PANEL_WIDTH = 300;

  function applyPanelLayout(): void {
    if (expanded) {
      document.documentElement.dataset.mtgAgentFullscreen = '1';
      emitFullscreenChange(true);
      panel.style.position = 'fixed';
      panel.style.left = '16px';
      panel.style.right = '16px';
      panel.style.top = '16px';
      panel.style.bottom = '16px';
      panel.style.width = 'auto';
      panel.style.maxWidth = 'none';
      panel.style.maxHeight = 'none';
      thread.style.maxHeight = 'none';
      resizeHandle.style.display = 'none';
      expand.textContent = '↙';
      expand.title = '通常サイズに戻す';
      return;
    }
    delete document.documentElement.dataset.mtgAgentFullscreen;
    emitFullscreenChange(false);
    panelWidth = Math.min(panelWidth, Math.max(MIN_PANEL_WIDTH, window.innerWidth - 32));
    panel.style.position = 'absolute';
    panel.style.left = '';
    panel.style.right = '0';
    panel.style.top = '';
    panel.style.bottom = '42px';
    panel.style.width = `${panelWidth}px`;
    panel.style.maxWidth = 'calc(100vw - 32px)';
    panel.style.maxHeight = '70vh';
    thread.style.maxHeight = '42vh';
    resizeHandle.style.display = 'block';
    expand.textContent = '⛶';
    expand.title = 'ほぼ全画面に拡大';
  }

  const setOpen = (open: boolean) => {
    if (open) applyPanelLayout();
    panel.style.display = open ? 'flex' : 'none';
    if (!open) {
      delete document.documentElement.dataset.mtgAgentFullscreen;
      emitFullscreenChange(false);
    }
    if (open) textarea.focus();
  };
  toggle.addEventListener('click', () => setOpen(panel.style.display === 'none'));
  close.addEventListener('click', () => setOpen(false));
  expand.addEventListener('click', () => {
    expanded = !expanded;
    applyPanelLayout();
  });
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (expanded) return;
    event.preventDefault();
    resizeHandle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      panelWidth = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(window.innerWidth - 32, panel.getBoundingClientRect().right - moveEvent.clientX),
      );
      applyPanelLayout();
    };
    const end = () => {
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', end);
      resizeHandle.removeEventListener('pointercancel', end);
    };
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', end);
    resizeHandle.addEventListener('pointercancel', end);
  });
  window.addEventListener('resize', applyPanelLayout);

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as {
      type?: string;
      requestId?: string;
      progress?: AgentProgress;
    };
    if (
      msg.type === 'deck-agent-progress' &&
      msg.requestId === activeRequestId &&
      msg.progress?.detail
    ) {
      receiveProgress?.(msg.progress);
    }
  });

  function renderMessage(message: AgentChatMessage): void {
    empty.remove();
    const block = element('div');
    block.style.cssText = [
      'overflow-wrap:anywhere',
      'padding:7px 8px',
      'border-radius:7px',
      'font:13px/1.55 system-ui,sans-serif',
      message.role === 'user'
        ? 'background:#31436f;align-self:flex-end'
        : 'background:#30313a;align-self:stretch',
    ].join(';');
    if (message.role === 'assistant') {
      renderChatMarkdown(
        block,
        message.content,
        resolvePrice,
        getCardPageUrl,
        message.citations,
      );
    } else {
      block.style.whiteSpace = 'pre-wrap';
      block.textContent = message.content;
    }
    thread.appendChild(block);
    thread.scrollTop = thread.scrollHeight;
  }

  function deckContext(entries: DeckEntry[]): DeckContext {
    return {
      sourceUrl: location.href,
      entries: entries.map(({ name, quantity, isCommander, scryfallId }) => ({
        name,
        quantity,
        isCommander,
        scryfallId,
      })),
    };
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const content = textarea.value.trim();
    if (!content || send.disabled) return;
    void (async () => {
      textarea.value = '';
      send.disabled = true;
      renderMessage({ role: 'user', content });
      messages.push({ role: 'user', content });
      const waiting = element('div', 'デッキと公開データを確認中…');
      waiting.style.cssText = 'color:#b9c5ef;font-size:12px;';
      thread.appendChild(waiting);
      const activity = element('div');
      activity.style.cssText =
        'white-space:pre-wrap;color:#b9c5ef;font-size:11px;border-left:2px solid #4c75eb;padding-left:6px;';
      thread.appendChild(activity);
      const activityLog: string[] = [];
      const requestId = crypto.randomUUID();
      activeRequestId = requestId;
      receiveProgress = (progress) => {
        activityLog.push(progress.detail);
        activity.textContent = activityLog.slice(-6).join('\n');
        thread.scrollTop = thread.scrollHeight;
      };
      const startedAt = Date.now();
      const tick = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        waiting.textContent =
          elapsed < 10
            ? `AIへ問い合わせ中…（${elapsed}秒）`
            : `データを調査中…（${elapsed}秒、最大180秒）`;
      }, 1000);
      try {
        const data = getDeckContext ? await getDeckContext() : null;
        const entries = data?.entries ?? (await getDeckList());
        if (!entries?.length) {
          throw new Error('このページからデッキリストを取得できませんでした。公開デッキ画面でお試しください。');
        }
        const context = data
          ? {
              sourceUrl: location.href,
              entries: data.entries,
              metadata: data.metadata,
              // サイドボードは、質問がメインデッキだけについていても構築枚数を
              // 誤認しないために常に渡す。AI側では明示的にメイン外として扱う。
              candidates: data.candidates,
            }
          : deckContext(entries);
        const answer = (await browser.runtime.sendMessage({
          type: 'deck-agent',
          requestId,
          deck: context,
          // 毎回の転送量と料金を抑えるため、直近の会話だけを文脈に残す
          messages: messages.slice(-8),
        })) as AgentAnswer;
        if (typeof answer?.text !== 'string' || !answer.text.trim()) {
          throw new Error('AIから空の応答が返りました。APIキー・モデル設定を確認してください。');
        }
        const assistant = {
          role: 'assistant' as const,
          content: answer.text,
          citations: Array.isArray(answer.citations) ? answer.citations : [],
        };
        messages.push(assistant);
        renderMessage(assistant);
      } catch (error) {
        renderMessage({ role: 'assistant', content: `エラー: ${errorText(error)}` });
      } finally {
        if (activeRequestId === requestId) {
          activeRequestId = undefined;
          receiveProgress = undefined;
        }
        window.clearInterval(tick);
        waiting.remove();
        send.disabled = false;
        textarea.focus();
      }
    })();
  });

  return {
    setEnabled(next: boolean) {
      root.style.display = next ? 'block' : 'none';
      if (!next) setOpen(false);
    },
  };
}
