import { useEffect, useMemo, useState } from 'react';
import { SessionListItem } from '../../lib/tauri-bridge';
import { SessionItem, AwaitingDot } from './SessionItem';
import { useChatStore } from '../../stores/chatStore';
import { useT } from '../../lib/i18n';

/** 项目展开后默认显示的会话数 */
const COLLAPSED_LIMIT = 5;

interface SessionGroupProps {
  projectKey: string;
  projectLabel: string;
  sessions: SessionListItem[];
  isExpanded: boolean;
  selectedId: string | null;
  runningSessions: Set<string>;
  pinnedSessions: Set<string>;
  archivedSessions: Set<string>;
  customPreviews: Record<string, string>;
  multiSelect: boolean;
  /** 不折叠，显示全部会话（多选、搜索时用，避免选中或匹配到看不见的会话） */
  showAll?: boolean;
  selectedIds: Set<string>;
  onToggleCollapse: (project: string) => void;
  onContextMenu: (e: React.MouseEvent, session: SessionListItem) => void;
  onPin: (session: SessionListItem) => void;
  unreadSessions: Set<string>;
  /** 该项目是否被置顶 */
  isPinned?: boolean;
  /** 该项目已在本机隐藏（临时显示隐藏项目时才会渲染出来） */
  isHidden?: boolean;
  onProjectContextMenu: (e: React.MouseEvent, project: string) => void;
  onLoadSession: (session: SessionListItem) => void;
  onRename: (sessionId: string, newName: string) => void;
  onNewSession: (project: string) => void;
  onToggleCheck: (sessionId: string, shiftKey?: boolean) => void;
  renamingSessionId?: string | null;
  onRenameDone?: () => void;
  highlightedSessionId?: string | null;
}

