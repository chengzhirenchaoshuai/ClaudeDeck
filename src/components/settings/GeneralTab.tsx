import {
  useSettingsStore,
  MODEL_OPTIONS,
  ContextWindowMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
  MODEL_TIER_MAP as TIER_MAP,
} from '../../stores/settingsStore';
import { useEffect, useState } from 'react';
import { useProviderStore } from '../../stores/providerStore';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/deepseek-models';

const CONTEXT_WINDOW_OPTIONS: { id: ContextWindowMode; label: string; hint: string }[] = [
  { id: 'default', label: '按模型自动', hint: '自动识别所选模型的窗口（Sonnet 5 / Opus 5 / Fable / DeepSeek V4 为 1M，其余 200K）' },
  { id: 'large1m', label: '声明 1M', hint: '强制按 1M 计算，用于实际支持 1M 但名称无法识别的模型' },
];

export function GeneralTab() {
  const t = useT();
  // 开机自启动的状态以系统为准（注册表启动项），而不是本地存储
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState('');
  useEffect(() => {
    import('@tauri-apps/plugin-autostart')
      .then(({ isEnabled }) => isEnabled())
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);
  const toggleAutostart = async () => {
    setAutostartError('');
    try {
      const { enable, disable } = await import('@tauri-apps/plugin-autostart');
      if (autostart) await disable();
      else await enable();
      setAutostart(!autostart);
    } catch (e) {
      setAutostartError(String(e));
    }
  };
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const setContextWindowMode = useSettingsStore((s) => s.setContextWindowMode);
  const setAutoCompactThresholdTokens = useSettingsStore((s) => s.setAutoCompactThresholdTokens);
  const ctrlEnterToSend = useSettingsStore((s) => s.ctrlEnterToSend);
  const toggleCtrlEnterToSend = useSettingsStore((s) => s.toggleCtrlEnterToSend);
  const minimizeOnClose = useSettingsStore((s) => s.minimizeOnClose);
  const toggleMinimizeOnClose = useSettingsStore((s) => s.toggleMinimizeOnClose);
  const ctrlClickOpenExternally = useSettingsStore((s) => s.ctrlClickOpenExternally);
  const toggleCtrlClickOpenExternally = useSettingsStore((s) => s.toggleCtrlClickOpenExternally);
  const selectedTier = TIER_MAP[selectedModel];
  const selectedMapping = selectedTier
    ? activeProvider?.modelMappings.find((m) => m.tier === selectedTier)
    : undefined;
  const actualModel = selectedMapping?.providerModel || selectedModel;
  const contextWindow = getContextWindowForModel(actualModel, contextWindowMode);
  const compactThreshold = getAutoCompactThreshold(actualModel, contextWindowMode, autoCompactThresholdTokens);
  const tierMappings = activeProvider?.modelMappings
    .filter((m) => ['opus', 'sonnet', 'haiku'].includes(m.tier) && m.providerModel)
    .map((m) => `${m.tier}=${displayProviderModelName(m.providerModel)}`)
    .join(' / ');

  return (
    <div className="space-y-6">
      {/* Settings row */}
      <div className="flex items-start gap-8 flex-wrap">
        {/* Default Model */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.defaultModel')}</h3>
          <div className="flex flex-wrap gap-2">
            {MODEL_OPTIONS.map((model) => (
              <button
                key={model.id}
                onClick={() => setSelectedModel(model.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2
                  rounded-lg text-[13px] font-medium transition-smooth
                  ${selectedModel === model.id
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border border-border-subtle'
                  }`}
              >
                {selectedModel === model.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M3 8l4 4 6-7" />
                  </svg>
                )}
                {(() => {
                  if (!activeProvider) return model.short;
                  const tier = TIER_MAP[model.id];
                  const mapping = activeProvider.modelMappings.find((mm) => mm.tier === tier);
                  return mapping?.providerModel ? displayProviderModelName(mapping.providerModel) : model.short;
                })()}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-text-tertiary leading-relaxed">
            Actual model: <span className="font-mono text-text-muted">{displayProviderModelName(actualModel)}</span>
            {activeProvider && tierMappings && (
              <span className="ml-2">Mappings: {tierMappings}</span>
            )}
          </div>
        </div>

        {/* Context Window */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">上下文窗口</h3>
          <div className="grid grid-cols-2 gap-2">
            {CONTEXT_WINDOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setContextWindowMode(option.id)}
                className={`text-left px-3 py-2 rounded-lg border transition-smooth
                  ${contextWindowMode === option.id
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                  }`}
              >
                <div className="text-[13px] font-medium">{option.label}</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{option.hint}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            当前模型（{displayProviderModelName(actualModel)}）的上下文窗口：{contextWindow.toLocaleString()} tokens
            （{contextWindowMode === 'large1m' ? '已声明 1M' : '按模型自动识别'}）；
            自动 compact 阈值：{compactThreshold.toLocaleString()} tokens。
            如果当前供应商路由实际支持 1M 而这里显示 200K，请选择“声明 1M”。
          </p>
        </div>

        {/* Auto compact threshold */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">自动 compact 阈值</h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={1000}
              step={10}
              value={Math.round(compactThreshold / 1000)}
              onChange={(e) => setAutoCompactThresholdTokens(Number(e.target.value) * 1000)}
              className="w-28 px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle
                rounded-lg text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-xs text-text-tertiary">K tokens</span>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setAutoCompactThresholdTokens(null)}
                className={`px-2 py-1 rounded-md text-[11px] border transition-smooth
                  ${autoCompactThresholdTokens === null
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                  }`}
                title="按所选模型自动取上下文窗口的 80%"
              >
                自动
              </button>
              {[160, 400, 800, 950].map((value) => (
                <button
                  key={value}
                  onClick={() => setAutoCompactThresholdTokens(value * 1000)}
                  className={`px-2 py-1 rounded-md text-[11px] border transition-smooth
                    ${autoCompactThresholdTokens !== null && Math.round(autoCompactThresholdTokens / 1000) === value
                      ? 'bg-accent/10 text-accent border-accent/30'
                      : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                    }`}
                >
                  {value}K
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            这个值会直接决定自动发送 `/compact` 的时机；改完后对当前会话立即生效。
            选择“自动”时，阈值随所选模型变化，取上下文窗口的 80%（200K 为 160K，1M 为 800K）。
          </p>
        </div>

        {/* Chat Interaction */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.chatInteraction')}</h3>
          <button
            onClick={toggleCtrlEnterToSend}
            className="inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${ctrlEnterToSend ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${ctrlEnterToSend ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.ctrlEnterToSend')}
          </button>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            {t('settings.ctrlEnterToSendHint')}
          </p>
        </div>

        {/* 窗口行为：开机启动、关闭时最小化到任务栏 */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.window')}</h3>
          <button
            onClick={toggleAutostart}
            disabled={autostart === null}
            className="w-full inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth disabled:opacity-50"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${autostart ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${autostart ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.autostart')}
          </button>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            {t('settings.autostartHint')}
          </p>
          {autostartError && <p className="mt-1 text-[11px] text-red-500">{autostartError}</p>}
          <button
            onClick={toggleMinimizeOnClose}
            className="mt-3 w-full inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${minimizeOnClose ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${minimizeOnClose ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.minimizeOnClose')}
          </button>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            {t('settings.minimizeOnCloseHint')}
          </p>
        </div>

        {/* Ctrl+Click to open externally */}
        <div>
          <button
            onClick={toggleCtrlClickOpenExternally}
            className="inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${ctrlClickOpenExternally ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${ctrlClickOpenExternally ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.ctrlClickOpenExternally')}
          </button>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            {t('settings.ctrlClickOpenExternallyHint')}
          </p>
        </div>

      </div>
    </div>
  );
}
