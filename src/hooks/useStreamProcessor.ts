import { useCallback } from 'react';
import { useChatStore, generateMessageId, type ChatMessage, type SessionStatus, type SessionMeta, type ActivityStatus } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgentStore, resolveAgentId, getAgentDepth } from '../stores/agentStore';
import { useRateLimitsStore } from '../stores/rateLimitsStore';
import type { StreamMessage } from '../lib/stream-message';
import { formatErrorForUser } from './stream/errors';
import { persistClaudeUuid } from './stream/token-state';
import { bufferStreamDelta, flushStreamBuffer } from './stream/buffer';
import type { StreamContext, StreamProcessorConfig } from './stream/context';
import { handlePermissionRequest } from './stream/handlers/permission-request';
import { handleStreamEvent } from './stream/handlers/stream-event';
import { handleSystemMessage } from './stream/handlers/system';
import { handleAssistantMessage } from './stream/handlers/assistant';
import { handleUserMessage } from './stream/handlers/user';
import { handleToolResult } from './stream/handlers/tool-result';
import { handleResultMessage } from './stream/handlers/result';
import { handleProcessExit } from './stream/handlers/process-exit';

export type { StreamProcessorConfig } from './stream/context';

/** 已知的消息类型；StreamMessage 新增类型时这里必须同步补上（否则类型检查报错） */
const KNOWN_TYPES: Record<StreamMessage['type'], true> = {
  tokenicode_permission_request: true,
  stream_event: true,
  system: true,
  assistant: true,
  user: true,
  human: true,
  tool_result: true,
  tool_use_summary: true,
  result: true,
  process_exit: true,
  content_block_delta: true,
  rate_limit_event: true,
};

/**
 * useStreamProcessor — extracts stream message handling from InputBar.
 *
 * 返回 handleStreamMessage：所有会话的流消息都交给它，内部按 stdinId 路由到所属标签页，
 * 前台、后台共用同一套处理逻辑。
 */
