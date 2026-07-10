import type { DeckEntry } from '../swapper';
import type { DeckContextData } from '../deck-context';

/** API提供元に依存しない、デッキ相談に渡す文脈。 */
export interface DeckContext extends DeckContextData {
  sourceUrl: string;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: AgentCitation[];
}

/** 各LLM提供元の出典情報を正規化する共通形式。文字位置はUTF-16 index。 */
export interface AgentCitation {
  startIndex: number;
  endIndex: number;
  url: string;
  title: string;
}

export interface AgentAnswer {
  text: string;
  citations: AgentCitation[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** UIに出す、提供元に依存しない読み取り専用ツールの進捗。 */
export interface AgentProgress {
  kind: 'scryfall' | 'web_search';
  detail: string;
}

export interface AgentRequest {
  deck: DeckContext;
  messages: AgentChatMessage[];
  tools: AgentTool[];
  onProgress?: (progress: AgentProgress) => void;
}

export type ExecuteTool = (call: AgentToolCall) => Promise<string>;

/**
 * LLM API固有の実装境界。
 * 将来のClaude/Geminiアダプターも、この形でツール実行を受け取る。
 */
export interface AgentProvider {
  readonly id: string;
  run(
    request: AgentRequest,
    executeTool: ExecuteTool,
    signal?: AbortSignal,
  ): Promise<AgentAnswer>;
}

export type { DeckEntry };
