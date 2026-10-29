import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SessionListItem } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';

/** 菜单与窗口边缘的最小间距 */
const MENU_MARGIN = 8;

/**
 * 让右键菜单始终完整显示在窗口内：渲染后（绘制前）测量菜单尺寸，
 * 下方放不下就翻到光标上方，右侧放不下就翻到光标左侧，最后再夹到窗口范围内。
 */
function useMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 用 offset 尺寸而非 getBoundingClientRect：后者会受淡入动画的 scale 影响而偏小
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const maxLeft = window.innerWidth - width - MENU_MARGIN;
    const maxTop = window.innerHeight - height - MENU_MARGIN;
    let left = x > maxLeft ? x - width : x;
    let top = y > maxTop ? y - height : y;
    left = Math.max(MENU_MARGIN, Math.min(left, maxLeft));
    top = Math.max(MENU_MARGIN, Math.min(top, maxTop));
    setPos({ left, top });
  }, [x, y]);

  return { ref, pos };
}

interface SessionContextMenuProps {
  x: number;
  y: number;
  session: SessionListItem;
  onRename: (session: SessionListItem) => void;
  onRevealInFinder: (session: SessionListItem) => void;
  onExport: (session: SessionListItem) => void;
  onCopyResumeCommand: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  onPin?: (session: SessionListItem) => void;
  onArchive?: (session: SessionListItem) => void;
  onLocateInFolder?: (session: SessionListItem) => void;
  onSelectMode?: (session: SessionListItem) => void;
  onToggleUnread?: (session: SessionListItem) => void;
  isPinned?: boolean;
  isArchived?: boolean;
  isUnread?: boolean;
  onClose: () => void;
}

