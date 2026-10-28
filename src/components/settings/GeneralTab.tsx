import {
  CLI_DEFAULT,
  useSettingsStore,
  getContextWindowForModel,
  getAutoCompactThreshold,
  MODEL_TIER_MAP as TIER_MAP,
} from '../../stores/settingsStore';
import { useEffect, useState, type ReactNode } from 'react';
import { useProviderStore } from '../../stores/providerStore';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/deepseek-models';

/** 自动压缩阈值的预设（K tokens）；不在其中的值归为“自定义” */
const COMPACT_PRESETS = [160, 400, 800];

/** 200000 → 200K，1000000 → 1M */
function formatTokens(n: number): string {
  return n >= 1_000_000 && n % 100_000 === 0 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
}

/** 分组：小标题 + 带边框的设置行列表 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[12px] font-medium text-text-tertiary">{title}</h3>
      <div className="rounded-xl border border-border-subtle px-4 divide-y divide-border-subtle">
        {children}
      </div>
    </section>
  );
}

/** 设置行：左边标题与一行说明，右边控件 */
function Row({ title, hint, tip, children, below }: {
  title: string;
  hint?: ReactNode;
  /** 完整说明，悬停标题旁的 ⓘ 显示 */
  tip?: string;
  children: ReactNode;
  /** 行下方的附加内容（错误信息、自定义输入框等） */
  below?: ReactNode;
}) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-[13px] text-text-primary">
            {title}
            {tip && (
              <span title={tip} className="cursor-help text-text-tertiary">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 7.2v3.8M8 5v.01" strokeLinecap="round" />
                </svg>
              </span>
            )}
          </div>
          {hint && <div className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">{hint}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {below}
    </div>
  );
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      className={`relative block w-8 h-4 rounded-full transition-smooth border disabled:opacity-50
        ${on ? 'bg-accent/80 border-accent/30' : 'bg-text-tertiary/30 border-transparent'}`}
    >
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
        ${on ? 'right-0.5' : 'left-0.5'}`}
      />
    </button>
  );
}

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
  const setContextWindowMode = useSettingsStore((s) => s.setContextWindowMode);
  const setAutoCompactThresholdTokens = useSettingsStore((s) => s.setAutoCompactThresholdTokens);
  const ctrlEnterToSend = useSettingsStore((s) => s.ctrlEnterToSend);
  const toggleCtrlEnterToSend = useSettingsStore((s) => s.toggleCtrlEnterToSend);
  const promptSuggestions = useSettingsStore((s) => s.promptSuggestions);
  const togglePromptSuggestions = useSettingsStore((s) => s.togglePromptSuggestions);
  const minimizeOnClose = useSettingsStore((s) => s.minimizeOnClose);
  const toggleMinimizeOnClose = useSettingsStore((s) => s.toggleMinimizeOnClose);
  const ctrlClickOpenExternally = useSettingsStore((s) => s.ctrlClickOpenExternally);
  const toggleCtrlClickOpenExternally = useSettingsStore((s) => s.toggleCtrlClickOpenExternally);
  const followCli = useSettingsStore((s) => s.followCli);
  const lastCliModel = useSettingsStore((s) => s.lastCliModel);
  const toggleFollowCli = useSettingsStore((s) => s.toggleFollowCli);

  // 当前实际使用的模型（经服务商映射），用于显示窗口大小与阈值
  const selectedTier = TIER_MAP[selectedModel];
  const selectedMapping = selectedTier
    ? activeProvider?.modelMappings.find((m) => m.tier === selectedTier)
    : undefined;
  const selected = selectedMapping?.providerModel || selectedModel;
  // 「CLI 默认」不是真实模型名，用 CLI 上次上报的模型估算窗口
  const actualModel = selected === CLI_DEFAULT ? lastCliModel : selected;
  const actualModelLabel = selected === CLI_DEFAULT
    ? (lastCliModel ? `${t('model.cliDefault')}（${displayProviderModelName(lastCliModel)}）` : t('model.cliDefault'))
    : displayProviderModelName(actualModel);
  const contextWindow = getContextWindowForModel(actualModel, contextWindowMode);
  const compactThreshold = getAutoCompactThreshold(actualModel, contextWindowMode, autoCompactThresholdTokens);

  // 阈值下拉框：自动 / 预设 / 自定义；选了“自定义”但还没改数值时也保持在自定义
  const [forceCustom, setForceCustom] = useState(false);
  const thresholdK = autoCompactThresholdTokens === null ? null : Math.round(autoCompactThresholdTokens / 1000);
  const compactChoice = forceCustom
    ? 'custom'
    : thresholdK === null ? 'auto' : COMPACT_PRESETS.includes(thresholdK) ? String(thresholdK) : 'custom';
  const onCompactChoice = (value: string) => {
    if (value === 'auto') {
      setForceCustom(false);
      setAutoCompactThresholdTokens(null);
    } else if (value === 'custom') {
      setForceCustom(true);
      setAutoCompactThresholdTokens(compactThreshold);
    } else {
      setForceCustom(false);
      setAutoCompactThresholdTokens(Number(value) * 1000);
    }
  };

  const compactInfo = t('settings.compactInfo')
    .replace('{model}', actualModelLabel)
    .replace('{window}', formatTokens(contextWindow))
    .replace('{threshold}', formatTokens(compactThreshold));

  return (
    <div className="space-y-6 max-w-[640px]">
      <Section title={t('settings.section.session')}>
        <Row title={t('settings.followCliToggle')} hint={t('settings.followCliShort')} tip={t('settings.followCliHint')}>
          <Toggle on={followCli} onClick={toggleFollowCli} />
        </Row>
        <Row title={t('settings.large1m')} hint={t('settings.large1mHint')}>
          <Toggle
            on={contextWindowMode === 'large1m'}
            onClick={() => setContextWindowMode(contextWindowMode === 'large1m' ? 'default' : 'large1m')}
          />
        </Row>
        {!followCli && (
          <Row
            title={t('settings.compactThreshold')}
            hint={<>{t('settings.compactThresholdHint')}<br />{compactInfo}</>}
            below={compactChoice === 'custom' && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={10}
                  max={1000}
                  step={10}
                  value={Math.round(compactThreshold / 1000)}
                  onChange={(e) => setAutoCompactThresholdTokens(Number(e.target.value) * 1000)}
                  className="w-24 h-8 px-2 text-[13px] bg-bg-secondary border border-border-subtle
                    rounded-lg text-text-primary outline-none focus:border-accent/60"
                />
                <span className="text-xs text-text-tertiary">K tokens</span>
              </div>
            )}
          >
            <select
              value={compactChoice}
              onChange={(e) => onCompactChoice(e.target.value)}
              className="h-8 px-2 rounded-lg bg-bg-secondary border border-border-subtle
                text-[13px] text-text-primary outline-none focus:border-accent/60"
            >
              <option value="auto">{t('settings.compactAuto')}</option>
              {COMPACT_PRESETS.map((k) => <option key={k} value={String(k)}>{k}K</option>)}
              <option value="custom">{t('settings.compactCustom')}</option>
            </select>
          </Row>
        )}
      </Section>

      <Section title={t('settings.section.input')}>
        <Row title={t('settings.ctrlEnterToSend')} hint={t('settings.ctrlEnterToSendHint')}>
          <Toggle on={ctrlEnterToSend} onClick={toggleCtrlEnterToSend} />
        </Row>
        <Row title={t('settings.promptSuggestions')} hint={t('settings.promptSuggestionsHint')}>
          <Toggle on={promptSuggestions} onClick={togglePromptSuggestions} />
        </Row>
        <Row title={t('settings.ctrlClickOpenExternally')} hint={t('settings.ctrlClickOpenExternallyHint')}>
          <Toggle on={ctrlClickOpenExternally} onClick={toggleCtrlClickOpenExternally} />
        </Row>
      </Section>

      <Section title={t('settings.window')}>
        <Row
          title={t('settings.autostart')}
          hint={t('settings.autostartHint')}
          below={autostartError && <p className="mt-1 text-[11px] text-error">{autostartError}</p>}
        >
          <Toggle on={!!autostart} onClick={toggleAutostart} disabled={autostart === null} />
        </Row>
        <Row title={t('settings.minimizeOnClose')} hint={t('settings.minimizeOnCloseHint')}>
          <Toggle on={minimizeOnClose} onClick={toggleMinimizeOnClose} />
        </Row>
      </Section>
    </div>
  );
}
