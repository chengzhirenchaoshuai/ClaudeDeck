import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { bridge, SessionListItem, onCliSessionsChanged } from '../../lib/tauri-bridge';
import { applyDiskSession, syncSession } from '../../lib/session-sync';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { SessionGroup } from './SessionGroup';
import { SessionItem } from './SessionItem';
import { SessionContextMenu, ProjectContextMenu } from './SessionContextMenu';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

// --- Path utilities ---

let _cachedHomeDir: string | null = null;
bridge.getHomeDir().then((h) => { _cachedHomeDir = h; }).catch(() => {});

function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

function resolveProjectPath(raw: string): string {
  if (raw.startsWith('ssh://')) return raw;
  if (raw.startsWith('/') || isWindowsAbsolutePath(raw)) return raw;
  if (raw.startsWith('~/') || raw === '~') {
    if (_cachedHomeDir) return raw.replace('~', _cachedHomeDir);
    return raw;
  }
  if (/^[A-Za-z]-/.test(raw)) {
    const drive = raw[0];
    const rest = raw.slice(2);
    return `${drive}:\\${rest.replace(/-/g, '\\')}`;
  }
  return raw.replace(/-/g, '/');
}

function normalizeProjectKey(raw: string): string {
  const unix = raw.match(/^\/(?:Users|home)\/[^/]+(\/.*)/);
  if (unix) return '~' + unix[1];
  const win = raw.match(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+([/\\].*)/i);
  if (win) return '~' + win[1];
  return raw;
}

/** Extract display label from a project key.
 *  When `parentHint` is true (duplicate names), appends parent folder:
 *  "A (Desktop)" vs "A (坚果云)" */
function projectLabel(project: string, parentHint?: boolean): string {
  const parts = project.replace(/^~[\\/]/, '').split(/[\\/]/);
  const name = parts[parts.length - 1] || project;
  if (parentHint && parts.length >= 2) {
    return `${name} (${parts[parts.length - 2]})`;
  }
  return name;
}

// --- Context menu types ---

interface ContextMenuState {
  x: number;
  y: number;
  session: SessionListItem;
}

interface ProjectMenuState {
  x: number;
  y: number;
  project: string;
}

// --- Main component ---

