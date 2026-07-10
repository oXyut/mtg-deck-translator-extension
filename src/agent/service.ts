import { OpenAiAgentProvider } from './openai';
import { getAgentApiKey, getAgentSettings } from './settings';
import { DECK_AGENT_TOOLS, executeDeckAgentTool } from './tools';
import type {
  AgentAnswer,
  AgentChatMessage,
  AgentProgress,
  DeckContext,
} from './types';

const AGENT_TIMEOUT_MS = 180_000;

/**
 * UIやcontent scriptがAPI提供元を知る必要がない、デッキ相談のユースケース層。
 * 新しい提供元はAgentProvider実装をここに登録するだけで追加できる。
 */
export async function askDeckAgent(
  deck: DeckContext,
  messages: AgentChatMessage[],
  onProgress?: (progress: AgentProgress) => void,
): Promise<AgentAnswer> {
  const settings = await getAgentSettings();
  if (!settings.enabled) throw new Error('AIデッキ相談はポップアップで無効になっています。');
  const apiKey = await getAgentApiKey(settings.provider);
  if (!apiKey) throw new Error('OpenAI APIキーを拡張のポップアップで設定してください。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    switch (settings.provider) {
      case 'openai':
        return new OpenAiAgentProvider(apiKey, settings.model).run(
          { deck, messages, tools: [...DECK_AGENT_TOOLS], onProgress },
          executeDeckAgentTool,
          controller.signal,
        );
    }
  } finally {
    clearTimeout(timeout);
  }
}
