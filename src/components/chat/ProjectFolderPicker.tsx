import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { bridge } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore, useActiveTab } from '../../stores/chatStore';
import { useT } from '../../lib/i18n';

/** 路径最后一段，作为文件夹名 */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * 输入框里的“对话文件夹”选择：点击展开当前已有的项目文件夹（取自已有会话，按最近使用排序），
 * 选中后作为本次新对话的工作目录。本机环境下另有“选择其他文件夹…”打开系统文件夹选择框。
 * 已经有对话内容或任务正在运行时，文件夹固定，只显示不可切换。
 */
export function ProjectFolderPicker({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const sessions = useSessionStore((s) => s.sessions);
  const hasMessages = useActiveTab((tab) => tab.messages.length > 0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const locked = disabled || hasMessages;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 当前环境（本地 / 某台远程主机）下已有的项目，按最近使用排序
  const projects = useMemo(() => {
    const latest = new Map<string, number>();
    for (const s of sessions) {
      const inEnv = activeEnv === 'local' ? !s.host : s.host === activeEnv;
      if (!inEnv || !s.project) continue;
      latest.set(s.project, Math.max(latest.get(s.project) || 0, s.modifiedAt));
    }
    if (workingDirectory && !latest.has(workingDirectory)) latest.set(workingDirectory, 0);
    return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
  }, [sessions, activeEnv, workingDirectory]);

  const choose = (path: string) => {
    setOpen(false);
    if (path === workingDirectory) return;
    const tabId = useSessionStore.getState().selectedSessionId;
    // 预热进程是在旧目录里启动的，换目录后必须丢弃，否则首条消息会在旧目录里运行
    const stdinId = tabId ? useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId : undefined;
    if (tabId && stdinId) {
      bridge.killSession(stdinId).catch(() => {});
      const unlisten = (window as any).__claudeUnlisteners?.[stdinId];
      if (unlisten) {
        unlisten();
        delete (window as any).__claudeUnlisteners[stdinId];
      }
      useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined, envFingerprint: undefined });
    }
    useSettingsStore.getState().setWorkingDirectory(path);
    // 已存在草稿（还没发过消息）时，同步更新草稿所属的项目
    if (tabId && useSessionStore.getState().sessions.some((s) => s.id === tabId && s.path === '')) {
      useSessionStore.getState().updateDraftProject(tabId, path);
    }
  };

  const browse = async () => {
    setOpen(false);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('input.selectFolder'),
        defaultPath: workingDirectory || undefined,
      });
      if (typeof selected === 'string' && selected) choose(selected);
    } catch (error) {
      console.warn('[ProjectFolderPicker] failed to pick folder', error);
    }
  };

  const label = workingDirectory ? folderName(workingDirectory) : t('input.projectFolder');

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={locked}
        className="inline-flex items-center gap-1.5 max-w-[220px] px-2 py-1 rounded-lg text-xs
          text-text-secondary hover:text-text-primary hover:bg-bg-secondary
          disabled:opacity-40 disabled:cursor-not-allowed transition-smooth"
        title={workingDirectory || t('input.selectFolder')}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          className="flex-shrink-0">
          <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" />
          <path d="M2.5 4.5v-1h4.4l1.1 1.3" />
        </svg>
        <span className="truncate">{label}</span>
        {!locked && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round"
            className={`flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
            <path d="M1.5 3L4 5.5 6.5 3" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-[320px] max-h-[280px] overflow-y-auto
          bg-bg-card border border-border-subtle rounded-lg shadow-lg py-1 z-50 animate-fade-in">
          {projects.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-tertiary">{t('input.noProjects')}</div>
          )}
          {projects.map((path) => {
            const active = path === workingDirectory;
            return (
              <button
                key={path}
                onClick={() => choose(path)}
                title={path}
                className={`w-full text-left px-3 py-1.5 transition-smooth
                  ${active ? 'bg-accent/10' : 'hover:bg-bg-secondary'}`}
              >
                <div className={`text-xs font-medium truncate ${active ? 'text-accent' : 'text-text-primary'}`}>
                  {folderName(path)}
                </div>
                <div className="text-[10px] text-text-tertiary truncate">{path}</div>
              </button>
            );
          })}
          {activeEnv === 'local' && (
            <>
              <div className="my-1 border-t border-border-subtle" />
              <button
                onClick={browse}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted
                  hover:bg-bg-secondary hover:text-text-primary transition-smooth"
              >
                {t('input.browseFolder')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
