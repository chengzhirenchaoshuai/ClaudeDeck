import { bridge, SessionListItem } from './tauri-bridge';
import { parseSessionMessages } from './session-loader';
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { LOCAL_ENV } from './remote';

/** 每个会话上次同步时的 JSONL 记录数，用于跳过没有变化的重复加载 */
const lastRecordCount = new Map<string, number>();

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

  const rawMessages = await bridge.loadSession(sessionPath);
  if (!stillSelected()) return false;
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
    });
  }

  for (const agent of agents) {
    agentStore.upsertAgent(agent);
  }

  for (const msg of messages) {
    if (msg.toolResultContent) {
      // For messages that have tool results, add the base message first, then update
      const { toolResultContent, ...baseMsg } = msg;
      chat.addMessage(sessionId, baseMsg);
      useChatStore.getState().updateMessage(sessionId, msg.id, { toolResultContent });
    } else {
      chat.addMessage(sessionId, msg);
    }
  }

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
  if (await isDrivenByThisApp(session.id)) return;
  try {
    await applyDiskSession(session.id, session.path, { skipIfUnchanged: !opts.force });
  } catch (err) {
    console.warn('[TOKENICODE] session sync failed:', err);
  }
}

/**
 * 全局刷新：重新拉取会话列表（远程环境下同时刷新远程会话），并强制重新读取当前打开的会话。
 * 供侧边栏顶部的“刷新”按钮调用。
 */
export async function refreshAll(): Promise<void> {
  const st = useSessionStore.getState();
  const current = st.sessions.find((s) => s.id === st.selectedSessionId);
  const isRemoteEnv = useSettingsStore.getState().activeEnv !== LOCAL_ENV;
  await Promise.allSettled([
    st.fetchSessions(),
    isRemoteEnv ? st.fetchRemoteSessions() : Promise.resolve(),
    syncSession(current, { force: true }),
  ]);
}