export function useStreamProcessor(config: StreamProcessorConfig) {
  const {
    exitPlanModeSeenRef,
    autoCompactFiredRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  } = config;

  /**
   * 处理一条流消息。前台、后台标签页共用同一套逻辑：按 stdinId 找到所属标签页后
   * 写入该标签页的状态。依赖 InputBar 实例状态（各种 ref）、agentStore（只保存当前
   * 标签页）或“当前选中标签页”的动作只在前台执行，见 isForeground 判断。
   */
  const handleStreamMessage = useCallback((msg: StreamMessage) => {
    if (!msg || !msg.type) return;

    // 出错时把错误写到消息所属的标签页；路由完成前退回当前选中的标签页
    let errTabId: string | null = useSessionStore.getState().selectedSessionId;

    try { // P1-4: error boundary — prevent uncaught exceptions from crashing the stream pipeline

    // 诊断：记录 system/exit，并提示未知消息类型
    if (msg.type === 'system' || msg.type === 'process_exit') {
      console.log('[ClaudeDeck:stream]', msg.type, msg.type === 'system' ? msg.subtype : '', msg.__stdinId || '');
    }
    if (!Object.prototype.hasOwnProperty.call(KNOWN_TYPES, msg.type)) {
      console.warn('[ClaudeDeck:stream] unhandled message type:', msg.type, msg);
    }

    // --- 路由：按 stdinId 找到消息所属的标签页 ---
    // 必须在所有处理之前完成，避免后台会话的消息写进当前标签页。
    const msgStdinId = msg.__stdinId;
    const ownerTabId = msgStdinId
      ? useSessionStore.getState().getTabForStdin(msgStdinId)
      : undefined;
    const activeTabId = useSessionStore.getState().selectedSessionId;
    const routedTabId = ownerTabId || activeTabId;
    if (!routedTabId) return;
    let tabId: string = routedTabId;
    errTabId = tabId;
    const isForeground = tabId === activeTabId;
    if (!isForeground && msg.type !== 'stream_event') {
      console.log('[ClaudeDeck:route] background:', msg.type, 'owner:', tabId, 'active:', activeTabId);
    }

    // Update lastProgressAt on every stream event for stall detection
    useChatStore.getState().setSessionMeta(tabId, { lastProgressAt: Date.now() });

    // --- SDK Permission Request (routed through stream channel for reliability) ---
    if (msg.type === 'tokenicode_permission_request') {
      handlePermissionRequest(msg, tabId, msgStdinId);
      return;
    }

    const cs = useChatStore.getState();
    const addMessage = (message: ChatMessage) => cs.addMessage(tabId, message);
    const setSessionStatus = (status: SessionStatus) => cs.setSessionStatus(tabId, status);
    const setSessionMeta = (meta: Partial<SessionMeta>) => cs.setSessionMeta(tabId, meta);
    const setActivityStatus = (status: ActivityStatus) => cs.setActivityStatus(tabId, status);
    // agentStore 只保存当前标签页的代理树，后台标签页不更新它
    const agentActions = isForeground ? useAgentStore.getState() : null;
    const agentId = agentActions ? resolveAgentId(msg.parent_tool_use_id, agentActions.agents) : 'main';
    const agentDepth = agentActions ? getAgentDepth(agentId, agentActions.agents) : undefined;

    // Capture the CLI's own session ID from stream events (used for --resume)
    const cliSessionId = msg.session_id || msg.sessionId;
    if (cliSessionId) {
      const currentId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId;
      if (currentId !== cliSessionId) {
        setSessionMeta({ sessionId: cliSessionId });
        // Persist Claude session UUID for F5 recovery (token totals read from JSONL)
        persistClaudeUuid(tabId, cliSessionId);

        // Promote draft tab to real session ID so it merges with disk session
        if (tabId.startsWith('draft_')) {
          // Migrate tab data under old draft key to new real key
          const chatState = useChatStore.getState();
          const tabData = chatState.getTab(tabId);
          if (tabData) {
            const newTabs = new Map(chatState.tabs);
            newTabs.set(cliSessionId, { ...tabData, tabId: cliSessionId });
            newTabs.delete(tabId);
            useChatStore.setState({ tabs: newTabs });
          }
          useSessionStore.getState().promoteDraft(tabId, cliSessionId);
          // Update UUID index: tab key changed from draft_* to the real UUID
          persistClaudeUuid(cliSessionId, cliSessionId);
          // 标签页已改用真实 ID，本条消息后续的写入也要跟着改
          tabId = cliSessionId;
          errTabId = tabId;
        }

        useSessionStore.getState().fetchSessions();
      }
    }

    // Helper: clear accumulated partial text (it will be replaced by the full message)
    const clearPartial = () => {
      // Flush any buffered text so the final tokens aren't lost
      flushStreamBuffer(msgStdinId);
      const tabData = useChatStore.getState().getTab(tabId);
      if (tabData && (tabData.isStreaming || tabData.partialText || tabData.partialThinking)) {
        const newTabs = new Map(useChatStore.getState().tabs);
        newTabs.set(tabId, { ...tabData, partialText: '', partialThinking: '', isStreaming: false });
        useChatStore.setState({ tabs: newTabs });
      }
    };

    const ctx: StreamContext = {
      tabId,
      msgStdinId,
      isForeground,
      agentActions,
      agentId,
      agentDepth,
      config: {
        exitPlanModeSeenRef,
        autoCompactFiredRef,
        silentRestartRef,
        handleSubmitRef,
        handleStderrLineRef,
        lastStderrRef,
        setInputSync,
      },
      dispatch: handleStreamMessage,
      addMessage,
      setSessionStatus,
      setSessionMeta,
      setActivityStatus,
      clearPartial,
    };

    switch (msg.type) {
      case 'stream_event':
        handleStreamEvent(ctx, msg);
        break;
      case 'system':
        handleSystemMessage(ctx, msg);
        break;
      case 'assistant':
        handleAssistantMessage(ctx, msg);
        break;
      case 'user':
      case 'human':
        handleUserMessage(ctx, msg);
        break;
      case 'tool_result':
        handleToolResult(ctx, msg);
        break;
      case 'tool_use_summary':
        break;
      // 5h/7d 用量是账户级数据：任何会话（含后台标签页）收到都更新同一份全局缓存
      case 'rate_limit_event':
        if (msg.rate_limit_info) useRateLimitsStore.getState().setFromEvent(msg.rate_limit_info);
        break;
      case 'result':
        handleResultMessage(ctx, msg);
        break;
      case 'process_exit':
        handleProcessExit(ctx, msg);
        break;
      default:
        // Fallback: handle content_block_delta at top level (without stream_event wrapper)
        if (msg.type === 'content_block_delta') {
          const text = msg.delta?.text || '';
          if (text && msgStdinId) {
            bufferStreamDelta(msgStdinId, 'text', text);
          }
        }
        break;
    }

    } catch (err) {
      // P1-4: catch-all for unexpected errors in stream message processing
      console.error('[ClaudeDeck] handleStreamMessage error:', err, 'msg:', msg?.type, msg?.type === 'system' || msg?.type === 'result' ? msg.subtype : '');
      if (errTabId) {
        useChatStore.getState().addMessage(errTabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: formatErrorForUser(`Internal error processing stream message: ${err}`),
          timestamp: Date.now(),
        });
      }
    }
  }, [exitPlanModeSeenRef, autoCompactFiredRef, silentRestartRef, handleSubmitRef, handleStderrLineRef, lastStderrRef, setInputSync]);

  return { handleStreamMessage };
}
