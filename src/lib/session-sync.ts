import { bridge, isRemotePath, SessionListItem } from './tauri-bridge';
import { parseSessionMessages } from './session-loader';
import { useChatStore, type ChatMessage } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUsageStore } from '../stores/usageStore';
import { LOCAL_ENV } from './remote';
import { releaseStreamListener } from './stream-listeners';

/** 每个会话上次同步时的 JSONL 记录数，用于跳过没有变化的重复加载 */
const lastRecordCount = new Map<string, number>();
/** 每个会话上次加载时的 JSONL 文件大小（仅本机会话）。JSONL 只追加写入，大小没变就不必重新读取整个文件 */
const lastFileSize = new Map<string, number>();

/** 已读取的原始记录与读到的字节偏移（仅本机会话），同步时只读取新追加的部分 */
const rawCache = new Map<string, { path: string; records: any[]; end: number }>();
/** 最多缓存的会话数：只有正在查看的会话需要，留几个给来回切换 */
const RAW_CACHE_LIMIT = 4;

/**
 * 读取会话的全部原始记录。本机会话按字节偏移增量读取，再与缓存拼接；
 * 远程会话或 full 为 true 时整个读取。changed 为 false 表示自上次读取以来没有新记录。
 */
async function readSessionRecords(
  sessionId: string,
  path: string,
  full: boolean,
): Promise<{ records: any[]; changed: boolean }> {
  if (isRemotePath(path)) return { records: await bridge.loadSession(path), changed: true };
  const cached = !full ? rawCache.get(sessionId) : undefined;
  const usable = cached && cached.path === path ? cached : undefined;
  const tail = await bridge.loadSessionTail(path, usable?.end ?? 0);
  let records: any[];
  if (tail.reset || !usable) {
    records = tail.records;
  } else if (tail.records.length === 0) {
    records = usable.records;
  } else {
    records = usable.records.concat(tail.records);
  }
  rawCache.delete(sessionId);
  rawCache.set(sessionId, { path, records, end: tail.end });
  // Map 按插入顺序迭代，删掉最早的
  while (rawCache.size > RAW_CACHE_LIMIT) {
    rawCache.delete(rawCache.keys().next().value as string);
  }
  return { records, changed: !usable || tail.reset || tail.records.length > 0 };
}

/** 本机会话文件的大小；远程会话或读取失败返回 null（此时不做大小判断） */
async function localFileSize(path: string): Promise<number | null> {
  if (isRemotePath(path)) return null;
  return bridge.getFileSize(path).catch(() => null);
}

/** 本应用驱动该会话的 CLI 进程（stdinId）；没有或进程已退出时返回 undefined */
async function appProcessOf(sessionId: string): Promise<string | undefined> {
  const stdinId = useChatStore.getState().getTab(sessionId)?.sessionMeta.stdinId;
  if (!stdinId) return undefined;
  const active = await bridge.listActiveProcesses().catch(() => [] as string[]);
  return active.includes(stdinId) ? stdinId : undefined;
}

/** 会话最新的记录是否由外部（终端里的 claude）写入：终端为 "cli"，本应用为 "sdk-cli" */
async function writtenExternally(path: string): Promise<boolean> {
  if (isRemotePath(path)) return false;
  const entry = await bridge.sessionLastEntrypoint(path).catch(() => null);
  return entry === 'cli';
}

/**
 * 从磁盘（本机 JSONL 或远端 ssh）读取会话并替换标签页里的消息、Agent 和 token 统计。
 * 读取期间用户切换了会话则放弃并返回 false。
 * skipIfUnchanged：JSONL 记录数与上次相同时不重复替换，避免无意义的刷新。
 */
