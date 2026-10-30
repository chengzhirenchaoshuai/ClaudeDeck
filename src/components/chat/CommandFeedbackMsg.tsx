// 斜杠命令结果的反馈卡片：模式切换、信息卡、帮助列表、操作反馈。
import { useT } from '../../lib/i18n';
import { useAccountStore } from '../../stores/accountStore';
import { AccountStatus } from '../shared/AccountStatus';
import { safeContent, type MessageProps } from './messageShared';

/* ================================================================
   CommandFeedbackMsg — rich UI for slash command results
   Renders mode switches, info cards, help lists, action feedback
   ================================================================ */
export function CommandFeedbackMsg({ message }: MessageProps) {
  const t = useT();
  const cType = message.commandType;
  const data = message.commandData || {};
  const refreshAccount = useAccountStore((s) => s.refresh);

  // --- Mode switch: animated pill with icon ---
  if (cType === 'mode') {
    const modeColors: Record<string, string> = {
      ask: 'from-blue-500/15 to-blue-400/5 border-blue-400/30 text-blue-400',
      plan: 'from-amber-500/15 to-amber-400/5 border-amber-400/30 text-amber-400',
      code: 'from-emerald-500/15 to-emerald-400/5 border-emerald-400/30 text-emerald-400',
    };
    const colorClass = modeColors[data.mode] || modeColors.code;
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full
          bg-gradient-to-r ${colorClass} border
          shadow-sm transition-all duration-300`}>
          <span className="text-base">{data.icon}</span>
          <span className="text-xs font-medium">{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- Model switch: centered pill ---
  if (cType === 'model-switch') {
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full
          border border-border-subtle text-text-tertiary text-[11px]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0 opacity-60">
            <path d="M4 6l4-4 4 4M4 10l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {safeContent(message.content)}
        </div>
      </div>
    );
  }

  // --- Info card: structured key-value table or preformatted text ---
  if (cType === 'info') {
    const rows: Array<{ label: string; value: string }> = data.rows || [];

    // Preformatted output (e.g. CLI command results)
    if (data.preformatted) {
      return (
        <div className="ml-13 my-1 animate-fade-in">
          <div className="rounded-lg border border-border-subtle
            bg-bg-secondary/50 overflow-hidden max-w-md">
            <div className="flex items-center gap-2 px-3 py-1.5
              border-b border-border-subtle/50 bg-bg-tertiary/30">
              <span className="text-[10px] font-mono text-text-tertiary">{data.command}</span>
            </div>
            <pre className="px-3 py-2 text-[11px] font-mono text-text-primary
              whitespace-pre-wrap break-words overflow-x-auto max-h-60 overflow-y-auto">
              {safeContent(message.content)}
            </pre>
          </div>
        </div>
      );
    }

    return (
      <div className="ml-13 my-1 animate-fade-in">
        <div className="inline-block rounded-lg border border-border-subtle
          bg-bg-secondary/50 overflow-hidden max-w-xs">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs font-semibold text-text-primary">
              {data.title || safeContent(message.content)}
            </span>
          </div>
          {/* Rows */}
          {rows.length > 0 ? (
            <div className="divide-y divide-border-subtle/30">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-3 py-1.5">
                  <span className="text-[11px] text-text-tertiary">{row.label}</span>
                  <span className={`text-[11px] font-mono font-medium
                    ${row.value === '—' ? 'text-text-tertiary/50' : 'text-text-primary'}`}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-tertiary italic">
              {t('cmd.noSessionData')}
            </div>
          )}
          {/* Hint */}
          {data.hint && (
            <div className="px-3 py-1.5 border-t border-border-subtle/50
              text-[10px] text-text-tertiary/70">
              {data.hint}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Help: formatted command list ---
  if (cType === 'help') {
    const builtins: Array<{ name: string; desc: string }> = data.builtins || [];
    return (
      <div className="ml-13 my-1 animate-fade-in">
        <div className="rounded-lg border border-border-subtle
          bg-bg-secondary/50 overflow-hidden max-w-md">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs">📖</span>
            <span className="text-xs font-semibold text-text-primary">
              {safeContent(message.content)}
            </span>
          </div>
          {/* Built-in commands */}
          <div className="p-2 space-y-0.5">
            {builtins.map((cmd, i) => (
              <div key={i} className="flex items-baseline gap-2 px-1.5 py-0.5
                rounded hover:bg-bg-tertiary/40 transition-colors">
                <code className="text-[11px] font-mono text-accent font-medium w-20 flex-shrink-0">
                  {cmd.name}
                </code>
                <span className="text-[11px] text-text-muted truncate">
                  {cmd.desc}
                </span>
              </div>
            ))}
          </div>
          {/* Footer stats */}
          <div className="flex items-center gap-3 px-3 py-1.5
            border-t border-border-subtle/50 text-[10px] text-text-tertiary">
            <span>{t('cmd.helpCustom')}: {data.customCount ?? 0}</span>
            <span>•</span>
            <span>{t('cmd.helpSkills')}: {data.skillCount ?? 0}</span>
          </div>
        </div>
      </div>
    );
  }

  // --- Action feedback: inline with icon/spinner ---
  if (cType === 'action') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-bg-secondary/60 border border-border-subtle text-[11px] text-text-muted">
          {data.loading ? (
            <span className="w-3 h-3 border-2 border-accent/30 border-t-accent
              rounded-full animate-spin" />
          ) : (
            <span className="text-sm">✓</span>
          )}
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- /login：已打开终端，显示当前账号，可手动重新检查 ---
  if (cType === 'login') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="flex flex-col items-center gap-1.5 px-4 py-2.5 rounded-lg
          bg-bg-secondary/60 border border-border-subtle text-[11px] text-text-muted">
          <span>{safeContent(message.content)}</span>
          <AccountStatus />
          <button
            onClick={() => { refreshAccount(true); }}
            className="text-accent hover:underline"
          >
            {t('account.refresh')}
          </button>
        </div>
      </div>
    );
  }

  // --- Error feedback ---
  if (cType === 'error') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-red-500/5 border border-red-500/20 text-[11px] text-red-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
            <circle cx="6" cy="6" r="5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // Fallback: render as plain text
  return (
    <div className="flex justify-center my-1 animate-fade-in">
      <span className="text-[11px] text-text-tertiary">{safeContent(message.content)}</span>
    </div>
  );
}
