// 输入栏工具行上的小控件：思考等级选择器、计划面板开关。
import { useState, useRef, useEffect } from 'react';
import { useActiveTab } from '../../stores/chatStore';
import { useSettingsStore, type ThinkingLevel } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { useProviderStore } from '../../stores/providerStore';
import { PROVIDER_PRESETS } from '../../lib/provider-presets';
import { usePlanPanelStore } from './PlanPanel';

/** Thinking effort level configuration data */
const THINK_LEVELS: { id: ThinkingLevel; labelKey: string }[] = [
  { id: 'off', labelKey: 'think.off' },
  { id: 'low', labelKey: 'think.low' },
  { id: 'medium', labelKey: 'think.medium' },
  { id: 'high', labelKey: 'think.high' },
  { id: 'xhigh', labelKey: 'think.xhigh' },
  { id: 'max', labelKey: 'think.max' },
];

/** Thinking effort level selector dropdown for the toolbar */
export function ThinkLevelSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel);
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const thinkingSupport = useProviderStore((s) => {
    if (!s.activeProviderId) return 'full';
    const provider = s.providers.find((p) => p.id === s.activeProviderId);
    if (!provider?.preset) return 'unknown';
    return PROVIDER_PRESETS.find((p) => p.id === provider.preset)?.thinkingSupport ?? 'unknown';
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isOff = thinkingLevel === 'off';
  const current = THINK_LEVELS.find((l) => l.id === thinkingLevel) || THINK_LEVELS[3];

  return (
    <div ref={ref} className={`relative flex-shrink-0 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs whitespace-nowrap
          border transition-smooth cursor-pointer
          ${isOff
            ? 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-500'
          }`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="6" r="4" />
          <path d="M5.5 9.5C5.5 11.5 6 13 8 13s2.5-1.5 2.5-3.5" />
          <path d="M6.5 14h3" />
        </svg>
        <span className="font-medium">{t(current.labelKey)}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[140px]
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          py-1 z-50 animate-fade-in">
          {THINK_LEVELS.map((level) => {
            const isActive = level.id === thinkingLevel;
            return (
              <button
                key={level.id}
                onClick={() => { setThinkingLevel(level.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs
                  transition-smooth cursor-pointer
                  ${isActive
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                {t(level.labelKey)}
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                    stroke="currentColor" strokeWidth="1.5" className="ml-auto">
                    <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                  </svg>
                )}
              </button>
            );
          })}
          {thinkingSupport === 'ignored' && (
            <div className="px-3 py-1.5 text-[10px] text-text-tertiary border-t border-border-subtle mt-1">
              {t('think.providerIgnored')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanToggleButton() {
  const t = useT();
  const isOpen = usePlanPanelStore((s) => s.open);
  const toggle = usePlanPanelStore((s) => s.toggle);
  const hasPlanMessages = useActiveTab((t) =>
    t.messages.some((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
  );
  const inPlanMode = useSettingsStore((s) => s.sessionMode) === 'plan';

  // Only show when in plan mode or there are plan-related messages
  if (!inPlanMode && !hasPlanMessages) return null;

  return (
    <button
      onClick={toggle}
      className={`flex-shrink-0 p-1.5 rounded-lg transition-smooth flex items-center gap-1 whitespace-nowrap
        ${isOpen
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
        }`}
      title={t('msg.viewPlan')}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 4h10M3 8h8M3 12h5" />
      </svg>
      <span className="text-[10px]">Plan</span>
    </button>
  );
}