export function SessionContextMenu({
  x,
  y,
  session,
  onRename,
  onRevealInFinder,
  onExport,
  onCopyResumeCommand,
  onDelete,
  onPin,
  onArchive,
  onLocateInFolder,
  onSelectMode,
  onToggleUnread,
  isPinned,
  isArchived,
  isUnread,
  onClose,
}: SessionContextMenuProps) {
  const t = useT();
  const { ref: menuRef, pos } = useMenuPosition(x, y);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, menuRef]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] py-1.5 rounded-xl
        bg-bg-card border border-border-subtle shadow-xl animate-fade-in"
      style={pos}
    >
      <button
        onClick={() => { onClose(); onRename(session); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5
          text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
        </svg>
        {t('conv.rename')}
      </button>

      {onPin && (
        <button
          onClick={() => { onClose(); onPin(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2L14 6.5L8.5 12L6 14L4.5 11.5L2 9.5L4 7.5L9.5 2z" />
            <path d="M4.5 11.5L1.5 14.5" />
          </svg>
          {isPinned ? t('conv.unpin') : t('conv.pin')}
        </button>
      )}

      {onArchive && (
        <button
          onClick={() => { onClose(); onArchive(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="14" height="4" rx="1" />
            <path d="M2 6v7a1 1 0 001 1h10a1 1 0 001-1V6" />
            <path d="M6 9h4" />
          </svg>
          {isArchived ? t('conv.unarchive') : t('conv.archive')}
        </button>
      )}

      {onSelectMode && (
        <button
          onClick={() => { onClose(); onSelectMode(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
          {t('conv.selectMode')}
        </button>
      )}

      {onToggleUnread && (
        <button
          onClick={() => { onClose(); onToggleUnread(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3" fill={isUnread ? 'none' : 'currentColor'} />
            <circle cx="8" cy="8" r="6" />
          </svg>
          {isUnread ? t('conv.markRead') : t('conv.markUnread')}
        </button>
      )}

      {onLocateInFolder && (
        <button
          onClick={() => { onClose(); onLocateInFolder(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h4l2 2h6v7H2V4z" />
            <circle cx="8" cy="9" r="2" />
            <path d="M9.5 10.5L11 12" />
          </svg>
          {t('conv.locateInFolder')}
        </button>
      )}

      {session.path && !session.host && (
        <button
          onClick={() => { onClose(); onRevealInFinder(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 4h4l2 2h6v7H2V4z" />
          </svg>
          {t('conv.revealInFinder')}
        </button>
      )}

      {session.path && (
        <button
          onClick={() => { onClose(); onExport(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 14h8M8 2v9M5 8l3 3 3-3" />
          </svg>
          {t('conv.export')}
        </button>
      )}

      {session.path && (
        <button
          onClick={() => { onClose(); onCopyResumeCommand(session); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4l4 4-4 4M8 12h5" />
          </svg>
          {t('conv.copyResumeCommand')}
        </button>
      )}

      <div className="my-1 border-t border-border-subtle" />

      <button
        onClick={() => { onClose(); onDelete(session); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5
          text-xs text-red-500 hover:bg-red-500/10 transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
        </svg>
        {t('conv.delete')}
      </button>
    </div>,
    document.body,
  );
}

/** Project-level context menu */
interface ProjectContextMenuProps {
  x: number;
  y: number;
  project: string;
  onNewSession: (project: string) => void;
  onDeleteAll: (project: string) => void;
  onPin?: (project: string) => void;
  /** 在本机隐藏 / 取消隐藏该项目 */
  onToggleHidden?: (project: string) => void;
  isHidden?: boolean;
  onOpenInExplorer?: (project: string) => void;
  onLoadAll?: (project: string) => void;
  isLoadingAll?: boolean;
  isPinned?: boolean;
  onClose: () => void;
}

export function ProjectContextMenu({
  x,
  y,
  project,
  onNewSession,
  onDeleteAll,
  onPin,
  onToggleHidden,
  isHidden,
  onOpenInExplorer,
  onLoadAll,
  isLoadingAll,
  isPinned,
  onClose,
}: ProjectContextMenuProps) {
  const t = useT();
  const { ref: menuRef, pos } = useMenuPosition(x, y);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, menuRef]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] py-1.5 rounded-xl
        bg-bg-card border border-border-subtle shadow-xl animate-fade-in"
      style={pos}
    >
      <button
        onClick={() => { onClose(); onNewSession(project); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5
          text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t('conv.newChat')}
      </button>

      {onPin && (
        <button
          onClick={() => { onClose(); onPin(project); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2L14 6.5L8.5 12L6 14L4.5 11.5L2 9.5L4 7.5L9.5 2z" />
            <path d="M4.5 11.5L1.5 14.5" />
          </svg>
          {isPinned ? t('conv.unpinProject') : t('conv.pinProject')}
        </button>
      )}

      {onToggleHidden && (
        <button
          onClick={() => { onClose(); onToggleHidden(project); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
            {!isHidden && <path d="M2.5 2.5l11 11" />}
          </svg>
          {isHidden ? t('conv.unhideProject') : t('conv.hideProject')}
        </button>
      )}

      {onOpenInExplorer && (
        <div className="my-1 border-t border-border-subtle" />
      )}

      {onOpenInExplorer && (
        <button
          onClick={() => { onClose(); onOpenInExplorer(project); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h4l2 2h6v7H2V4z" />
            <path d="M8 11v-3M6 9h4" />
          </svg>
          {t('conv.openInExplorer')}
        </button>
      )}

      {onLoadAll && (
        <button
          onClick={() => { onClose(); onLoadAll(project); }}
          disabled={isLoadingAll}
          className="w-full flex items-center gap-2.5 px-3 py-1.5
            text-xs text-text-primary hover:bg-bg-secondary transition-smooth disabled:opacity-50"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className={isLoadingAll ? 'animate-spin' : ''}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          {t('conv.loadAll')}
        </button>
      )}

      <div className="my-1 border-t border-border-subtle" />

      <button
        onClick={() => { onClose(); onDeleteAll(project); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5
          text-xs text-red-500 hover:bg-red-500/10 transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
        </svg>
        {t('conv.deleteAll')}
      </button>
    </div>,
    document.body,
  );
}
