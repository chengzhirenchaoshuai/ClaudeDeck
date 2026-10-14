import { bridge, isRemotePath, SessionListItem } from './tauri-bridge';
import { parseSessionMessages } from './session-loader';
import { useChatStore, type ChatMessage } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUsageStore } from '../stores/usageStore';
import { LOCAL_ENV } from './remote';

/** 每个会话上次同步时的 JSONL 记录数，用于跳过没有变化的重复加载 */
const lastRecordCount = new Map<string, number>();
/** 每个会话上次加载时的 JSONL 文件大小（仅本机会话）。JSONL 只追加写入，大小没变就不必重新读取整个文件 */
const lastFileSize = new Map<string, number>();

/** 本机会话文件的大小；远程会话或读取失败返回 null（此时不做大小判断） */
async function localFileSize(path: string): Promise<number | null> {
  if (isRemotePath(path)) return null;
  return bridge.getFileSize(path).catch(() => null);
}

/** 该会话是否由本应用的 CLI 进程在驱动：是则内存中的状态比磁盘更完整，不能用磁盘内容覆盖 */
async function isDrivenByThisApp(sessionId: string): Promise<boolean> {
  const stdinId = useChatStore.getState().getTab(sessionId)?.sessionMeta.stdinId;
  if (!stdinId) return false;
  const active = await bridge.listActiveProcesses().catch(() => [] as string[]);
  return active.includes(stdinId);
}

/**
 * 从磁盘（本机 JSONL 或远端 ssh）读取会话并替换标签页里的消息、Agent 和 token 统计。
 * 读取期间用户切换了会话则放弃并返回 false。
 * skipIfUnchanged：JSONL 记录数与上次相同时不重复替换，避免无意义的刷新。
 */
export async function applyDiskSession(
  sessionId: string,
  sessionPath: string,
  opts: { skipIfUnchanged?: boolean } = {},
): Promise<boolean> {
  const stillSelected = () => useSessionStore.getState().selectedSessionId === sessionId;

  // 先取大小再读文件：读取期间文件又变大时，下次同步会因大小不同而重新加载
  const fileSize = await localFileSize(sessionPath);
  const rawMessages = await bridge.loadSession(sessionPath);
  if (!stillSelected()) return false;
  if (fileSize !== null) lastFileSize.set(sessionId, fileSize);
  if (opts.skipIfUnchanged && lastRecordCount.get(sessionId) === rawMessages.length) return false;

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
 * - 草稿（尚未落盘）和正由本应用进程驱动的会话不处理。
 * - 自动同步只处理“从磁盘加载过”的会话：由本应用创建的会话，内存里有磁盘上没有的卡片
 *   （权限确认、命令处理等），不能被磁盘内容覆盖。
 * - force 为 true（手动同步）时不受以上限制，并且即使内容看起来没变也重新加载。
 */
export async function syncSession(
  session: SessionListItem | undefined,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!session || !session.path) return;
  if (!opts.force && !lastRecordCount.has(session.id)) return;
  // 文件大小没变就跳过：避免每次轮询都把整个 JSONL 传到前端解析（大会话会让界面周期性卡顿）
  if (!opts.force) {
    const size = await localFileSize(session.path);
    if (size !== null && lastFileSize.get(session.id) === size) return;
  }
  if (await isDrivenByThisApp(session.id)) return;
  try {
    await applyDiskSession(session.id, session.path, { skipIfUnchanged: !opts.force });
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
