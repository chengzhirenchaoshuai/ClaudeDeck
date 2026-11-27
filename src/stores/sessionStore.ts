import { create } from 'zustand';
import { bridge, SessionListItem, ContentSearchResult, RemoteHost, type TerminalSessionStatus } from '../lib/tauri-bridge';
import { useSettingsStore } from './settingsStore';
import { useBackgroundTaskStore } from './backgroundTaskStore';
import { showToast } from '../components/shared/Toast';
import { t } from '../lib/i18n';

/** 从 ssh://<主机>/<路径> 中取出主机 id；本机路径返回 undefined */
export function hostOfPath(p: string): string | undefined {
  return p.match(/^ssh:\/\/([^/]+)\//)?.[1];
}

// Persist custom session names in localStorage as fast cache,
// and sync to disk via Tauri backend for durability.
/** 两次发消息间隔达到这个时长（毫秒）算开始新一轮使用，与后端 ACTIVE_GAP_MS 一致 */
export const ACTIVE_GAP_MS = 60 * 60 * 1000;

const CUSTOM_PREVIEWS_KEY = 'tokenicode_custom_previews';
const PENDING_REMOTE_NAMES_KEY = 'tokenicode_pending_remote_names';
const PENDING_REMOTE_ARCHIVES_KEY = 'claudedeck_pending_remote_archives';
const LAST_SESSION_KEY = 'tokenicode_last_session';
const STDIN_TO_TAB_KEY = 'tokenicode_stdinToTab';
const UNREAD_KEY = 'tokenicode_unread_sessions';

function loadUnreadSync(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveUnread(ids: Set<string>) {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...ids]));
  } catch {
    // 本地存储不可用时，未读标记只在本次运行内有效
  }
}

