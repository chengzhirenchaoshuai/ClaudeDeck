// 页面刷新后（F5、WebView 重新加载）重新接上仍存活的 CLI 进程。
// 后端进程不随页面刷新退出；标签页与进程的对应关系（stdinToTab）和各标签页的运行状态
// 都存在 sessionStorage 里，刷新后仍在，应用重启后清空。
import { useChatStore, pickProcessMeta, type ProcessMeta } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAgentStore } from '../../stores/agentStore';
import { bridge } from '../../lib/tauri-bridge';
import { dispatchToStreamHandler } from '../../lib/stream-listeners';
import { registerSessionListeners } from '../../components/chat/session-launch';
import { loadClaudeUuid, loadTokenState } from './token-state';

const RUNNING_TABS_KEY = 'claudedeck_running_tabs';
const PROCESS_META_KEY = 'claudedeck_process_meta';

/** 刷新前正在运行（回合进行中）的标签页 */
export function loadRunningTabs(): Set<string> {
  try {
    const ids = JSON.parse(sessionStorage.getItem(RUNNING_TABS_KEY) || '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 运行中的标签页变化时同步写入 sessionStorage，供刷新后判断哪些进程真的在运行。返回取消订阅的函数 */
export function persistRunningTabs(): () => void {
  return useSessionStore.subscribe((state, prev) => {
    if (state.runningSessions === prev.runningSessions) return;
    try {
      sessionStorage.setItem(RUNNING_TABS_KEY, JSON.stringify([...state.runningSessions]));
    } catch { /* 存不下时只影响刷新后的状态恢复 */ }
  });
}

/** 刷新前各进程的启动快照，按 stdinId */
export function loadProcessMeta(): Record<string, ProcessMeta> {
  try {
    const data = JSON.parse(sessionStorage.getItem(PROCESS_META_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * 各标签页进程的启动快照变化时写入 sessionStorage（按 stdinId，只存当前还挂在标签页上的进程）。
 * 流式输出时 sessionMeta 变化频繁（token 计数），只在快照内容真的变了时才写。返回取消订阅的函数
 */
export function persistProcessMeta(): () => void {
  let last = '';
  return useChatStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return;
    const data: Record<string, ProcessMeta> = {};
    for (const tab of state.tabs.values()) {
      const sid = tab.sessionMeta.stdinId;
      if (sid) data[sid] = pickProcessMeta(tab.sessionMeta);
    }
    const json = JSON.stringify(data);
    if (json === last) return;
    last = json;
    try {
      sessionStorage.setItem(PROCESS_META_KEY, json);
    } catch { /* 存不下时只影响刷新后的进程复用 */ }
  });
}

/**
 * 处理刷新后仍存活的后端进程：
 * - 有标签页对应的：重新注册完整的流监听（交给 InputBar 的流处理，result、后台任务、权限请求都照常处理）；
 *   刷新前回合正在进行的恢复为运行中，空闲的只接回 stdinId，保持空闲；
 * - 没有对应标签页的：孤儿进程，结束它。
 * wasRunning 必须在 persistRunningTabs 开始写入之前读取。
 */
export async function reconnectSessions(
  activeIds: string[],
  wasRunning: ReadonlySet<string>,
  processMeta: Record<string, ProcessMeta> = {},
): Promise<void> {
  const { stdinToTab } = useSessionStore.getState();
  for (const stdinId of activeIds) {
    const tabId = stdinToTab[stdinId];
    if (!tabId) {
      console.log('[ClaudeDeck:cleanup] killing orphaned process:', stdinId);
      bridge.killSession(stdinId).catch(() => {});
      continue;
    }
    const running = wasRunning.has(tabId);
    console.log('[ClaudeDeck:reconnect] reconnecting to:', stdinId, '→ tab:', tabId, running ? '(running)' : '(idle)');

    const chat = useChatStore.getState();
    chat.ensureTab(tabId);
    // 连同启动快照一起恢复，否则第一次发送时 dropStaleProcess 会因快照缺失而另开进程；
    // 标记从磁盘重新加载：刷新后内存里没有历史消息，之后收到的新消息也只是一部分
    chat.setSessionMeta(tabId, { ...processMeta[stdinId], stdinId, reloadFromDisk: true });
    restoreTokens(tabId);

    if (running) {
      chat.setSessionStatus(tabId, 'running');
      chat.setActivityStatus(tabId, { phase: 'thinking' });
      // 清掉从磁盘加载时残留的“已完成”代理，换成运行中的主代理；
      // 存进缓存，免得切换标签页时 restoreFromCache 因缓存缺失把它清掉
      const agents = useAgentStore.getState();
      agents.clearAgents();
      agents.upsertAgent({
        id: 'main',
        parentId: null,
        description: 'Reconnected',
        phase: 'thinking',
        startTime: Date.now(),
        isMain: true,
      });
      agents.saveToCache(tabId);
    }

    await registerSessionListeners(
      stdinId,
      () => tabId,
      dispatchToStreamHandler,
      (line) => console.warn('[ClaudeDeck:reconnect] stderr:', stdinId, line),
    );
  }
}

let started: Promise<void> | null = null;

/**
 * 启动时执行一次重新接上（之后的调用返回同一个 Promise）。
 * 恢复上次选中的会话前要等它完成：否则从磁盘加载会话时会把刚接回的进程和运行状态覆盖掉。
 * ConversationList 的 effect 比 App 的先执行，所以由先调用的一方启动。
 */
export function startReconnect(): Promise<void> {
  if (started) return started;
  const wasRunning = loadRunningTabs();
  const processMeta = loadProcessMeta();
  persistRunningTabs();
  persistProcessMeta();
  started = bridge.listActiveProcesses()
    .then((activeIds) => reconnectSessions(activeIds, wasRunning, processMeta))
    .catch((err) => console.warn('[ClaudeDeck:reconnect] failed:', err));
  return started;
}

/** 先用刷新前缓存的 token 状态，再用会话 JSONL 校正（JSONL 是权威值） */
function restoreTokens(tabId: string): void {
  const chat = useChatStore.getState();
  const cached = loadTokenState(tabId);
  if (cached) chat.setSessionMeta(tabId, cached);
  const claudeUuid = loadClaudeUuid(tabId);
  if (!claudeUuid) return;
  bridge.getSessionTokens(claudeUuid).then((jsonl) => {
    const current = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    useChatStore.getState().setSessionMeta(tabId, {
      totalInputTokens: Math.max(current.totalInputTokens ?? 0, jsonl.totalInputTokens),
      totalOutputTokens: Math.max(current.totalOutputTokens ?? 0, jsonl.totalOutputTokens),
    });
  }).catch(() => { /* 回合进行中 JSONL 可能还没写入，缓存值足够 */ });
}
