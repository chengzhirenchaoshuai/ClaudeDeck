import { useProviderStore } from '../stores/providerStore';
import { PROVIDER_PRESETS } from './provider-presets';
import { isRemotePath } from './tauri-bridge';
import { CLI_DEFAULT, MODEL_TIER_MAP as TIER_MAP, useSettingsStore, type ModelId } from '../stores/settingsStore';
import {
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  normalizeProviderModelName,
} from './deepseek-models';

/**
 * 参与模型 / 思考等级解析的本机服务商。远程项目（ssh://）返回 null：远端 claude 用的是
 * 远端自己的账户或服务商配置，本机服务商的模型映射与思考支持对它都不适用，
 * 远程会话直接使用选择器里的官方模型 ID。
 */
function activeLocalProvider() {
  if (isRemotePath(useSettingsStore.getState().workingDirectory)) return null;
  return useProviderStore.getState().getActive();
}

/**
 * Result of model resolution — either a mapped model name or an error.
 */
export type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_mapping'; tier: string; providerName: string };

/**
 * Resolve the UI-selected model ID to the provider's actual model name,
 * returning an error if the provider has no mapping for the selected tier.
 */
export function resolveModelOrError(selectedModel: string): ModelResolution {
  const provider = activeLocalProvider();
  if (!provider) {
    return { ok: true, model: selectedModel };
  }

  // 1. Check direct model ID mapping first (e.g. 'claude-opus-4-6-1m' → 'glm-5-1m')
  const directMapping = provider.modelMappings.find(
    (m) => m.tier === selectedModel && m.providerModel,
  );
  if (directMapping?.providerModel) {
    return { ok: true, model: normalizeProviderModelName(directMapping.providerModel) };
  }

  // 2. Fall back to tier mapping
  const tier = TIER_MAP[selectedModel];
  if (!tier) {
    const fallback = provider.modelMappings.find(
      (m) => m.tier === 'sonnet' && m.providerModel,
    ) || provider.modelMappings.find(
      (m) => m.tier === 'haiku' && m.providerModel,
    ) || provider.modelMappings.find(
      (m) => m.tier === 'opus' && m.providerModel,
    ) || provider.modelMappings.find((m) => m.providerModel);

    if (fallback?.providerModel) {
      return { ok: true, model: normalizeProviderModelName(fallback.providerModel) };
    }

    return { ok: false, reason: 'no_mapping', tier: selectedModel, providerName: provider.name };
  }

  const mapping = provider.modelMappings.find(
    (m) => m.tier === tier && m.providerModel,
  );
  if (!mapping?.providerModel) {
    return { ok: false, reason: 'no_mapping', tier, providerName: provider.name };
  }
  return { ok: true, model: normalizeProviderModelName(mapping.providerModel) };
}

/**
 * Resolve the UI-selected model ID to the provider's actual model name.
 * When a provider is active, looks up the model mapping for the selected tier.
 * Returns the original model ID if no mapping is configured (silent fallback).
 */
/** Map internal model IDs to CLI-expected format */
const CLI_MODEL_MAP: Partial<Record<ModelId, string>> = {
  'claude-opus-4-6-1m': 'claude-opus-4-6[1m]',
};

export function resolveModelForProvider(selectedModel: string): string {
  const r = resolveModelOrError(selectedModel);
  const model = r.ok ? r.model : selectedModel;
  return CLI_MODEL_MAP[model as ModelId] ?? model;
}

export function supportsDeepSeekThinking(model: string): boolean {
  const normalized = normalizeProviderModelName(model);
  return normalized === DEEPSEEK_V4_PRO || normalized === DEEPSEEK_V4_FLASH;
}

export function resolveThinkingLevelForProvider(selectedModel: string, requestedLevel: string): string {
  if (requestedLevel === 'off') return 'off';
  // xhigh 仅 Opus 5 / Sonnet 5 / Fable 等较新模型支持；Opus 4.6、Sonnet 4.6、Haiku 不支持，降为 high
  if (requestedLevel === 'xhigh' && /opus-4-6|sonnet-4-6|haiku/.test(selectedModel)) return 'high';
  const provider = activeLocalProvider();
  if (!provider) return requestedLevel;
  const support = PROVIDER_PRESETS.find((preset) => preset.id === provider.preset)?.thinkingSupport;
  return support === 'ignored' ? 'off' : requestedLevel;
}

/**
 * Stable fingerprint of the current API provider config.
 * Any provider config change invalidates the pre-warmed session.
 */
export function envFingerprint(): string {
  const { activeProviderId, providers } = useProviderStore.getState();
  const provider = providers.find((p) => p.id === activeProviderId);
  return JSON.stringify({
    activeProviderId,
    updatedAt: provider?.updatedAt ?? 0,
    // MCP 开关只能在进程启动时决定，切换后旧进程需要重启
    enableMcp: useSettingsStore.getState().enableMcp,
    followCli: useSettingsStore.getState().followCli,
    // 提示建议也只能在进程启动时开启
    promptSuggestions: useSettingsStore.getState().promptSuggestions,
  });
}

/**
 * 启动 CLI 时与模型 / 思考档位相关的参数。“CLI 默认”转成不传，由 CLI 自己的配置决定。
 * resolvedModel、thinkingLevel 应是 resolveModelForProvider / resolveThinkingLevelForProvider 的结果。
 */
export function cliLaunchArgs(resolvedModel: string, thinkingLevel: string): {
  model?: string;
  thinking_level?: string;
  follow_cli: boolean;
  prompt_suggestions: boolean;
} {
  return {
    model: resolvedModel && resolvedModel !== CLI_DEFAULT ? resolvedModel : undefined,
    thinking_level: thinkingLevel !== CLI_DEFAULT ? thinkingLevel : undefined,
    follow_cli: useSettingsStore.getState().followCli,
    prompt_suggestions: useSettingsStore.getState().promptSuggestions,
  };
}