function loadCustomPreviewsSync(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PREVIEWS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCustomPreviewsLocal(map: Record<string, string>) {
  localStorage.setItem(CUSTOM_PREVIEWS_KEY, JSON.stringify(map));
}

/**
 * 没能写回远程主机的改名（主机 id → 会话 id → 新名字，空字符串表示删除）。
 * 远端是名字的源端，没推上去的话下次拉列表就会被远端的旧名字盖回去，所以要记下来补推。
 * 存 localStorage：断网时退出应用，下次启动还得接着推；多窗口共用一份，每次都现读现写。
 */
type PendingNames = Record<string, Record<string, string>>;

function readPendingNames(): PendingNames {
  try {
    return JSON.parse(localStorage.getItem(PENDING_REMOTE_NAMES_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePendingNames(pending: PendingNames) {
  try {
    const left = Object.keys(pending).filter((h) => Object.keys(pending[h]).length > 0);
    if (left.length === 0) localStorage.removeItem(PENDING_REMOTE_NAMES_KEY);
    else localStorage.setItem(PENDING_REMOTE_NAMES_KEY, JSON.stringify(pending));
  } catch {
    // 本地存储不可用时，待推送的改名只在本次运行内有效
  }
}

function markPendingName(hostId: string, sessionId: string, name: string) {
  const pending = readPendingNames();
  pending[hostId] = { ...pending[hostId], [sessionId]: name };
  writePendingNames(pending);
}

function clearPendingName(hostId: string, sessionId: string) {
  const pending = readPendingNames();
  if (!pending[hostId]?.[sessionId] && pending[hostId]?.[sessionId] !== '') return;
  delete pending[hostId][sessionId];
  if (Object.keys(pending[hostId]).length === 0) delete pending[hostId];
  writePendingNames(pending);
}

/**
 * 没能写回远程主机的归档改动（主机 id → 会话 id → true 归档 / false 取消归档）。
 * 和改名一样：远端是归档状态的源端，没推上去的话下次拉列表会被远端的旧状态盖回去。
 */
type PendingArchives = Record<string, Record<string, boolean>>;

function readPendingArchives(): PendingArchives {
  try {
    return JSON.parse(localStorage.getItem(PENDING_REMOTE_ARCHIVES_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePendingArchives(pending: PendingArchives) {
  try {
    const left = Object.keys(pending).filter((h) => Object.keys(pending[h]).length > 0);
    if (left.length === 0) localStorage.removeItem(PENDING_REMOTE_ARCHIVES_KEY);
    else localStorage.setItem(PENDING_REMOTE_ARCHIVES_KEY, JSON.stringify(pending));
  } catch {
    // 本地存储不可用时，待推送的归档只在本次运行内有效
  }
}

/** 某台主机上还没推上去的归档改动；拉取远端归档状态时这些会话以本机为准 */
export function pendingArchivesOf(hostId: string): Record<string, boolean> {
  return readPendingArchives()[hostId] ?? {};
}

/** 推送成功后清掉对应条目；推送期间又改过的（值不同）留着下次再推 */
function clearPendingArchives(hostId: string, pushed: Record<string, boolean>) {
  const pending = readPendingArchives();
  const host = pending[hostId];
  if (!host) return;
  for (const [id, archived] of Object.entries(pushed)) {
    if (host[id] === archived) delete host[id];
  }
  if (Object.keys(host).length === 0) delete pending[hostId];
  writePendingArchives(pending);
}

/**
 * 按 ID 找会话。远程主机就是本机时（如 ssh 到 localhost），同一个会话在本机列表和远程列表里
 * 各有一行、ID 相同：优先取与当前环境一致的那一行，否则远程模式下会拿到本机路径，
 * 远程会话的同步、只读状态的解除都不会发生。
 */
export function findSessionInEnv(sessions: SessionListItem[], id: string | null): SessionListItem | undefined {
  if (!id) return undefined;
  const matches = sessions.filter((s) => s.id === id);
  if (matches.length <= 1) return matches[0];
  const env = useSettingsStore.getState().activeEnv;
  return matches.find((s) => (env === 'local' ? !s.host : s.host === env)) ?? matches[0];
}

/** Persist the last active session ID so app restart can auto-restore */
function saveLastSessionId(id: string | null) {
  if (id && !id.startsWith('draft_')) {
    sessionStorage.setItem(LAST_SESSION_KEY, id);
  }
}

function loadLastSessionId(): string | null {
  return sessionStorage.getItem(LAST_SESSION_KEY);
}

/** Persist stdinToTab across page refreshes using sessionStorage.
 *  sessionStorage survives same-window refreshes but clears on app restart,
 *  which is exactly the right scope for process-lifetime mappings. */
function loadStdinToTabSync(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(STDIN_TO_TAB_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStdinToTab(map: Record<string, string>) {
  sessionStorage.setItem(STDIN_TO_TAB_KEY, JSON.stringify(map));
}

interface SessionState {
  sessions: SessionListItem[];
  /** 各远程主机的会话缓存（经 ssh 读取较慢，不随 fetchSessions 每次刷新） */
  remoteSessions: SessionListItem[];
  /** 已配置的远程主机 */
  remoteHosts: RemoteHost[];
  /** 远程主机读取失败的原因，key 为主机 id */
  remoteErrors: Record<string, string>;
  isRemoteLoading: boolean;
  isLoading: boolean;
  searchQuery: string;
  selectedSessionId: string | null;
  /** Previously selected session ID, for Ctrl+Tab quick switch */
  previousSessionId: string | null;
  /** Custom display names keyed by session ID, persisted to disk */
  customPreviews: Record<string, string>;
  /** Track which sessions are actively running (streaming/working) */
  runningSessions: Set<string>;
  /** 各会话仍在运行的 CLI 后台任务数（后台 Bash、Monitor、后台子代理等，不含 CLI 内部任务），没有则不在表中 */
  backgroundTasks: Map<string, number>;
  /** 终端里直接运行的 claude 会话（本机与当前远程主机）：会话 ID → busy（正在回复）/ idle（等待输入） */
  terminalSessions: Map<string, TerminalSessionStatus>;
  /** 未读会话（任务结束时用户不在该会话窗口），持久化在本地存储 */
  unreadSessions: Set<string>;
  /** Map stdinId → tabId so stream events can be routed to the correct session */
  stdinToTab: Record<string, string>;
  /** Content search results keyed by session ID */
  contentSearchResults: Map<string, ContentSearchResult>;
  isContentSearching: boolean;
  contentSearchQuery: string;

  fetchSessions: () => Promise<void>;
  setSearchQuery: (query: string) => void;
  setSelectedSession: (id: string | null) => void;
  /** Insert a temporary "draft" session at the top of the list */
  addDraftSession: (id: string, projectPath: string) => void;
  /** Update an existing draft session's project path (e.g. after folder selection) */
  updateDraftProject: (id: string, projectPath: string) => void;
  /** Set a custom display name for a session */
  setCustomPreview: (sessionId: string, name: string) => void;
  /** 把没写回远程主机的改名补推一次（退出前、下次启动拉远程列表前调用） */
  flushPendingRemoteNames: () => Promise<void>;
  /** 把归档改动写回远程主机（只发改动项，远端合并）；失败时记下待推并提示 */
  pushRemoteArchive: (hostId: string, patch: Record<string, boolean>) => Promise<void>;
  /** 补推上次没写回远程主机的归档改动（拉列表前、退出前调用） */
  flushPendingRemoteArchives: () => Promise<void>;
  /** Get the display name for a session (custom > preview > fallback) */
  getDisplayName: (session: SessionListItem) => string;
  /** Mark a session as running (actively streaming/working) */
  setSessionRunning: (sessionId: string, running: boolean) => void;
  /** Check if a session is currently running */
  isSessionRunning: (sessionId: string) => boolean;
  /** 记录会话当前的后台任务数，0 表示没有 */
  setBackgroundTasks: (sessionId: string, count: number) => void;
  /** 用轮询结果整体替换终端会话状态，内容没变时不触发更新 */
  setTerminalSessions: (next: Map<string, TerminalSessionStatus>) => void;
  /** Register a stdinId → tabId mapping (persisted to sessionStorage) */
  registerStdinTab: (stdinId: string, tabId: string) => void;
  /** Remove a stdinId mapping on process exit (cleans sessionStorage too) */
  unregisterStdinTab: (stdinId: string) => void;
  /** Look up which tabId owns a given stdinId */
  getTabForStdin: (stdinId: string) => string | undefined;
  /** Remove a draft session from the local list (no disk deletion needed) */
  removeDraft: (draftId: string) => void;
  /** 用户刚给这个会话发了消息：立即更新列表里的最后发言时间（远程会话不会自动刷新，本机也要等磁盘写入） */
  touchSession: (id: string, at: number) => void;
  /** Promote a draft session to a real session ID (when CLI returns the actual UUID).
   *  Updates session id, selectedSessionId, stdinToTab mapping, and runningSessions. */
  promoteDraft: (oldDraftId: string, newRealId: string) => void;
  /** Switch to the previously selected session (Ctrl+Tab) */
  switchToPrevious: () => void;
  /** Load custom previews from backend (called once on init) */
  loadCustomPreviewsFromDisk: () => Promise<void>;
  /** Get the last active session ID from localStorage (for app restart recovery) */
  getLastSessionId: () => string | null;
  /** Search session content via backend */
  searchSessionContent: (query: string) => Promise<void>;
  /** Clear content search results */
  clearContentSearch: () => void;
  /** 读取所有已配置远程主机的会话（经 ssh，较慢，需手动或在启动时调用） */
  fetchRemoteSessions: () => Promise<void>;
  /** 远程会话列表还空着时，先用上次成功读取的本地缓存填上（不连 ssh，启动时调用） */
  loadCachedRemoteSessions: () => Promise<void>;
  /** 从远程会话缓存和列表中移除一个会话（远程删除成功后调用，fetchSessions 不会重读远程） */
  removeRemoteSession: (sessionId: string) => void;
  markUnread: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  toggleUnread: (sessionId: string) => void;
}

/** 两个会话条目的字段是否完全相同（条目都是扁平的基本类型字段） */
function sameSessionItem(a: SessionListItem, b: SessionListItem): boolean {
  const ka = Object.keys(a) as (keyof SessionListItem)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * 内容没变的条目沿用旧对象，让 memo 过的 SessionItem 跳过重新渲染；
 * 整个列表都没变时返回旧数组本身，调用方据此跳过 set。
 */
/**
 * 列表里还需要保留的草稿行（path 为空）：真实会话已出现在 listed 中的草稿去掉。
 * 草稿收到 CLI 的真实 ID 后会改用这个 ID，之后本机磁盘或远端列表里出现同 ID 的会话时，
 * 两行同时显示就成了"影子"（列表以 ID 作 React key）。
 */
export function keepPendingDrafts(sessions: SessionListItem[], listed: SessionListItem[]): SessionListItem[] {
  const ids = new Set(listed.map((s) => s.id));
  return sessions.filter((s) => s.path === '' && !ids.has(s.id));
}

function reuseUnchanged(prev: SessionListItem[], next: SessionListItem[]): SessionListItem[] {
  const prevById = new Map(prev.map((s) => [s.id, s]));
  let changed = prev.length !== next.length;
  const result = next.map((item, i) => {
    const old = prevById.get(item.id);
    const reused = old && sameSessionItem(old, item) ? old : item;
    if (reused !== prev[i]) changed = true;
    return reused;
  });
  return changed ? result : prev;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  remoteSessions: [],
  remoteHosts: [],
  remoteErrors: {},
  isRemoteLoading: false,
  isLoading: false,
  searchQuery: '',
  selectedSessionId: null,
  previousSessionId: null,
  customPreviews: loadCustomPreviewsSync(),
  runningSessions: new Set<string>(),
  backgroundTasks: new Map<string, number>(),
  terminalSessions: new Map<string, TerminalSessionStatus>(),
  unreadSessions: loadUnreadSync(),
  stdinToTab: loadStdinToTabSync(),
  contentSearchResults: new Map<string, ContentSearchResult>(),
  isContentSearching: false,
  contentSearchQuery: '',

  fetchSessions: async () => {
    const isFirstLoad = get().sessions.length === 0;
    if (isFirstLoad) set({ isLoading: true });
    try {
      const diskSessions = await bridge.listSessions();
      const { remoteSessions } = get();
      const drafts = keepPendingDrafts(get().sessions, [...diskSessions, ...remoteSessions]);
      const next = reuseUnchanged(get().sessions, [...drafts, ...diskSessions, ...remoteSessions]);
      // CLI 写会话文件时这里约每秒触发一次：列表没有任何变化就不更新，避免整个会话列表重新渲染
      if (next === get().sessions) {
        if (get().isLoading) set({ isLoading: false });
      } else {
        set({ sessions: next, isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  removeRemoteSession: (sessionId) => {
    set((state) => ({
      remoteSessions: state.remoteSessions.filter((s) => s.id !== sessionId),
      sessions: state.sessions.filter((s) => !(s.host && s.id === sessionId)),
    }));
  },

  loadCachedRemoteSessions: async () => {
    try {
      const hosts = await bridge.listRemoteHosts();
      const results = await Promise.allSettled(hosts.map((h) => bridge.loadCachedRemoteSessions(h.id)));
      const cached: SessionListItem[] = [];
      results.forEach((r) => { if (r.status === 'fulfilled') cached.push(...r.value); });
      if (cached.length === 0) return;
      set((state) => {
        // ssh 已经先读到了真实列表就不再用缓存覆盖
        if (state.remoteSessions.length > 0) return {};
        return {
          remoteSessions: cached,
          sessions: [
            ...state.sessions.filter((s) => !s.host && s.path !== ''),
            ...keepPendingDrafts(state.sessions, cached),
            ...cached,
          ],
        };
      });
    } catch {
      // 缓存读不到不影响正常流程
    }
  },

  fetchRemoteSessions: async () => {
    set({ isRemoteLoading: true });
    try {
      // 先显示上次的缓存：ssh 读取较慢，主机连不上时也不至于一片空白
      await get().loadCachedRemoteSessions();
      const hosts = await bridge.listRemoteHosts();
      // 当前所处的远程主机已被删除时，退回本地模式
      const { activeEnv, setActiveEnv } = useSettingsStore.getState();
      if (activeEnv !== 'local' && !hosts.some((h) => h.id === activeEnv)) {
        setActiveEnv('local');
      }
      // 先把上次没推上去的改名补推，再拉列表：顺序反了的话，待推的名字会被远端的旧值盖回去
      await Promise.all([get().flushPendingRemoteNames(), get().flushPendingRemoteArchives()]);
      const results = await Promise.allSettled(hosts.map((h) => bridge.listRemoteSessions(h.id)));
      const remoteSessions: SessionListItem[] = [];
      const remoteErrors: Record<string, string> = {};
      const previous = get().remoteSessions;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') remoteSessions.push(...r.value);
        else {
          remoteErrors[hosts[i].id] = String(r.reason);
          // 连不上的主机保留已有列表（含启动时读的缓存），会话仍可只读查看
          remoteSessions.push(...previous.filter((s) => s.host === hosts[i].id));
        }
      });
      // 用最新的远程会话替换列表中旧的远程部分，本机会话与草稿保持不变；
      // 草稿只保留远端还没有的（已转为真实 ID、远端也已列出的草稿行要去掉，否则出现同 ID 的影子行）
      set((state) => ({
        remoteHosts: hosts,
        remoteSessions,
        remoteErrors,
        isRemoteLoading: false,
        sessions: [
          ...state.sessions.filter((s) => !s.host && s.path !== ''),
          ...keepPendingDrafts(state.sessions, remoteSessions),
          ...remoteSessions,
        ],
      }));

      // 远程主机是改名的源端：拉取每台主机自己保存的改名文件，覆盖本地缓存里
      // 对应会话的名字（远程为准），这样在别处改过的名字也能同步过来。
      const nameResults = await Promise.allSettled(hosts.map((h) => bridge.loadRemoteCustomPreviews(h.id)));
      let merged: Record<string, string> | null = null;
      nameResults.forEach((r) => {
        if (r.status === 'fulfilled' && Object.keys(r.value).length > 0) {
          merged = { ...(merged ?? get().customPreviews), ...r.value };
        }
      });
      if (merged) {
        saveCustomPreviewsLocal(merged);
        set({ customPreviews: merged });
        bridge.saveCustomPreviews(merged).catch(() => {});
      }
    } catch {
      set({ isRemoteLoading: false });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSelectedSession: (id) => {
    saveLastSessionId(id);
    set((state) => ({
      selectedSessionId: id,
      previousSessionId: state.selectedSessionId !== id ? state.selectedSessionId : state.previousSessionId,
    }));
  },

  addDraftSession: (id, projectPath) => set((state) => {
    const projectDir = projectPath.replace(/\//g, '-');
    const draft: SessionListItem = {
      id,
      path: '',
      project: projectPath,
      projectDir,
      modifiedAt: Date.now(),
      preview: '',
      host: hostOfPath(projectPath),
    };
    return {
      sessions: [draft, ...state.sessions],
      selectedSessionId: id,
    };
  }),

  updateDraftProject: (id, projectPath) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === id
        ? { ...s, project: projectPath, projectDir: projectPath.replace(/\//g, '-'), modifiedAt: Date.now(), host: hostOfPath(projectPath) }
        : s,
    ),
  })),

  setCustomPreview: (sessionId, name) => {
    const updated = { ...get().customPreviews, [sessionId]: name };
    // Fast local cache
    saveCustomPreviewsLocal(updated);
    set({ customPreviews: updated });
    // Persist to disk via backend (fire-and-forget)
    bridge.saveCustomPreviews(updated).catch(() => {});

    // 远程会话：改名也要写回远程主机自己的改名文件，让远程主机保持“源端”——
    // 连到同一台主机的其它客户端下次拉取列表时才能看到这次改的名字。
    // 只发这一条改动交给远端合并：整份覆盖会抹掉本机列表里没有的会话（被隐藏的旧分支，
    // 或别的客户端刚改完、本机还没拉到的名字）。
    const hostId = get().sessions.find((s) => s.id === sessionId)?.host;
    if (hostId) {
      bridge.mergeRemoteCustomPreviews(hostId, { [sessionId]: name })
        .then(() => clearPendingName(hostId, sessionId))
        .catch((err) => {
          // 没写回远端的话，下次拉取列表会被远端的旧名字盖回去。记下来等退出前、
          // 下次启动拉列表前补推，同时告诉用户这次没同步成功。
          markPendingName(hostId, sessionId, name);
          showToast(
            t('conv.renameSyncFailed').replace('{host}', hostId).replace('{error}', String(err)),
            'error',
          );
        });
    }
  },

  flushPendingRemoteNames: async () => {
    const pending = readPendingNames();
    const hosts = Object.keys(pending).filter((h) => Object.keys(pending[h]).length > 0);
    if (hosts.length === 0) return;
    // 只补推本机确实改过、却没推上去的那几条；不整份推，否则会把别的客户端
    // 刚改完、本机还没拉到的名字盖成旧值。
    await Promise.allSettled(hosts.map(async (hostId) => {
      await bridge.mergeRemoteCustomPreviews(hostId, pending[hostId]);
      const latest = readPendingNames();
      for (const sessionId of Object.keys(pending[hostId])) {
        // 推送期间又改了同一条的话，留着下次再推
        if (latest[hostId]?.[sessionId] === pending[hostId][sessionId]) clearPendingName(hostId, sessionId);
      }
    }));
  },

  pushRemoteArchive: async (hostId, patch) => {
    if (Object.keys(patch).length === 0) return;
    // 先记下待推再推：推送途中退出应用，下次启动也会补推
    const pending = readPendingArchives();
    pending[hostId] = { ...pending[hostId], ...patch };
    writePendingArchives(pending);
    try {
      await bridge.mergeRemoteArchivedSessions(hostId, patch);
      clearPendingArchives(hostId, patch);
    } catch (err) {
      showToast(
        t('conv.archiveSyncFailed').replace('{host}', hostId).replace('{error}', String(err)),
        'error',
      );
    }
  },

  flushPendingRemoteArchives: async () => {
    const pending = readPendingArchives();
    const hosts = Object.keys(pending).filter((h) => Object.keys(pending[h]).length > 0);
    await Promise.allSettled(hosts.map(async (hostId) => {
      await bridge.mergeRemoteArchivedSessions(hostId, pending[hostId]);
      clearPendingArchives(hostId, pending[hostId]);
    }));
  },

  getDisplayName: (session) => {
    const custom = get().customPreviews[session.id];
    return custom || session.preview || '';
  },

  setSessionRunning: (sessionId, running) => set((state) => {
    const next = new Set(state.runningSessions);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    return { runningSessions: next };
  }),

  isSessionRunning: (sessionId) => get().runningSessions.has(sessionId),

  setBackgroundTasks: (sessionId, count) => set((state) => {
    if ((state.backgroundTasks.get(sessionId) ?? 0) === count) return {};
    const next = new Map(state.backgroundTasks);
    if (count > 0) next.set(sessionId, count);
    else next.delete(sessionId);
    return { backgroundTasks: next };
  }),

  setTerminalSessions: (next) => set((state) => {
    const prev = state.terminalSessions;
    if (prev.size === next.size && [...next].every(([id, st]) => prev.get(id) === st)) return {};
    return { terminalSessions: next };
  }),

  markUnread: (sessionId) => set((state) => {
    if (state.unreadSessions.has(sessionId)) return {};
    const next = new Set(state.unreadSessions);
    next.add(sessionId);
    saveUnread(next);
    return { unreadSessions: next };
  }),

  markRead: (sessionId) => set((state) => {
    if (!state.unreadSessions.has(sessionId)) return {};
    const next = new Set(state.unreadSessions);
    next.delete(sessionId);
    saveUnread(next);
    return { unreadSessions: next };
  }),

  toggleUnread: (sessionId) => {
    const { unreadSessions, markUnread, markRead } = get();
    if (unreadSessions.has(sessionId)) markRead(sessionId);
    else markUnread(sessionId);
  },

  registerStdinTab: (stdinId, tabId) => {
    const next = { ...get().stdinToTab, [stdinId]: tabId };
    saveStdinToTab(next);
    set({ stdinToTab: next });
  },

  unregisterStdinTab: (stdinId) => {
    const { [stdinId]: _, ...rest } = get().stdinToTab;
    saveStdinToTab(rest);
    set({ stdinToTab: rest });
  },

  getTabForStdin: (stdinId) => get().stdinToTab[stdinId],

  touchSession: (id, at) => set((state) => {
    const touch = (s: SessionListItem) => {
      if (s.id !== id || (s.lastPromptAt ?? 0) >= at) return s;
      // 与上一条间隔不到 ACTIVE_GAP_MS 时还在同一轮使用，排序时间不变（规则同后端 last_prompt_at）
      const sameRound = !!s.lastPromptAt && at - s.lastPromptAt < ACTIVE_GAP_MS;
      return { ...s, lastPromptAt: at, activeSince: sameRound ? (s.activeSince || s.lastPromptAt) : at };
    };
    if (!state.sessions.some((s) => s.id === id)) return {};
    return { sessions: state.sessions.map(touch), remoteSessions: state.remoteSessions.map(touch) };
  }),

  removeDraft: (draftId) => set((state) => ({
    sessions: state.sessions.filter((s) => s.id !== draftId),
  })),

  promoteDraft: (oldDraftId, newRealId) => {
    saveLastSessionId(newRealId);
    set((state) => {
    // 1) Rename session in the list
    // CLI 写 JSONL 与发出 init 几乎同时：文件监听可能先把磁盘上的真实会话加进列表，
    // 此时再改名会出现两条同 ID 的行（列表以 ID 作 React key，会留下删不掉的"影子"行），
    // 所以真实会话已在列表里时直接去掉草稿行
    const sessions = state.sessions.some((s) => s.id === newRealId)
      ? state.sessions.filter((s) => s.id !== oldDraftId)
      : state.sessions.map((s) => (s.id === oldDraftId ? { ...s, id: newRealId } : s));

    // 2) Update selectedSessionId if it was the draft
    const selectedSessionId = state.selectedSessionId === oldDraftId
      ? newRealId
      : state.selectedSessionId;

    // 3) Migrate runningSessions
    const runningSessions = new Set(state.runningSessions);
    if (runningSessions.has(oldDraftId)) {
      runningSessions.delete(oldDraftId);
      runningSessions.add(newRealId);
    }
    const backgroundTasks = new Map(state.backgroundTasks);
    const draftBgCount = backgroundTasks.get(oldDraftId);
    if (draftBgCount !== undefined) {
      backgroundTasks.delete(oldDraftId);
      backgroundTasks.set(newRealId, draftBgCount);
    }

    // 4) Migrate stdinToTab entries that pointed to oldDraftId
    const stdinToTab = { ...state.stdinToTab };
    for (const [k, v] of Object.entries(stdinToTab)) {
      if (v === oldDraftId) stdinToTab[k] = newRealId;
    }

    // 5) Migrate previousSessionId if it was the draft
    const previousSessionId = state.previousSessionId === oldDraftId
      ? newRealId
      : state.previousSessionId;

    // 6) Migrate customPreviews if the old draft had a custom name
    const customPreviews = { ...state.customPreviews };
    if (customPreviews[oldDraftId]) {
      customPreviews[newRealId] = customPreviews[oldDraftId];
      delete customPreviews[oldDraftId];
      saveCustomPreviewsLocal(customPreviews);
      bridge.saveCustomPreviews(customPreviews).catch(() => {});
    }

    saveStdinToTab(stdinToTab);
    useBackgroundTaskStore.getState().renameTab(oldDraftId, newRealId);
    return { sessions, selectedSessionId, previousSessionId, runningSessions, backgroundTasks, stdinToTab, customPreviews };
  });
  },

  switchToPrevious: () => {
    const { previousSessionId, selectedSessionId, sessions } = get();
    if (!previousSessionId || previousSessionId === selectedSessionId) return;
    // Verify the previous session still exists
    const exists = sessions.some((s) => s.id === previousSessionId);
    if (!exists) return;
    set({
      selectedSessionId: previousSessionId,
      previousSessionId: selectedSessionId,
    });
  },

  loadCustomPreviewsFromDisk: async () => {
    try {
      const diskPreviews = await bridge.loadCustomPreviews();
      // Merge: disk data takes precedence, but keep any localStorage-only entries
      const localPreviews = get().customPreviews;
      const merged = { ...localPreviews, ...diskPreviews };
      saveCustomPreviewsLocal(merged);
      set({ customPreviews: merged });
    } catch {
      // Silently fall back to localStorage data
    }
  },

  getLastSessionId: () => loadLastSessionId(),

  searchSessionContent: async (query: string) => {
    set({ isContentSearching: true, contentSearchQuery: query });
    try {
      const results = await bridge.searchSessions(query);
      // Stale check: discard if query has changed while awaiting
      if (get().contentSearchQuery !== query) return;
      const map = new Map<string, ContentSearchResult>();
      for (const r of results) {
        map.set(r.session_id, r);
      }
      set({ contentSearchResults: map, isContentSearching: false });
    } catch {
      set({ isContentSearching: false });
    }
  },

  clearContentSearch: () => {
    set({
      contentSearchResults: new Map<string, ContentSearchResult>(),
      isContentSearching: false,
      contentSearchQuery: '',
    });
  },
}));