export function ConversationList() {
  const t = useT();

  // Store subscriptions
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const setSelected = useSessionStore((s) => s.setSelectedSession);
  const customPreviews = useSessionStore((s) => s.customPreviews);
  const setCustomPreview = useSessionStore((s) => s.setCustomPreview);
  const runningSessions = useSessionStore((s) => s.runningSessions);
  const unreadSessions = useSessionStore((s) => s.unreadSessions);
  const contentSearchResults = useSessionStore((s) => s.contentSearchResults);
  const isContentSearching = useSessionStore((s) => s.isContentSearching);
  const searchSessionContent = useSessionStore((s) => s.searchSessionContent);
  const clearContentSearch = useSessionStore((s) => s.clearContentSearch);
  const remoteHosts = useSessionStore((s) => s.remoteHosts);
  const remoteSessionsList = useSessionStore((s) => s.remoteSessions);

  // Context menus
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | null>(null);
  const [deleteAllTarget, setDeleteAllTarget] = useState<{
    projectKey: string;
    count: number;
  } | null>(null);

  // Shift+click multi-select: track last clicked index
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Smart collapse (Phase 2)
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(new Set());

  // Pinned & archived (Phase 3)
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_pinned_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });
  const [archivedSessions, setArchivedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_archived_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });
  const [showArchived, setShowArchived] = useState(false);

  // View mode: 'folder' | 'recent'
  const [viewMode, setViewMode] = useState<'folder' | 'recent'>(() => {
    try {
      const saved = localStorage.getItem('tokenicode_conversation_view_mode');
      return saved === 'recent' ? 'recent' : 'folder';
    } catch { return 'folder'; }
  });

  // Highlight a session (for "Locate in Folder" flash)
  const [highlightedSessionId, setHighlightedSessionId] = useState<string | null>(null);

  // Ref map for project group scrolling
  const projectGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Multi-select
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ESC to cancel multi-select
  useEffect(() => {
    if (!multiSelect) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMultiSelect(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [multiSelect]);

  // Persist pinned/archived
  const persistPinned = useCallback((next: Set<string>) => {
    setPinnedSessions(next);
    localStorage.setItem('tokenicode_pinned_sessions', JSON.stringify([...next]));
    bridge.savePinnedSessions([...next]).catch(() => {});
  }, []);

  const persistArchived = useCallback((next: Set<string>) => {
    setArchivedSessions(next);
    localStorage.setItem('tokenicode_archived_sessions', JSON.stringify([...next]));
    bridge.saveArchivedSessions([...next]).catch(() => {});
  }, []);

  // 归档和改名一样是 ClaudeDeck 自己的概念，claude CLI 没有这个功能，本机只存在
  // ~/.tokenicode/archived.json 里。远程会话的归档状态额外写一份到远程主机自己的
  // CLAUDE_CONFIG_DIR 下，让远程主机成为源端：每次远程会话列表刷新（不管是哪里
  // 触发的，比如侧边栏“刷新”按钮），这里都会重新拉取每台主机自己的归档文件，
  // 用远程数据覆盖本地对应会话的归档状态（含“远程那边取消归档了”这种减法）。
  useEffect(() => {
    if (remoteHosts.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        remoteHosts.map((h) => bridge.loadRemoteArchivedSessions(h.id)),
      );
      if (cancelled) return;
      setArchivedSessions((current) => {
        const next = new Set(current);
        let changed = false;
        remoteHosts.forEach((h, i) => {
          const r = results[i];
          if (r.status !== 'fulfilled') return;
          const remoteIds = new Set(r.value);
          for (const s of remoteSessionsList) {
            if (s.host !== h.id) continue;
            const shouldBeArchived = remoteIds.has(s.id);
            if (shouldBeArchived !== next.has(s.id)) {
              changed = true;
              if (shouldBeArchived) next.add(s.id);
              else next.delete(s.id);
            }
          }
        });
        if (!changed) return current;
        localStorage.setItem('tokenicode_archived_sessions', JSON.stringify([...next]));
        bridge.saveArchivedSessions([...next]).catch(() => {});
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [remoteHosts, remoteSessionsList]);

  // 归档一个远程会话时，把这台主机名下的全部归档 ID 写回它自己的归档文件
  const pushArchivedToRemote = useCallback((session: SessionListItem, archivedIds: Set<string>) => {
    if (!session.host) return;
    const hostId = session.host;
    const hostArchived = remoteSessionsList
      .filter((s) => s.host === hostId && archivedIds.has(s.id))
      .map((s) => s.id);
    bridge.saveRemoteArchivedSessions(hostId, hostArchived).catch(() => {});
  }, [remoteSessionsList]);

  // Load pinned/archived from backend on init
  useEffect(() => {
    // 磁盘文件是权威来源（本地存储只是快速缓存）：文件存在时，即使为空也以它为准，
    // 这样清空磁盘记录后，界面不会被旧的本地缓存带回去
    bridge.loadPinnedSessions?.()
      .then((data: string[] | null) => {
        if (Array.isArray(data)) {
          setPinnedSessions(new Set(data));
          localStorage.setItem('tokenicode_pinned_sessions', JSON.stringify(data));
        }
      })
      .catch(() => {});
    bridge.loadArchivedSessions?.()
      .then((data: string[] | null) => {
        if (Array.isArray(data)) {
          setArchivedSessions(new Set(data));
          localStorage.setItem('tokenicode_archived_sessions', JSON.stringify(data));
        }
      })
      .catch(() => {});
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchSessions().then(() => {
      const currentSelected = useSessionStore.getState().selectedSessionId;
      if (!currentSelected) {
        const lastId = useSessionStore.getState().getLastSessionId();
        if (lastId) {
          const sessions = useSessionStore.getState().sessions;
          const match = sessions.find((s) => s.id === lastId);
          if (match) {
            handleLoadSession(match);
          }
        }
      }
    });
    // 远程会话经 ssh 读取较慢，只在启动时拉取一次，之后在设置的“远程连接”里手动刷新
    useSessionStore.getState().fetchRemoteSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => clearInterval(interval);
  }, []);

  // CLI 会话目录变化（含终端里直接运行的 claude）：刷新列表，并同步已打开的会话
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let running = false;
    let pending = false;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

    const currentSession = () => {
      const st = useSessionStore.getState();
      return st.sessions.find((s) => s.id === st.selectedSessionId);
    };
    // 同一时刻只同步一次；期间又有变化则在 2 秒后再补一次，避免大会话被高频重复解析
    const syncCurrent = async () => {
      if (running) { pending = true; return; }
      running = true;
      try {
        await syncSession(currentSession());
      } finally {
        running = false;
        if (pending) { pending = false; setTimeout(syncCurrent, 2000); }
      }
    };

    onCliSessionsChanged((paths) => {
      fetchSessions();
      const cur = currentSession();
      if (cur?.path && !cur.host && paths.some((p) => norm(p) === norm(cur.path))) {
        syncCurrent();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [fetchSessions]);

  // 当前打开的会话短周期轮询：覆盖不了文件系统事件的场景（远程会话、
  // 由外部终端而非本应用驱动的会话）。syncSession 内部已经做了“未变化跳过”
  // 和“本应用正在驱动则不覆盖”的保护，这里高频调用成本很低。
  useEffect(() => {
    const interval = setInterval(() => {
      const st = useSessionStore.getState();
      const current = st.sessions.find((s) => s.id === st.selectedSessionId);
      void syncSession(current);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Listen for sessions:changed event for instant refresh
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('sessions:changed', () => {
      fetchSessions();
      // 远程会话没有目录监听，会话进程结束时顺带刷新远程列表
      if (useSettingsStore.getState().activeEnv !== 'local') {
        useSessionStore.getState().fetchRemoteSessions();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [fetchSessions]);

  // Debounce content search: 300ms after searchQuery changes, ≥2 chars
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      clearContentSearch();
      return;
    }
    const timer = setTimeout(() => {
      searchSessionContent(searchQuery.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSessionContent, clearContentSearch]);

  // Display name resolver
  const displayName = useCallback((session: SessionListItem) => {
    return customPreviews[session.id] || session.preview || '';
  }, [customPreviews]);

  // Filtered sessions (search + archive)
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const filtered = useMemo(() => {
    // 本地与远程模式互相隔离：只显示当前环境的会话
    let result = sessions.filter((s) => (activeEnv === 'local' ? !s.host : s.host === activeEnv));

    // Archive filter: OFF = hide archived, ON = show ONLY archived
    if (showArchived) {
      result = result.filter((s) => archivedSessions.has(s.id));
    } else {
      result = result.filter((s) => !archivedSessions.has(s.id));
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          displayName(s).toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q)
      );
    }

    return result;
  }, [sessions, searchQuery, displayName, showArchived, archivedSessions, activeEnv]);

  // Group by project
  const projectGroups = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const raw = s.project || s.projectDir;
      const key = normalizeProjectKey(raw);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const items of map.values()) {
      items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const pa = pinnedSessions.has(`project:${a[0]}`) ? 1 : 0;
      const pb = pinnedSessions.has(`project:${b[0]}`) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ta = a[1][0]?.modifiedAt || 0;
      const tb = b[1][0]?.modifiedAt || 0;
      return tb - ta;
    });
    return entries;
  }, [filtered, pinnedSessions]);

  // 最近活跃视图：按修改时间从新到旧平铺。会话置顶只在所属项目内生效（文件夹视图），
  // 这里不跨项目把置顶会话排到整个列表最前，只在标题前显示图钉
  const recentlyActiveGroups = useMemo(() => {
    const others = [...filtered].sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { others };
  }, [filtered]);

  // Content-only matches: sessions hit by content search but NOT by metadata filter
  const contentOnlyMatches = useMemo(() => {
    if (!searchQuery.trim() || contentSearchResults.size === 0) return [];
    const metadataIds = new Set(filtered.map((s) => s.id));
    return sessions.filter((s) => {
      if (s.host) return false;
      if (metadataIds.has(s.id)) return false;
      if (!contentSearchResults.has(s.id)) return false;
      // Respect archive filter
      if (showArchived) return archivedSessions.has(s.id);
      return !archivedSessions.has(s.id);
    });
  }, [sessions, filtered, contentSearchResults, searchQuery, showArchived, archivedSessions]);

  // Smart expand: expand if contains selected, or manually expanded
  const isExpanded = useCallback((key: string) => {
    if (manualCollapsed.has(key)) return false;
    if (manualExpanded.has(key)) return true;
    // Default: expand if contains selected session
    if (!selectedId) return true; // expand all if nothing selected
    const raw = sessions.find((s) => s.id === selectedId);
    if (!raw) return false;
    const selectedKey = normalizeProjectKey(raw.project || raw.projectDir);
    return selectedKey === key;
  }, [manualCollapsed, manualExpanded, selectedId, sessions]);

  const toggleCollapse = useCallback((project: string) => {
    const expanded = isExpanded(project);
    if (expanded) {
      // Collapse it
      setManualCollapsed((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualExpanded((prev) => { const next = new Set(prev); next.delete(project); return next; });
    } else {
      // Expand it
      setManualExpanded((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualCollapsed((prev) => { const next = new Set(prev); next.delete(project); return next; });
    }
  }, [isExpanded]);

  // --- Session loading (slim version using session-loader) ---
  const handleLoadSession = useCallback(async (session: SessionListItem) => {
    const { path: sessionPath, id: sessionId, project: projectOrDir } = session;
    const currentTabId = selectedId;
    if (currentTabId === sessionId) return;

    // Save current to cache
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }

    // Close file preview
    useFileStore.getState().closePreview();

    // Switch selection
    setSelected(sessionId);

    // Try cache first
    const restored = useChatStore.getState().restoreFromCache(sessionId);
    if (restored) {
      useAgentStore.getState().restoreFromCache(sessionId);
      if (projectOrDir) {
        useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
      }
      // 缓存可能已落后于磁盘（例如终端里的 claude 在此期间继续了对话），后台刷新一次
      void syncSession(session);
      return;
    }

    // Draft sessions
    if (!sessionPath) {
      useChatStore.getState().ensureTab(sessionId);
      useChatStore.getState().resetTab(sessionId);
      useAgentStore.getState().clearAgents();
      return;
    }

    // Load from disk
    useChatStore.getState().ensureTab(sessionId);
    useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
    const { clearMessages, addMessage, setSessionStatus, setSessionMeta } = useChatStore.getState();
    const agentActions = useAgentStore.getState();
    clearMessages(sessionId);
    agentActions.clearAgents();
    setSessionStatus(sessionId, 'running');
    // TK-329: explicitly clear stdinId when loading from disk — no live process exists yet.
    // Only set the CLI UUID (for resume). Prevents inheriting a stale stdinId
    // from a previous session that might still be alive in the backend.
    setSessionMeta(sessionId, { sessionId, stdinId: undefined });

    try {
      const applied = await applyDiskSession(sessionId, sessionPath);
      if (!applied) return;

      setSessionStatus(sessionId, 'completed');
    } catch (err) {
      if (useSessionStore.getState().selectedSessionId !== sessionId) return;
      setSessionStatus(sessionId, 'error');
      addMessage(sessionId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: `${t('conv.loadFailed')}: ${err}`,
        timestamp: Date.now(),
      });
    }
  }, [selectedId, setSelected, t]);

  // --- Delete handlers ---
  const executeDelete = useCallback(async (sessionId: string, sessionPath: string) => {
    try {
      if (sessionPath) {
        await bridge.deleteSession(sessionId, sessionPath);
      } else {
        useSessionStore.getState().removeDraft(sessionId);
      }
      if (selectedId === sessionId) {
        setSelected(null);
        useChatStore.getState().resetTab(sessionId);
      }
      useChatStore.getState().removeFromCache(sessionId);
      fetchSessions();
    } catch (err) {
      console.error('Failed to delete session:', err);
      showToast(`${t('conv.deleteFailed')}: ${err}`, 'error');
    }
  }, [selectedId, setSelected, fetchSessions, t]);

  // Single delete → confirm dialog
  const handleDeleteSingle = useCallback((session: SessionListItem) => {
    setDeleteTarget(session);
  }, []);

  // Delete all in project → confirm dialog
  const handleDeleteAllInProject = useCallback((projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    if (projectSessions.length === 0) return;
    setDeleteAllTarget({ projectKey, count: projectSessions.length });
  }, []);

  const confirmDeleteAll = useCallback(async () => {
    if (!deleteAllTarget) return;
    const suffix = deleteAllTarget.projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    for (const session of projectSessions) {
      await executeDelete(session.id, session.path);
    }
    setDeleteAllTarget(null);
    fetchSessions();
  }, [deleteAllTarget, executeDelete, fetchSessions]);

  // 远程项目“加载全部”：逐个把会话内容读一遍，让 load_remote_session 的本地增量缓存预热，
  // 之后逐个点开就是秒开（内容没变时完全不用再传输）。限制并发数，避免同时打开太多 ssh 连接。
  const [loadingAllProject, setLoadingAllProject] = useState<string | null>(null);
  const handleLoadAllInProject = useCallback(async (projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const targets = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return s.host && raw.endsWith(suffix) && s.path;
    });
    if (targets.length === 0) return;

    setLoadingAllProject(projectKey);
    showToast(t('conv.loadAllStarted').replace('{count}', String(targets.length)), 'info');
    let done = 0;
    let failed = 0;
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const session = queue.shift();
        if (!session) break;
        try {
          await bridge.loadSession(session.path);
          done++;
        } catch (err) {
          failed++;
          console.warn('[ClaudeDeck] preload remote session failed:', session.id, err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    setLoadingAllProject(null);
    showToast(
      failed > 0
        ? t('conv.loadAllDoneWithErrors').replace('{done}', String(done)).replace('{failed}', String(failed))
        : t('conv.loadAllDone').replace('{done}', String(done)),
      failed > 0 ? 'error' : 'success',
    );
  }, [t]);

  // --- Context menu handlers ---
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionListItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: string) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ x: e.clientX, y: e.clientY, project });
  }, []);

  const handleRevealInFinder = useCallback((session: SessionListItem) => {
    if (session.path) bridge.revealInFinder(session.path).catch(() => {});
  }, []);

  const handleExportMarkdown = useCallback(async (session: SessionListItem) => {
    if (!session.path) return;
    const outputPath = await save({
      defaultPath: `${session.id}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (outputPath) {
      bridge.exportSessionMarkdown(session.path, outputPath).catch(() => {});
    }
  }, []);

  const handleNewSessionInProject = useCallback((projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const match = allSessions.find((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    const realPath = match ? (match.project || match.projectDir) : resolveProjectPath(projectKey);
    useSettingsStore.getState().setWorkingDirectory(realPath);
    const currentTabId = useSessionStore.getState().selectedSessionId;
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }
    const newDraftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useChatStore.getState().ensureTab(newDraftId);
    useChatStore.getState().resetTab(newDraftId);
    useSessionStore.getState().addDraftSession(newDraftId, realPath);
  }, []);

  // Pin / Archive handlers
  const handleTogglePin = useCallback((session: SessionListItem) => {
    const next = new Set(pinnedSessions);
    if (next.has(session.id)) next.delete(session.id);
    else next.add(session.id);
    persistPinned(next);
  }, [pinnedSessions, persistPinned]);

  const handleToggleArchive = useCallback((session: SessionListItem) => {
    const next = new Set(archivedSessions);
    if (next.has(session.id)) next.delete(session.id);
    else next.add(session.id);
    persistArchived(next);
    pushArchivedToRemote(session, next);
  }, [archivedSessions, persistArchived, pushArchivedToRemote]);

  // Build flat list of visible session IDs for shift+click range selection
  const flatSessionIds = useMemo(() => {
    const ids: string[] = [];
    if (viewMode === 'recent') {
      for (const s of recentlyActiveGroups.others) ids.push(s.id);
    } else {
      for (const [project, items] of projectGroups) {
        if (isExpanded(project)) {
          for (const s of items) ids.push(s.id);
        }
      }
    }
    return ids;
  }, [projectGroups, recentlyActiveGroups, isExpanded, viewMode]);

  // Multi-select handlers (with shift+click range support)
  const handleToggleCheck = useCallback((sessionId: string, shiftKey?: boolean) => {
    // Auto-enter multiSelect mode if not already in it
    if (!multiSelect) {
      setMultiSelect(true);
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);

      // Shift+click: range select
      if (shiftKey && lastClickedIndex !== null) {
        const currentIndex = flatSessionIds.indexOf(sessionId);
        if (currentIndex !== -1) {
          const start = Math.min(lastClickedIndex, currentIndex);
          const end = Math.max(lastClickedIndex, currentIndex);
          for (let i = start; i <= end; i++) {
            next.add(flatSessionIds[i]);
          }
          setLastClickedIndex(currentIndex);
          return next;
        }
      }

      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);

      setLastClickedIndex(flatSessionIds.indexOf(sessionId));
      return next;
    });
  }, [flatSessionIds, lastClickedIndex, multiSelect]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAllTarget({
      projectKey: '__batch__',
      count: selectedIds.size,
    });
  }, [selectedIds]);

  const confirmBatchDelete = useCallback(async () => {
    const allSessions = useSessionStore.getState().sessions;
    for (const id of selectedIds) {
      const session = allSessions.find((s) => s.id === id);
      if (session) await executeDelete(session.id, session.path);
    }
    setSelectedIds(new Set());
    setMultiSelect(false);
    setDeleteAllTarget(null);
    fetchSessions();
  }, [selectedIds, executeDelete, fetchSessions]);

  const handleBatchArchive = useCallback(() => {
    const next = new Set(archivedSessions);
    for (const id of selectedIds) next.add(id);
    persistArchived(next);
    // 批量归档里涉及到的每台远程主机，各推一次自己名下的最新归档列表
    const touchedHosts = new Set(
      remoteSessionsList.filter((s) => s.host && selectedIds.has(s.id)).map((s) => s.host!),
    );
    for (const hostId of touchedHosts) {
      const hostArchived = remoteSessionsList
        .filter((s) => s.host === hostId && next.has(s.id))
        .map((s) => s.id);
      bridge.saveRemoteArchivedSessions(hostId, hostArchived).catch(() => {});
    }
    setSelectedIds(new Set());
    setMultiSelect(false);
  }, [selectedIds, archivedSessions, persistArchived, remoteSessionsList]);

  const handleRename = useCallback((sessionId: string, newName: string) => {
    setCustomPreview(sessionId, newName);
  }, [setCustomPreview]);

  // Rename from context menu — trigger inline edit in SessionItem
  const handleRenameFromMenu = useCallback((session: SessionListItem) => {
    setRenamingSessionId(session.id);
  }, []);

  const handleRenameDone = useCallback(() => {
    setRenamingSessionId(null);
  }, []);

  // 从会话右键菜单进入多选，并预先勾选该会话
  const handleSelectSession = useCallback((session: SessionListItem) => {
    setMultiSelect(true);
    setSelectedIds(new Set([session.id]));
  }, []);

  const handleToggleUnread = useCallback((session: SessionListItem) => {
    useSessionStore.getState().toggleUnread(session.id);
  }, []);

  const handleToggleProjectPin = useCallback((project: string) => {
    const key = `project:${project}`;
    const next = new Set(pinnedSessions);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persistPinned(next);
  }, [pinnedSessions, persistPinned]);

  // Folder operation handlers (resolve projectKey to real path)
  const resolveRealPathFromKey = useCallback((projectKey: string): string => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const match = allSessions.find((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    const realPath = match ? (match.project || match.projectDir) : resolveProjectPath(projectKey);
    return realPath;
  }, []);

  const handleOpenInExplorer = useCallback((projectKey: string) => {
    const realPath = resolveRealPathFromKey(projectKey);
    bridge.openWithDefaultApp(realPath).catch(() => {});
  }, [resolveRealPathFromKey]);

  const handleLocateInFolder = useCallback((session: SessionListItem) => {
    const raw = session.project || session.projectDir;
    const projectKey = normalizeProjectKey(raw);
    // Switch to folder view and expand the group
    setViewMode('folder');
    setManualExpanded((prev) => { const next = new Set(prev); next.add(projectKey); return next; });
    setManualCollapsed((prev) => { const next = new Set(prev); next.delete(projectKey); return next; });
    setHighlightedSessionId(session.id);
    // Scroll to the project group after render
    setTimeout(() => {
      const el = projectGroupRefs.current.get(projectKey);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  }, []);

  // Clear highlight after animation
  useEffect(() => {
    if (!highlightedSessionId) return;
    const timer = setTimeout(() => setHighlightedSessionId(null), 2200);
    return () => clearTimeout(timer);
  }, [highlightedSessionId]);

  return (
    <div className="flex flex-col gap-1 px-3">
      {/* Search + Filters */}
      <div className="px-1 mb-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl
            bg-bg-secondary border border-border-subtle
            focus-within:border-border-focus transition-smooth">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              className="text-text-tertiary flex-shrink-0">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('conv.search')}
              className="flex-1 bg-transparent text-xs text-text-primary
                placeholder:text-text-tertiary outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="flex-shrink-0 p-0.5 rounded text-text-tertiary
                  hover:text-text-primary transition-smooth">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </div>

          {/* Archive toggle */}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`flex-shrink-0 p-2 rounded-lg transition-smooth
              ${showArchived
                ? 'bg-accent/10 text-accent'
                : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
            title={t('conv.showArchived')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="2" width="14" height="3" rx="1" />
              <path d="M2 5v7a1 1 0 001 1h10a1 1 0 001-1V5" />
              <path d="M6 8h4" />
            </svg>
          </button>
        </div>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-1 px-1 mb-1">
        <button
          onClick={() => setViewMode('folder')}
          className={`flex-1 py-1 text-[11px] rounded-lg transition-smooth
            ${viewMode === 'folder'
              ? 'bg-accent/10 text-accent font-medium'
              : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
        >
          <span className="flex items-center justify-center gap-1">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h4l2 2h6v7H2V4z" />
            </svg>
            {t('conv.viewFolder')}
          </span>
        </button>
        <button
          onClick={() => setViewMode('recent')}
          className={`flex-1 py-1 text-[11px] rounded-lg transition-smooth
            ${viewMode === 'recent'
              ? 'bg-accent/10 text-accent font-medium'
              : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
        >
          <span className="flex items-center justify-center gap-1">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4v4l3 2" />
            </svg>
            {t('conv.viewRecent')}
          </span>
        </button>
      </div>

      {/* Loading */}
      {isLoading && sessions.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-accent/30
            border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {/* Session listing — folder view or recent view */}
      {viewMode === 'folder' ? (
        /* ---- Folder View ---- */
        projectGroups.map(([project, items]) => {
          const baseName = projectLabel(project);
          const isDuplicate = projectGroups.filter(([k]) => projectLabel(k) === baseName).length > 1;
          return (
          <div
            key={project}
            ref={(el) => {
              if (el) projectGroupRefs.current.set(project, el as HTMLDivElement);
              else projectGroupRefs.current.delete(project);
            }}
          >
            <SessionGroup
              projectKey={project}
              projectLabel={projectLabel(project, isDuplicate)}
              sessions={items}
              isExpanded={isExpanded(project)}
              selectedId={selectedId}
              runningSessions={runningSessions}
              pinnedSessions={pinnedSessions}
              archivedSessions={archivedSessions}
              customPreviews={customPreviews}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleCollapse={toggleCollapse}
              onContextMenu={handleContextMenu}
              onPin={handleTogglePin}
              unreadSessions={unreadSessions}
              isPinned={pinnedSessions.has(`project:${project}`)}
              onProjectContextMenu={handleProjectContextMenu}
              onLoadSession={handleLoadSession}
              onRename={handleRename}
              onNewSession={handleNewSessionInProject}
              onToggleCheck={handleToggleCheck}
              renamingSessionId={renamingSessionId}
              onRenameDone={handleRenameDone}
              highlightedSessionId={highlightedSessionId}
            />
          </div>
          );
        })
      ) : (
        /* ---- Recently Active View ----
           置顶在这个跨项目的平铺视图里不生效（只在文件夹视图内排序），
           这里不传 isPinned/onPin，不再显示没有实际作用的置顶入口。 */
        <>
          {recentlyActiveGroups.others.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isSelected={selectedId === session.id}
              isRunning={runningSessions.has(session.id)}
              isArchived={archivedSessions.has(session.id)}
              displayName={displayName(session)}
              multiSelect={multiSelect}
              isChecked={selectedIds.has(session.id)}
              onSelect={handleLoadSession}
              onContextMenu={handleContextMenu}
              onRename={handleRename}
              isUnread={unreadSessions.has(session.id)}
              onToggleCheck={handleToggleCheck}
              triggerRename={renamingSessionId === session.id}
              onRenameDone={handleRenameDone}
              isHighlighted={highlightedSessionId === session.id}
            />
          ))}
        </>
      )}

      {/* Content matches section (async, appears after metadata results) */}
      {searchQuery.trim() && contentOnlyMatches.length > 0 && (
        <div className="mt-3 mb-1">
          <div className="flex items-center gap-2 px-3 py-1">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
              {t('conv.contentMatches')} ({contentOnlyMatches.length})
            </span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>
          {contentOnlyMatches.map((session) => {
            const result = contentSearchResults.get(session.id);
            return (
              <SessionItem
                key={session.id}
                session={session}
                isSelected={selectedId === session.id}
                isRunning={runningSessions.has(session.id)}
                isArchived={archivedSessions.has(session.id)}
                displayName={displayName(session)}
                contentSnippet={result?.snippet}
                matchCount={result?.match_count}
                searchQuery={searchQuery}
                multiSelect={multiSelect}
                isChecked={selectedIds.has(session.id)}
                onSelect={handleLoadSession}
                onContextMenu={handleContextMenu}
                onRename={handleRename}
                isUnread={unreadSessions.has(session.id)}
                onToggleCheck={handleToggleCheck}
                triggerRename={renamingSessionId === session.id}
                onRenameDone={handleRenameDone}
              />
            );
          })}
        </div>
      )}

      {/* Content search loading spinner */}
      {searchQuery.trim() && isContentSearching && (
        <div className="flex items-center justify-center gap-1.5 py-3 text-text-tertiary">
          <div className="w-3 h-3 border-[1.5px] border-text-tertiary/20
            border-t-text-tertiary/60 rounded-full animate-spin" />
          <span className="text-[10px]">{t('conv.searchingContent')}</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && contentOnlyMatches.length === 0 && !isContentSearching && (
        <div className="text-center py-8 px-4">
          <div className="text-text-tertiary text-xs">
            {searchQuery ? t('conv.noMatch') : t('conv.noConv')}
          </div>
        </div>
      )}

      {/* Multi-select floating toolbar — sticky at bottom of scroll container */}
      {multiSelect && (
        <div className="sticky bottom-0 mx-1 mt-2 p-2 rounded-xl
          bg-bg-card/95 backdrop-blur-sm border border-border-subtle shadow-lg
          flex items-center gap-2 animate-fade-in z-10">
          <span className="text-xs text-text-muted flex-1">
            {t('conv.selected').replace('{n}', String(selectedIds.size))}
          </span>
          <button
            onClick={handleBatchArchive}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-lg bg-bg-tertiary text-text-primary
              hover:bg-accent/10 hover:text-accent transition-smooth
              disabled:opacity-30"
          >
            {t('conv.archive')}
          </button>
          <button
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-lg bg-error/10 text-error
              hover:bg-error/20 transition-smooth
              disabled:opacity-30"
          >
            {t('conv.delete')}
          </button>
          <button
            onClick={() => { setMultiSelect(false); setSelectedIds(new Set()); }}
            className="px-2 py-1 text-xs rounded-lg bg-bg-tertiary text-text-muted
              hover:text-text-primary transition-smooth"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* Session context menu */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={contextMenu.session}
          onRename={handleRenameFromMenu}
          onRevealInFinder={handleRevealInFinder}
          onExport={handleExportMarkdown}
          onDelete={handleDeleteSingle}
          onPin={viewMode === 'recent' ? undefined : handleTogglePin}
          onArchive={handleToggleArchive}
          isPinned={pinnedSessions.has(contextMenu.session.id)}
          isArchived={archivedSessions.has(contextMenu.session.id)}
          onLocateInFolder={viewMode === 'recent' ? handleLocateInFolder : undefined}
          onSelectMode={handleSelectSession}
          onToggleUnread={handleToggleUnread}
          isUnread={unreadSessions.has(contextMenu.session.id)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Project context menu */}
      {projectMenu && (
        <ProjectContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          project={projectMenu.project}
          onNewSession={handleNewSessionInProject}
          onDeleteAll={handleDeleteAllInProject}
          onPin={handleToggleProjectPin}
          onOpenInExplorer={projectMenu.project.startsWith('ssh://') ? undefined : handleOpenInExplorer}
          onLoadAll={projectMenu.project.startsWith('ssh://') ? handleLoadAllInProject : undefined}
          isLoadingAll={loadingAllProject === projectMenu.project}
          isPinned={pinnedSessions.has(`project:${projectMenu.project}`)}
          onClose={() => setProjectMenu(null)}
        />
      )}

      {/* Delete single confirm dialog */}
      {deleteTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.delete')}
          message={t('conv.deleteConfirm')}
          detail={displayName(deleteTarget) || deleteTarget.preview}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={() => {
            executeDelete(deleteTarget.id, deleteTarget.path);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Delete all confirm dialog */}
      {deleteAllTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.deleteAll')}
          message={
            deleteAllTarget.projectKey === '__batch__'
              ? t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', t('conv.selected').replace('{n}', String(deleteAllTarget.count)))
              : t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', projectLabel(deleteAllTarget.projectKey))
          }
          detail={t('conv.deleteAllConfirmDetail')}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={deleteAllTarget.projectKey === '__batch__' ? confirmBatchDelete : confirmDeleteAll}
          onCancel={() => setDeleteAllTarget(null)}
        />
      )}
    </div>
  );
}