export async function applyDiskSession(
  sessionId: string,
  sessionPath: string,
  opts: { skipIfUnchanged?: boolean; full?: boolean } = {},
): Promise<boolean> {
  const stillSelected = () => useSessionStore.getState().selectedSessionId === sessionId;

  // 先取大小再读文件：读取期间文件又变大时，下次同步会因大小不同而重新加载
  const fileSize = await localFileSize(sessionPath);
  // 本机会话只读新追加的部分，与缓存拼接；full（手动刷新）时整个重读
  const { records: rawMessages, changed } = await readSessionRecords(sessionId, sessionPath, !!opts.full);
  if (!stillSelected()) return false;
  if (fileSize !== null) lastFileSize.set(sessionId, fileSize);
  if (opts.skipIfUnchanged && (!changed || lastRecordCount.get(sessionId) === rawMessages.length)) return false;

  const { messages, agents } = parseSessionMessages(rawMessages);

  // Restore both billing totals and the latest occupied-context snapshot.
  // Persisted Claude JSONL contains full assistant usage records; without
  // this step, selecting a historical session incorrectly resets Ctx to 0.
  const tokenUsage = await bridge.getSessionTokens(sessionId).catch(() => null);
  if (!stillSelected()) return false;

  const chat = useChatStore.getState();
  const agentStore = useAgentStore.getState();
  chat.clearMessages(sessionId);
  agentStore.clearAgents();

  if (tokenUsage) {
    chat.setSessionMeta(sessionId, {
      inputTokens: tokenUsage.contextInputTokens,
      outputTokens: tokenUsage.contextOutputTokens,
      contextInputTokens: tokenUsage.contextInputTokens,
      contextOutputTokens: tokenUsage.contextOutputTokens,
      totalInputTokens: tokenUsage.totalInputTokens,
      totalOutputTokens: tokenUsage.totalOutputTokens,
      // 记下会话实际使用的模型：否则上下文窗口会按当前选中的模型算，
      // 1M 上下文的会话在选中 200K 模型时会被错误地显示成 100%
      ...(tokenUsage.model ? { model: tokenUsage.model } : {}),
    });
  }

  for (const agent of agents) {
    agentStore.upsertAgent(agent);
  }

  // 一次性写入：与逐条 addMessage 的结果相同（同 ID 的消息合并到首次出现的位置），
  // 但只复制一次数组、只通知一次订阅者，大会话切换时不再卡顿
  const merged: ChatMessage[] = [];
  const indexById = new Map<string, number>();
  for (const msg of messages) {
    const idx = indexById.get(msg.id);
    if (idx === undefined) {
      indexById.set(msg.id, merged.length);
      merged.push(msg);
    } else {
      merged[idx] = { ...merged[idx], ...msg };
    }
  }
  chat.setMessages(sessionId, merged);

  lastRecordCount.set(sessionId, rawMessages.length);
  return true;
}

/**
 * 同步一个已在界面中打开的会话：重新读取磁盘上的最新内容。
 * - 草稿（尚未落盘）不处理。
 * - 由本应用驱动（有存活的 CLI 进程）或由本应用创建的会话，内存里有磁盘上没有的卡片
 *   （权限确认、命令处理等），平时不用磁盘内容覆盖；但最新记录来自终端里的 claude 时，
 *   说明会话已在外部继续：结束本应用闲置的旧进程（它的上下文已过时，下次发送会 --resume
 *   续接最新内容），改为显示磁盘内容。本应用正在回复时不打断。
 * - force 为 true（手动同步）时即使内容看起来没变也重新加载。
 */
export async function syncSession(
  session: SessionListItem | undefined,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!session || !session.path) return;
  // 文件大小没变就跳过：避免每次轮询都把整个 JSONL 传到前端解析（大会话会让界面周期性卡顿）
  const size = await localFileSize(session.path);
  if (!opts.force && size !== null && lastFileSize.get(session.id) === size) return;

  const appProcess = await appProcessOf(session.id);
  const ownedByApp = !!appProcess || !lastRecordCount.has(session.id);
  if (ownedByApp && !(opts.force && !appProcess)) {
    if (!(await writtenExternally(session.path))) {
      // 本应用自己写入的变化：记下大小，避免每次轮询都重复检查
      if (size !== null) lastFileSize.set(session.id, size);
      return;
    }
    const tab = useChatStore.getState().getTab(session.id);
    if (tab?.sessionStatus === 'running') return;
    if (appProcess) {
      bridge.killSession(appProcess).catch(() => {});
      releaseStreamListener(appProcess);
      useChatStore.getState().setSessionMeta(session.id, { stdinId: undefined });
    }
  }
  try {
    await applyDiskSession(session.id, session.path, { skipIfUnchanged: !opts.force, full: opts.force });
  } catch (err) {
    console.warn('[ClaudeDeck] session sync failed:', err);
  }
}

/**
 * 全局刷新：重新拉取会话列表（远程环境下同时刷新远程会话）、今日用量/余额，
 * 并强制重新读取当前打开的会话（含上下文占用）。供侧边栏“刷新”按钮调用。
 */
export async function refreshAll(): Promise<void> {
  const st = useSessionStore.getState();
  const current = st.sessions.find((s) => s.id === st.selectedSessionId);
  const isRemoteEnv = useSettingsStore.getState().activeEnv !== LOCAL_ENV;
  const usage = useUsageStore.getState();
  await Promise.allSettled([
    st.fetchSessions(),
    isRemoteEnv ? st.fetchRemoteSessions() : Promise.resolve(),
    syncSession(current, { force: true }),
    usage.refresh(true),
    usage.refreshBalance(),
  ]);
}