export function SessionGroup({
  projectKey,
  projectLabel: label,
  sessions,
  isExpanded,
  selectedId,
  runningSessions,
  pinnedSessions,
  archivedSessions,
  customPreviews,
  multiSelect,
  showAll,
  selectedIds,
  onToggleCollapse,
  onContextMenu,
  onPin,
  unreadSessions,
  isPinned,
  isHidden,
  onProjectContextMenu,
  onLoadSession,
  onRename,
  onNewSession,
  onToggleCheck,
  renamingSessionId,
  onRenameDone,
  highlightedSessionId,
}: SessionGroupProps) {
  const t = useT();

  // 置顶的会话排在前面，其余保持传入顺序（调用方已按修改时间从新到旧排序）
  const { pinnedItems, unpinnedItems } = useMemo(() => {
    const pinned: SessionListItem[] = [];
    const unpinned: SessionListItem[] = [];
    for (const s of sessions) {
      (pinnedSessions.has(s.id) ? pinned : unpinned).push(s);
    }
    return { pinnedItems: pinned, unpinnedItems: unpinned };
  }, [sessions, pinnedSessions]);

  const [showMore, setShowMore] = useState(false);
  // 项目里有会话在等用户选择：收起时也要在项目标题上提示
  const hasAwaiting = useChatStore((s) =>
    sessions.some((x) => s.tabs.get(x.id)?.activityStatus.phase === 'awaiting'));
  const expandAll = showAll || showMore;
  // 项目收起时一并收起“其余会话”：下次点开项目仍只显示前几个，不用拉到列表末尾去点“收起”
  useEffect(() => {
    if (!isExpanded) setShowMore(false);
  }, [isExpanded]);

  // 默认只显示前 COLLAPSED_LIMIT 个（置顶的始终显示并计入名额）；
  // 超出部分里正在选中、运行中或被定位高亮的会话也保留，避免当前会话“消失”
  const visibleUnpinned = useMemo(() => {
    if (expandAll) return unpinnedItems;
    const quota = Math.max(0, COLLAPSED_LIMIT - pinnedItems.length);
    return unpinnedItems.filter((s, i) =>
      i < quota
      || s.id === selectedId
      || s.id === highlightedSessionId
      || runningSessions.has(s.id));
  }, [expandAll, unpinnedItems, pinnedItems.length, selectedId, highlightedSessionId, runningSessions]);
  const hiddenCount = unpinnedItems.length - visibleUnpinned.length;
  const canCollapse = !showAll && showMore
    && pinnedItems.length + unpinnedItems.length > COLLAPSED_LIMIT;

  const getDisplayName = (session: SessionListItem) =>
    customPreviews[session.id] || session.preview || '';

  return (
    <div className="mb-1">
      {/* Project header */}
      <div
        onClick={() => onToggleCollapse(projectKey)}
        onContextMenu={(e) => onProjectContextMenu(e, projectKey)}
        className="w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer
          hover:bg-bg-secondary rounded-lg transition-smooth group"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapse(projectKey); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`text-accent transition-transform flex-shrink-0
            ${isExpanded ? 'rotate-90' : ''}`}>
          <path d="M3 1l4 4-4 4" />
        </svg>
        <span className={`text-[13px] font-extrabold truncate flex-1 text-left min-w-0
          ${isHidden ? 'text-text-tertiary' : 'text-text-primary'}`}>
          {label}
        </span>
        {isHidden && (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className="flex-shrink-0 text-text-tertiary">
            <title>{t('conv.hiddenProjectBadge')}</title>
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
            <path d="M2.5 2.5l11 11" />
          </svg>
        )}
        {isPinned && (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className="flex-shrink-0 text-accent">
            <path d="M9.5 2L14 6.5L8.5 12L6 14L4.5 11.5L2 9.5L4 7.5L9.5 2z" />
          </svg>
        )}
        {!isExpanded && hasAwaiting ? (
          <AwaitingDot title={t('conv.awaitingHint')} />
        ) : !isExpanded && sessions.some((s) => unreadSessions.has(s.id)) && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-accent" title={t('conv.unread')} />
        )}
        <span className="text-[11px] text-text-tertiary flex-shrink-0">
          {sessions.length} {t('conv.sessions')}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onNewSession(projectKey); }}
          className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100
            hover:bg-bg-tertiary transition-smooth text-text-tertiary hover:text-accent"
          title={t('conv.newChat')}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>

      {/* Sessions */}
      {isExpanded && (
        <div>
          {/* Pinned sessions */}
          {pinnedItems.length > 0 && (
            <>
              {pinnedItems.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={selectedId === session.id}
                  isRunning={runningSessions.has(session.id)}
                  isPinned={true}
                  isArchived={archivedSessions.has(session.id)}
                  displayName={getDisplayName(session)}
                  multiSelect={multiSelect}
                  isChecked={selectedIds.has(session.id)}
                  onSelect={onLoadSession}
                  onContextMenu={onContextMenu}
                  onRename={onRename}
                  onPin={onPin}
                  isUnread={unreadSessions.has(session.id)}
                  onToggleCheck={onToggleCheck}
                  triggerRename={renamingSessionId === session.id}
                  onRenameDone={onRenameDone}
                  isHighlighted={highlightedSessionId === session.id}
                />
              ))}
              {unpinnedItems.length > 0 && (
                <div className="my-1 mx-7 border-t border-border-subtle/50" />
              )}
            </>
          )}

          {visibleUnpinned.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isSelected={selectedId === session.id}
              isRunning={runningSessions.has(session.id)}
              isPinned={false}
              isArchived={archivedSessions.has(session.id)}
              displayName={getDisplayName(session)}
              multiSelect={multiSelect}
              isChecked={selectedIds.has(session.id)}
              onSelect={onLoadSession}
              onContextMenu={onContextMenu}
              onRename={onRename}
              onPin={onPin}
              isUnread={unreadSessions.has(session.id)}
              onToggleCheck={onToggleCheck}
              triggerRename={renamingSessionId === session.id}
              onRenameDone={onRenameDone}
              isHighlighted={highlightedSessionId === session.id}
            />
          ))}

          {/* 展开 / 收起其余会话 */}
          {(hiddenCount > 0 || canCollapse) && (
            <button
              onClick={() => setShowMore(!showMore)}
              className="w-full flex items-center gap-1.5 pl-7 pr-3 py-1 rounded-lg
                text-[11px] text-text-tertiary hover:text-accent hover:bg-bg-secondary
                transition-smooth text-left"
            >
              <svg width="8" height="8" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5"
                className={`flex-shrink-0 transition-transform ${showMore ? '-rotate-90' : 'rotate-90'}`}>
                <path d="M3 1l4 4-4 4" />
              </svg>
              {hiddenCount > 0
                ? t('conv.showMore').replace('{n}', String(hiddenCount))
                : t('conv.showLess')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
