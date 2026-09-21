import { useMemo } from 'react';
import { SessionListItem } from '../../lib/tauri-bridge';
import { SessionItem } from './SessionItem';
import { useT } from '../../lib/i18n';

interface SessionGroupProps {
  projectKey: string;
  projectLabel: string;
  projectPath: string;
  sessions: SessionListItem[];
  isExpanded: boolean;
  selectedId: string | null;
  runningSessions: Set<string>;
  pinnedSessions: Set<string>;
  archivedSessions: Set<string>;
  customPreviews: Record<string, string>;
  multiSelect: boolean;
  selectedIds: Set<string>;
  onToggleCollapse: (project: string) => void;
  onContextMenu: (e: React.MouseEvent, session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
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
  projectPath,
  sessions,
  isExpanded,
  selectedId,
  runningSessions,
  pinnedSessions,
  archivedSessions,
  customPreviews,
  multiSelect,
  selectedIds,
  onToggleCollapse,
  onContextMenu,
  onDelete,
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
        <span className="text-[13px] font-extrabold text-text-primary
          truncate flex-1 text-left min-w-0">
          {label}
        </span>
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

      {/* Project path */}
      {isExpanded && projectKey !== label && (
        <div className="px-7 pb-0.5">
          <span className="text-[10px] text-text-tertiary truncate block">
            {projectPath}
          </span>
        </div>
      )}

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
                  onDelete={onDelete}
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

          {unpinnedItems.map((session) => (
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
              onDelete={onDelete}
              onToggleCheck={onToggleCheck}
              triggerRename={renamingSessionId === session.id}
              onRenameDone={onRenameDone}
              isHighlighted={highlightedSessionId === session.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
