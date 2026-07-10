import { browser } from 'wxt/browser';

export type AgentProviderId = 'openai';

export interface AgentSettings {
  enabled: boolean;
  provider: AgentProviderId;
  /** 利用料金・応答速度をユーザーが選べるよう、モデル名は設定値にする */
  model: string;
}

const SETTINGS_KEY = 'agentSettings';
const API_KEY_PREFIX = 'agentApiKey:';

const DEFAULTS: AgentSettings = {
  enabled: true,
  provider: 'openai',
  model: 'gpt-5.4-mini',
};

export async function getAgentSettings(): Promise<AgentSettings> {
  const stored = await browser.storage.sync.get(SETTINGS_KEY);
  return {
    ...DEFAULTS,
    ...(stored[SETTINGS_KEY] as Partial<AgentSettings> | undefined),
  };
}

export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
  await browser.storage.sync.set({ [SETTINGS_KEY]: settings });
}

export function watchAgentSettings(
  callback: (settings: AgentSettings) => void,
): void {
  browser.storage.sync.onChanged.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      callback({
        ...DEFAULTS,
        ...(changes[SETTINGS_KEY].newValue as Partial<AgentSettings>),
      });
    }
  });
}

/** APIキーは端末間で同期しない chrome.storage.local に限定する。 */
export async function getAgentApiKey(provider: AgentProviderId): Promise<string> {
  const key = API_KEY_PREFIX + provider;
  const stored = await browser.storage.local.get(key);
  return typeof stored[key] === 'string' ? stored[key] : '';
}

export async function saveAgentApiKey(
  provider: AgentProviderId,
  apiKey: string,
): Promise<void> {
  const key = API_KEY_PREFIX + provider;
  if (apiKey.trim()) await browser.storage.local.set({ [key]: apiKey.trim() });
  else await browser.storage.local.remove(key);
}
