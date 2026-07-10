import { clearCache } from '../../src/cache';
import { getSettings, saveSettings } from '../../src/settings';
import {
  getAgentApiKey,
  getAgentSettings,
  saveAgentApiKey,
  saveAgentSettings,
} from '../../src/agent/settings';

const moxfieldInput = document.getElementById('moxfield') as HTMLInputElement;
const archidektInput = document.getElementById('archidekt') as HTMLInputElement;
const hoverZoomInput = document.getElementById('hover-zoom') as HTMLInputElement;
const jpPricesInput = document.getElementById('jp-prices') as HTMLInputElement;
const priceStoreSelect = document.getElementById('price-store') as HTMLSelectElement;
const clearButton = document.getElementById('clear-cache') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;
const agentEnabledInput = document.getElementById('agent-enabled') as HTMLInputElement;
const agentProviderSelect = document.getElementById('agent-provider') as HTMLSelectElement;
const agentModelInput = document.getElementById('agent-model') as HTMLInputElement;
const agentApiKeyInput = document.getElementById('agent-api-key') as HTMLInputElement;
const agentKeyStatus = document.getElementById('agent-key-status') as HTMLSpanElement;
const clearAgentKeyButton = document.getElementById('clear-agent-key') as HTMLButtonElement;

async function init(): Promise<void> {
  const settings = await getSettings();
  moxfieldInput.checked = settings.moxfield;
  archidektInput.checked = settings.archidekt;
  hoverZoomInput.checked = settings.hoverZoom;
  jpPricesInput.checked = settings.jpPrices;
  priceStoreSelect.value = settings.priceStore;

  const agent = await getAgentSettings();
  agentEnabledInput.checked = agent.enabled;
  agentProviderSelect.value = agent.provider;
  agentModelInput.value = agent.model;
  agentKeyStatus.textContent = (await getAgentApiKey(agent.provider))
    ? 'キー設定済み（この端末のみ）'
    : 'APIキー未設定';
}

async function onAgentChange(): Promise<void> {
  // 現在はOpenAIのみ。providerの型を保ち、将来の選択肢追加をこのUIに閉じ込める。
  await saveAgentSettings({
    enabled: agentEnabledInput.checked,
    provider: agentProviderSelect.value as 'openai',
    model: agentModelInput.value.trim() || 'gpt-5.4-mini',
  });
  if (agentApiKeyInput.value.trim()) {
    await saveAgentApiKey('openai', agentApiKeyInput.value);
    agentApiKeyInput.value = '';
    agentKeyStatus.textContent = 'キー設定済み（この端末のみ）';
  }
}

async function onChange(): Promise<void> {
  await saveSettings({
    moxfield: moxfieldInput.checked,
    archidekt: archidektInput.checked,
    hoverZoom: hoverZoomInput.checked,
    jpPrices: jpPricesInput.checked,
    priceStore: priceStoreSelect.value,
  });
}

moxfieldInput.addEventListener('change', () => void onChange());
archidektInput.addEventListener('change', () => void onChange());
hoverZoomInput.addEventListener('change', () => void onChange());
jpPricesInput.addEventListener('change', () => void onChange());
priceStoreSelect.addEventListener('change', () => void onChange());
agentEnabledInput.addEventListener('change', () => void onAgentChange());
agentProviderSelect.addEventListener('change', () => void onAgentChange());
agentModelInput.addEventListener('change', () => void onAgentChange());
agentApiKeyInput.addEventListener('change', () => void onAgentChange());

clearAgentKeyButton.addEventListener('click', () => {
  void saveAgentApiKey('openai', '').then(() => {
    agentApiKeyInput.value = '';
    agentKeyStatus.textContent = 'APIキー未設定';
  });
});

clearButton.addEventListener('click', () => {
  void clearCache().then(() => {
    status.textContent = 'クリアしました';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});

void init();
