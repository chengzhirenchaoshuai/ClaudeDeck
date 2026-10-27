// 顶部栏的 Git 小标签：当前分支 + 未提交改动数，gh 登录有问题时标出提醒色；点击展开详情。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { finishedSessionIds } from '../../lib/session-finish';
import { ghHintKey, ghNeedsAttention, type GitInfo } from '../../lib/git-info';

const LOGIN_CMD = 'gh auth login -h github.com --web --git-protocol https';

// 按项目路径缓存，切换标签页时先显示上次结果，避免闪烁
const cache = new Map<string, GitInfo>();

function useGitInfo(cwd: string) {
  const [info, setInfo] = useState<GitInfo | null>(() => (cwd ? cache.get(cwd) ?? null : null));
  const [loading, setLoading] = useState(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const refresh = useCallback(async () => {
    const target = cwdRef.current;
    if (!target) return;
    setLoading(true);
    try {
      const result = await bridge.getGitInfo(target);
      cache.set(target, result);
      // 读取期间已切换到其他项目时丢弃结果
      if (cwdRef.current === target) setInfo(result);
    } catch (e) {
      console.warn('[ClaudeDeck] get_git_info failed:', e);
      if (cwdRef.current === target) setInfo(null);
    } finally {
      if (cwdRef.current === target) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setInfo(cwd ? cache.get(cwd) ?? null : null);
    setLoading(false);
    void refresh();
    // 一轮对话结束后分支和改动可能变化，稍等片刻再刷新
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.runningSessions === prev.runningSessions) return;
      if (finishedSessionIds(prev.runningSessions, state.runningSessions).length > 0) {
        setTimeout(() => { void refresh(); }, 1500);
      }
    });
    return unsubscribe;
  }, [cwd, refresh]);

  return { info, loading, refresh };
}

function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1" title={title}>
      <span className="w-20 flex-shrink-0 text-text-tertiary">{label}</span>
      <div className="min-w-0 flex-1 text-text-primary break-all">{children}</div>
    </div>
  );
}

function CommandLine({ command, t }: { command: string; t: (k: string) => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <code className="flex-1 min-w-0 px-2 py-1 rounded bg-bg-tertiary text-text-primary break-all select-text">
        {command}
      </code>
      <button
        onClick={() => navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => {})}
        className="flex-shrink-0 px-2 py-1 rounded border border-border-subtle bg-bg-card
          hover:bg-accent/10 hover:text-accent transition-smooth"
      >
        {copied ? t('git.copied') : t('git.copy')}
      </button>
    </div>
  );
}

export function GitChip() {
  const t = useT();
  const cwd = useSettingsStore((s) => s.workingDirectory) ?? '';
  const { info, loading, refresh } = useGitInfo(cwd);
  const [open, setOpen] = useState(false);
  // 弹层经 Portal 挂到 body 并按按钮位置 fixed 定位：顶栏所在的祖先形成了层叠上下文，
  // 留在顶栏里的弹层无论 z-index 多大都会被消息区里的代码片段、气泡等盖住
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  if (!info?.is_repo) return null;

  const isRemote = cwd.startsWith('ssh://');
  const hintKey = ghHintKey(info, isRemote);
  const attention = ghNeedsAttention(info);
  const scope = (s: string | null) => (s ? ` · ${t('git.scope').replace('{scope}', s)}` : '');
  const ghState = info.gh_status === 'authenticated' && info.gh_token_invalid
    ? t('git.gh.tokenInvalid')
    : t(`git.gh.${info.gh_status}`);

  const toggle = () => {
    if (!open) {
      void refresh();
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setOpen(!open);
  };

  return (
    <div className="relative hidden md:block ml-2">
      <button
        ref={buttonRef}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg
          bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary
          hover:text-text-primary hover:bg-bg-secondary transition-smooth"
        title={t('git.title')}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round">
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="5.5" r="1.5" />
          <path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 4" />
        </svg>
        <span className="max-w-[140px] truncate">{info.branch}</span>
        {info.changed_files > 0 && <span className="text-warning">●{info.changed_files}</span>}
        {attention && <span className="w-1.5 h-1.5 rounded-full bg-warning" />}
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div className="fixed z-[9999] w-80 max-h-[70vh] overflow-y-auto p-3 rounded-xl
            border border-border-subtle bg-bg-primary shadow-lg text-[11px] animate-fade-in"
            style={{ top: pos.top, right: pos.right }}>
            <div className="flex items-center mb-1.5">
              <span className="font-medium text-text-primary">{t('git.title')}</span>
              <button
                onClick={() => void refresh()}
                disabled={loading}
                className="ml-auto px-2 py-0.5 rounded text-text-tertiary hover:text-accent
                  hover:bg-accent/10 transition-smooth disabled:opacity-50"
              >
                {loading ? t('git.loading') : t('git.refresh')}
              </button>
            </div>

            <Row label={t('git.branch')}>{info.branch}</Row>
            <Row label={t('git.mainBranch')}>{info.main_branch}</Row>
            <Row label={t('git.changes')}>
              {info.changed_files > 0
                ? t('git.changesCount').replace('{n}', String(info.changed_files))
                : t('git.clean')}
            </Row>
            <Row label={t('git.commitAs')} title={t('git.commitAsHint')}>
              {info.user_name ?? <span className="text-text-tertiary">{t('git.notSet')}</span>}
              {info.user_name && <span className="text-text-tertiary">{scope(info.user_name_scope)}</span>}
              {info.user_email && (
                <div className="text-text-secondary">
                  {info.user_email}
                  <span className="text-text-tertiary">{scope(info.user_email_scope)}</span>
                </div>
              )}
            </Row>
            <Row label={t('git.ghAccount')} title={t('git.ghAccountHint')}>
              {info.gh_account && <span>{info.gh_account} · </span>}
              <span className={attention ? 'text-warning' : 'text-success'}>{ghState}</span>
            </Row>
            {info.remote_url && <Row label={t('git.remoteUrl')}>{info.remote_url}</Row>}

            {hintKey && (
              <div className="mt-2 p-2 rounded-lg bg-warning/10 text-text-secondary">
                <div>{t(hintKey)}</div>
                {hintKey === 'git.hint.ghUnknown' && info.gh_error && (
                  <div className="mt-1 text-text-tertiary break-all">{info.gh_error}</div>
                )}
                {(hintKey === 'git.hint.ghLogin' || hintKey === 'git.hint.tokenInvalid') && (
                  <CommandLine command={LOGIN_CMD} t={t} />
                )}
                {hintKey === 'git.hint.sshKeyring' && (
                  <CommandLine command={`${LOGIN_CMD} --insecure-storage`} t={t} />
                )}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
