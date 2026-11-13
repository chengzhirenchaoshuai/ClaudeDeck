import { useState, useRef, useEffect, useMemo, Fragment } from 'react';
import { CLI_DEFAULT, useSettingsStore, MODEL_OPTIONS, MODEL_TIER_MAP as TIER_MAP } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';
import { displayProviderModelName, normalizeProviderModelName } from '../../lib/deepseek-models';
import { cliDefaultTooltip, mappedTooltip } from '../../lib/model-info';
import { ModelInfoCard } from '../shared/ModelInfoCard';

const FIXED_TIERS = new Set(['opus', 'sonnet', 'haiku']);

interface DisplayOption {
  id: string;
  label: string;
  short: string;
  mapped: boolean;
  isExtra: boolean;
  /** 没有官方参数可查时（「CLI 默认」、服务商映射的模型），说明卡片显示这段文本 */
  tip: string;
}

export function ModelSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  // 说明文本里含价格与 CLI 上次上报的模型，这两项变了要重算
  const customModelPrices = useSettingsStore((s) => s.customModelPrices);
  const lastCliModel = useSettingsStore((s) => s.lastCliModel);
  const [open, setOpen] = useState(false);
  /** 说明卡片要展示的选项：展开时是鼠标悬停的那项，收起时是悬停按钮的当前模型 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [buttonHovered, setButtonHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setHoveredId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Build display options: official Claude models + extra models from provider.
  // Deduplicate: if multiple Claude models map to the same provider model, keep only the first.
  const displayOptions = useMemo((): DisplayOption[] => {
    if (!activeProvider || activeProvider.modelMappings.length === 0) {
      // 没有服务商映射时提供“CLI 默认”：不传 --model，用 CLI 自己设置的模型
      const cliDefault = t('model.cliDefault');
      return [
        { id: CLI_DEFAULT, label: cliDefault, short: cliDefault, mapped: false, isExtra: false, tip: cliDefaultTooltip(t) },
        ...MODEL_OPTIONS.map((m) => ({
          id: m.id, label: m.label, short: m.short, mapped: false, isExtra: false, tip: '',
        })),
      ];
    }

    // Official models with tier mapping.
    // When multiple Claude models map to the same provider model (e.g. Opus and Opus 1M
    // both map to "mimo-v2-pro"), keep both entries with their original labels so the user
    // can still distinguish them — the 1M variant uses a higher context window (#139 port).
    const official = MODEL_OPTIONS.map((m) => {
      const tier = TIER_MAP[m.id];
      const mapping = activeProvider.modelMappings.find((mm) => mm.tier === tier);
      if (mapping?.providerModel) {
        const providerModel = normalizeProviderModelName(mapping.providerModel);
        const providerLabel = displayProviderModelName(providerModel);
        const label = providerLabel === m.short ? m.short : `${m.short} -> ${providerLabel}`;
        return {
          id: m.id, label, short: providerLabel, mapped: true, isExtra: false,
          tip: mappedTooltip(providerLabel, t),
        };
      }
      return { id: m.id, label: m.label, short: m.short, mapped: false, isExtra: false, tip: '' };
    });

    // Extra models (non-tier mappings added by user)
    const extras: DisplayOption[] = activeProvider.modelMappings
      .filter((m) => !FIXED_TIERS.has(m.tier) && m.tier && m.providerModel)
      .map((m) => {
        const providerModel = normalizeProviderModelName(m.providerModel);
        const providerLabel = displayProviderModelName(providerModel);
        const short = providerLabel.includes('/')
          ? providerLabel.split('/').pop()!
          : providerLabel;
        return {
          id: m.tier, label: providerLabel, short, mapped: true, isExtra: true,
          tip: mappedTooltip(providerLabel, t),
        };
      });

    return [...official, ...extras];
  }, [activeProvider, t, customModelPrices, lastCliModel]);

  const fallbackOption = displayOptions.find((option) => option.mapped) || displayOptions[0];

  useEffect(() => {
    if (!fallbackOption) return;
    if (!displayOptions.some((option) => option.id === selectedModel)) {
      setSelectedModel(fallbackOption.id);
    }
  }, [displayOptions, fallbackOption, selectedModel, setSelectedModel]);

  const current = displayOptions.find((m) => m.id === selectedModel) || fallbackOption;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => !disabled && setOpen(!open)}
        onMouseEnter={() => setButtonHovered(true)}
        onMouseLeave={() => setButtonHovered(false)}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg
          text-xs text-text-muted hover:text-text-primary whitespace-nowrap
          hover:bg-bg-secondary transition-smooth
          disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" strokeLinecap="round" />
        </svg>
        {current.short}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {!open && buttonHovered && !disabled && (
        <div className="absolute bottom-full right-0 mb-1 w-60 z-50 pointer-events-none">
          <ModelInfoCard modelId={current.id} fallbackText={current.tip} />
        </div>
      )}

      {open && (
        <div
          onMouseLeave={() => setHoveredId(null)}
          className="absolute bottom-full right-0 mb-1 w-56
            bg-bg-card border border-border-subtle rounded-xl shadow-lg
            py-1 z-50 animate-in fade-in slide-in-from-bottom-1 duration-150"
        >
          {/* 悬停某一项时，参数卡片贴在列表左侧，不挡住列表本身 */}
          {hoveredId && (
            <div className="absolute right-full top-1/2 -translate-y-1/2 mr-2 w-60 pointer-events-none">
              <ModelInfoCard
                modelId={hoveredId}
                fallbackText={displayOptions.find((o) => o.id === hoveredId)?.tip}
              />
            </div>
          )}
          {displayOptions.map((option, index) => (
            <Fragment key={option.id}>
              {option.isExtra && index > 0 && !displayOptions[index - 1].isExtra && (
                <div className="border-t border-border-subtle my-1" />
              )}
              <button
                onMouseEnter={() => setHoveredId(option.id)}
                onClick={() => {
                  if (option.id !== selectedModel) {
                    const oldShort = current.short;
                    const newShort = option.short;
                    setSelectedModel(option.id);
                    // Insert model-switch tag into chat immediately
                    const msTabId = useSessionStore.getState().selectedSessionId;
                    if (msTabId) {
                      useChatStore.getState().addMessage(msTabId, {
                        id: generateMessageId(),
                        role: 'system',
                        type: 'text',
                        content: `${oldShort} → ${newShort}`,
                        commandType: 'model-switch',
                        timestamp: Date.now(),
                      });
                    }
                  }
                  setOpen(false);
                  setHoveredId(null);
                }}
                className={`w-full text-left px-3 py-2 text-xs
                  transition-smooth flex items-center justify-between
                  ${option.id === selectedModel
                    ? 'text-accent bg-accent/5'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                <div className="min-w-0">
                  <div className={`font-medium truncate ${option.mapped ? 'font-mono' : ''}`}>{option.label}</div>
                </div>
                {option.id === selectedModel && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 ml-2">
                    <path d="M3 8l3.5 3.5L13 5" />
                  </svg>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
