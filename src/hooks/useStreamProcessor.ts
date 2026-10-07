import { useCallback, type MutableRefObject } from 'react';
import { useChatStore, generateMessageId, type ChatMessage } from '../stores/chatStore';
import {
  useSettingsStore,
  mapSessionModeToPermissionMode,
  getEffectiveMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgentStore, resolveAgentId, getAgentDepth } from '../stores/agentStore';
import { useFileStore } from '../stores/fileStore';
import { bridge, onClaudeStream, onClaudeStderr } from '../lib/tauri-bridge';
import { releaseStreamListener, setStreamListener } from '../lib/stream-listeners';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../lib/api-provider';
import { useProviderStore } from '../stores/providerStore';
import { t } from '../lib/i18n';
import {
  getContextInputTokens,
  getContextOutputTokens,
  getContextUsedTokens,
  hasMeaningfulContextUsage,
  type TokenUsage,
} from '../lib/context-usage';
import { toolResultText, type StreamMessage } from '../lib/stream-message';
import { resolveSessionContextWindow } from '../lib/context-window';

// --- Error classification for user-facing messages ---
// Each pattern maps to a friendly i18n key. Matched errors show the friendly
// message as primary text with raw error in a collapsible details block.
// Unmatched errors get a generic fallback + raw details.
const ERROR_CATEGORIES: ReadonlyArray<{ pattern: RegExp; i18nKey: string }> = [
  { pattern: /40[13]|unauthorized|invalid.*key|api.key.*invalid/i, i18nKey: 'error.invalidKey' },
  { pattern: /429|rate.limit|too.many.request/i, i18nKey: 'error.rateLimit' },
  { pattern: /quota|insufficient.*balance|credit|billing/i, i18nKey: 'error.quotaExceeded' },
  { pattern: /model.*not.found|invalid.*model|not_found.*model/i, i18nKey: 'error.modelNotFound' },
  { pattern: /timeout|timed?.out|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, i18nKey: 'error.networkError' },
  { pattern: /network|fetch.failed|dns/i, i18nKey: 'error.networkError' },
  { pattern: /permission.denied|operation.not.permitted|access.denied|forbidden/i, i18nKey: 'error.permissionDenied' },
  { pattern: /overloaded|capacity|503|service.unavailable/i, i18nKey: 'error.serviceUnavailable' },
  { pattern: /not.installed|command.not.found/i, i18nKey: 'error.cliNotInstalled' },
  { pattern: /token.*limit|context.*length|too.long/i, i18nKey: 'error.tokenLimit' },
];

export function formatErrorForUser(raw: string): string {
  if (!raw || raw.length < 10) return raw;
  const match = ERROR_CATEGORIES.find((c) => c.pattern.test(raw));
  const friendly = match ? t(match.i18nKey) : t('error.genericFallback');
  return `${friendly}\n\n<details>\n<summary>${t('error.showDetails')}</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n\n</details>`;
}

// --- Token state cache + Claude UUID index (survives F5 via sessionStorage) ---
// Token persistence: real-time cache for F5 recovery during active streaming.
// UUID index: maps tabId → Claude session UUID for JSONL cross-check on reconnect.

const TOKEN_STATE_KEY = 'tokenicode_token_state_v2';
const UUID_INDEX_KEY = 'tokenicode_claude_uuids';

function _persistTokenState(tabId: string, meta: {
  inputTokens?: number;
  outputTokens?: number;
  contextInputTokens?: number;
  contextOutputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}) {
  try {
    const data = JSON.parse(sessionStorage.getItem(TOKEN_STATE_KEY) || '{}');
    data[tabId] = {
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      contextInputTokens: meta.contextInputTokens,
      contextOutputTokens: meta.contextOutputTokens,
      totalInputTokens: meta.totalInputTokens,
      totalOutputTokens: meta.totalOutputTokens,
    };
    sessionStorage.setItem(TOKEN_STATE_KEY, JSON.stringify(data));
  } catch {/* ignore */}
}

function contextSnapshot(usage: TokenUsage | undefined): {
  contextInputTokens: number;
  contextOutputTokens: number;
} | null {
  if (!hasMeaningfulContextUsage(usage)) return null;
  return {
    contextInputTokens: getContextInputTokens(usage),
    contextOutputTokens: getContextOutputTokens(usage),
  };
}

function _persistClaudeUuid(tabId: string, claudeUuid: string) {
  try {
    const data = JSON.parse(sessionStorage.getItem(UUID_INDEX_KEY) || '{}');
    data[tabId] = claudeUuid;
    sessionStorage.setItem(UUID_INDEX_KEY, JSON.stringify(data));
  } catch {/* ignore */}
}

export function loadClaudeUuid(tabId: string): string | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(UUID_INDEX_KEY) || '{}');
    return data[tabId] || null;
  } catch {
    return null;
  }
}

// --- Streaming text buffer (rAF-throttled + interval fallback, per-stdinId) ---
// Coalesces rapid text_delta / thinking_delta events into a single state update
// per animation frame (~60/s), preventing JS main thread starvation from
// excessive React re-renders when the message list is large.
//
// CRITICAL: rAF alone is unreliable — heavy React re-renders can block the
// rendering pipeline, preventing rAF callbacks from firing. A 200ms setInterval
// fallback ensures buffered text is always flushed even when rAF is starved.
//
// TK-329 fix: each session gets its own buffer to prevent cross-contamination
// when multiple sessions stream concurrently.
interface _StreamBuffer {
  text: string;
  thinking: string;
  raf: number;
}
const _streamBuffers = new Map<string, _StreamBuffer>();

// Interval fallback: flush any stuck buffers every 200ms
let _flushIntervalId: ReturnType<typeof setInterval> | null = null;

function _ensureFlushInterval() {
  if (_flushIntervalId) return;
  _flushIntervalId = setInterval(() => {
    for (const [stdinId, buf] of _streamBuffers) {
      if (buf.text || buf.thinking) {
        _doFlush(stdinId, buf);
      }
    }
    // Stop interval when no active buffers remain
    if (_streamBuffers.size === 0 && _flushIntervalId) {
      clearInterval(_flushIntervalId);
      _flushIntervalId = null;
    }
  }, 200);
}

function _getBuffer(stdinId: string): _StreamBuffer {
  let buf = _streamBuffers.get(stdinId);
  if (!buf) {
    buf = { text: '', thinking: '', raf: 0 };
    _streamBuffers.set(stdinId, buf);
  }
  return buf;
}

/** Core flush logic — shared by rAF callback and interval fallback. */
function _doFlush(stdinId: string, buf: _StreamBuffer) {
  if (!buf.text && !buf.thinking) return;

  const mappedId = useSessionStore.getState().getTabForStdin(stdinId);
  const tabId = mappedId || useSessionStore.getState().selectedSessionId || undefined;
  if (!mappedId && tabId) {
    console.warn('[stream-flush] stdinId mapping missing, fallback to selectedSessionId:', stdinId, '→', tabId);
    useSessionStore.getState().registerStdinTab(stdinId, tabId);
  }
  if (!tabId) {
    // No active tab to render into — the selectedSessionId is likely null
    // (e.g. app just launched, no tab selected yet). Log and discard buffered
    // text so stale data won't be flushed to the wrong tab later.
    console.warn('[stream-flush] no tabId for stdinId:', stdinId,
      'mappedId:', mappedId,
      'selectedSessionId:', useSessionStore.getState().selectedSessionId,
      'dropping text:', buf.text.slice(0, 80),
      'dropping thinking:', buf.thinking.slice(0, 80));
    buf.text = '';
    buf.thinking = '';
    return;
  }

  const store = useChatStore.getState();
  if (buf.text) {
    store.updatePartialMessage(tabId, buf.text);
    buf.text = '';
  }
  if (buf.thinking) {
    store.updatePartialThinking(tabId, buf.thinking);
    buf.thinking = '';
  }
}

function _scheduleStreamFlush(stdinId: string) {
  const buf = _getBuffer(stdinId);
  // Start the interval fallback on first buffer activity
  _ensureFlushInterval();
  if (buf.raf) return;
  buf.raf = requestAnimationFrame(() => {
    buf.raf = 0;
    _doFlush(stdinId, buf);
  });
}

/** Flush any buffered streaming text immediately (call before clearPartial).
 *  If stdinId is provided, flush only that session's buffer.
 *  If omitted, flush ALL buffers (backward compat). */
export function flushStreamBuffer(stdinId?: string) {
  const ids = stdinId ? [stdinId] : Array.from(_streamBuffers.keys());

  for (const id of ids) {
    const buf = _streamBuffers.get(id);
    if (!buf) continue;

    if (buf.raf) {
      cancelAnimationFrame(buf.raf);
      buf.raf = 0;
    }
    _doFlush(id, buf);
  }

  // Clean up buffers and stop interval when all cleared
  if (!stdinId) {
    _streamBuffers.clear();
  } else {
    _streamBuffers.delete(stdinId);
  }
  if (_streamBuffers.size === 0 && _flushIntervalId) {
    clearInterval(_flushIntervalId);
    _flushIntervalId = null;
  }
}

/** Preserve streamed text when a provider omits the final full assistant event. */
function commitPartialText(tabId: string, stdinId?: string): boolean {
  flushStreamBuffer(stdinId);
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const content = tab?.partialText?.trim();
  if (!content) return false;

  const alreadyPresent = tab?.messages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && message.content.trim() === content,
  );
  if (!alreadyPresent) {
    store.addMessage(tabId, {
      id: generateMessageId(),
      role: 'assistant',
      type: 'text',
      content,
      timestamp: Date.now(),
    });
  }
  return true;
}

export function hasAssistantReplyForTurn(messages: ChatMessage[], turnStartTime: number): boolean {
  return messages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && !!message.content.trim()
      && message.timestamp >= turnStartTime,
  );
}

// --- File tree auto-refresh on file-mutating tool completions ---
// Tools that may create/modify/delete files in the working directory.
const FILE_MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Bash', 'BatchTool',
]);

// Debounce tree refresh to batch rapid tool completions (e.g. parallel agents).
let _fileRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleFileTreeRefresh() {
  if (_fileRefreshTimer) return; // already scheduled
  _fileRefreshTimer = setTimeout(() => {
    _fileRefreshTimer = null;
    useFileStore.getState().refreshTree();
  }, 300);
}

/**
 * If the tool_result's parent tool_use was a file-mutating tool,
 * schedule a debounced file tree refresh.
 */
function _maybeRefreshFileTree(tabId: string, toolUseId?: string, toolName?: string) {
  // Fast path: tool_name available directly on the message
  if (toolName && FILE_MUTATING_TOOLS.has(toolName)) {
    _scheduleFileTreeRefresh();
    return;
  }
  // Fallback: look up parent tool_use message
  if (toolUseId) {
    const messages = useChatStore.getState().getTab(tabId)?.messages ?? [];
    const parent = messages.find((m) => m.id === toolUseId);
    if (parent?.toolName && FILE_MUTATING_TOOLS.has(parent.toolName)) {
      _scheduleFileTreeRefresh();
    }
  }
}

/**
 * Configuration refs and callbacks that the stream processor needs
 * from the parent InputBar component.
 */
export interface StreamProcessorConfig {
  exitPlanModeSeenRef: MutableRefObject<boolean>;
  autoCompactFiredRef: MutableRefObject<boolean>;
  silentRestartRef: MutableRefObject<boolean>;
  handleSubmitRef: MutableRefObject<() => void>;
  handleStderrLineRef: MutableRefObject<(line: string, sid: string) => void>;
  /** Last stderr error line — displayed to user if process exits without response */
  lastStderrRef: MutableRefObject<string>;
  setInputSync: (text: string) => void;
}

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

    // Diagnostic: log first message and unrecognized types
    const KNOWN_TYPES = new Set([
      'tokenicode_permission_request', 'stream_event', 'system', 'assistant',
      'user', 'human', 'tool_result', 'tool_use_summary', 'result', 'process_exit',
      'content_block_delta', 'rate_limit_event',
    ]);
    if (msg.type === 'system' || msg.type === 'process_exit') {
      console.log('[ClaudeDeck:stream]', msg.type, msg.type === 'system' ? msg.subtype : '', msg.__stdinId || '');
    }
    if (!KNOWN_TYPES.has(msg.type)) {
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

      // ExitPlanMode: only show PlanReviewCard in Plan mode.
      // In other modes, auto-approve so the CLI continues without blocking.
      if (msg.tool_name === 'ExitPlanMode') {
        const tabState = useChatStore.getState().getTab(tabId);
        if (getEffectiveMode(tabState?.sessionMeta) !== 'plan') {
          // Auto-approve: CLI doesn't need user confirmation outside Plan mode
          const stdinId = msgStdinId || tabState?.sessionMeta.stdinId;
          if (stdinId) {
            bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
          }
          return;
        }
        const chatStore = useChatStore.getState();
        const messages = tabState?.messages ?? [];
        const permData = {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          description: msg.description,
          toolUseId: msg.tool_use_id,
        };
        const planReview = messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
        if (planReview) {
          chatStore.updateMessage(tabId, 'plan_review_current', { permissionData: permData });
        } else {
          // PlanReviewCard not yet created — create one with permission data
          let planContent = '';
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' && messages[i].type === 'text' && messages[i].content) {
              planContent = messages[i].content;
              break;
            }
          }
          chatStore.addMessage(tabId, {
            id: 'plan_review_current',
            role: 'assistant',
            type: 'plan_review',
            content: planContent,
            planContent: planContent,
            resolved: false,
            permissionData: permData,
            timestamp: Date.now(),
          });
          chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        }
        return;
      }

      // AskUserQuestion: create QuestionCard instead of PermissionCard.
      // User answers are sent back via respondPermission(updatedInput) — NOT sendStdin.
      if (msg.tool_name === 'AskUserQuestion') {
        const chatStore = useChatStore.getState();
        const messages = chatStore.getTab(tabId)?.messages ?? [];
        const questionId = msg.tool_use_id || 'ask_question_current';
        // Search by exact ID first, then fall back to any unresolved AskUserQuestion.
        // This handles the race condition where the assistant message arrives first
        // with block.id (e.g. "toolu_01abc") and the control_request arrives later
        // with a different or missing tool_use_id.
        const existing = messages.find((m) => m.id === questionId && m.type === 'question')
          || messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
        if (existing) {
          // Patch permissionData so QuestionCard uses respondPermission (SDK path)
          // instead of sendStdin (legacy path). Always update — even if permissionData
          // exists — because a new control_request supersedes a stale one.
          chatStore.updateMessage(tabId, existing.id, {
            permissionData: {
              requestId: msg.request_id,
              toolName: msg.tool_name,
              input: msg.input,
              toolUseId: msg.tool_use_id,
            },
            toolInput: msg.input,
          });
          return;
        }
        const questions = msg.input?.questions;
        chatStore.addMessage(tabId, {
          id: questionId,
          role: 'assistant',
          type: 'question',
          content: '',
          toolName: 'AskUserQuestion',
          toolInput: msg.input,
          questions: Array.isArray(questions) ? questions : [],
          resolved: false,
          timestamp: Date.now(),
          // Attach permission data so QuestionCard uses respondPermission instead of sendStdin
          permissionData: {
            requestId: msg.request_id,
            toolName: msg.tool_name,
            input: msg.input,
            toolUseId: msg.tool_use_id,
          },
        });
        chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        return;
      }

      // Dedup: skip if we already have a non-failed PermissionCard for this request_id
      const chatStore = useChatStore.getState();
      const messages = chatStore.getTab(tabId)?.messages ?? [];
      const existingPerm = messages.find(
        (m) => m.type === 'permission'
          && m.permissionData?.requestId === msg.request_id
          && m.interactionState !== 'failed'
      );
      if (existingPerm) {
        return;
      }
      chatStore.addMessage(tabId, {
        id: generateMessageId(),
        role: 'assistant',
        type: 'permission',
        content: msg.description || `${msg.tool_name} wants to execute`,
        permissionTool: msg.tool_name,
        permissionDescription: msg.description || '',
        timestamp: Date.now(),
        interactionState: 'pending',
        permissionData: {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          description: msg.description,
          toolUseId: msg.tool_use_id,
        },
      });
      chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
      return;
    }

    const cs = useChatStore.getState();
    const addMessage = (message: ChatMessage) => cs.addMessage(tabId, message);
    const setSessionStatus = (status: import('../stores/chatStore').SessionStatus) => cs.setSessionStatus(tabId, status);
    const setSessionMeta = (meta: Partial<import('../stores/chatStore').SessionMeta>) => cs.setSessionMeta(tabId, meta);
    const setActivityStatus = (status: import('../stores/chatStore').ActivityStatus) => cs.setActivityStatus(tabId, status);
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
        _persistClaudeUuid(tabId, cliSessionId);

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
          _persistClaudeUuid(cliSessionId, cliSessionId);
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

    switch (msg.type) {
      // --- stream_event: wrapper for real-time streaming events from --include-partial-messages ---
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;

        // Diagnostic: log tool_use starts for debugging plan mode flow
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          console.log('[ClaudeDeck:stream] tool_use start:', evt.content_block.name);
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text && msgStdinId) {
            // Buffer text and flush via rAF to avoid excessive re-renders
            // TK-329: per-stdinId buffer prevents cross-session contamination
            const buf = _getBuffer(msgStdinId);
            buf.text += text;
            _scheduleStreamFlush(msgStdinId);
            agentActions?.updatePhase(agentId, 'writing');
          }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          const thinkingText = evt.delta.thinking || '';
          if (thinkingText && msgStdinId) {
            const buf = _getBuffer(msgStdinId);
            buf.thinking += thinkingText;
            _scheduleStreamFlush(msgStdinId);
            agentActions?.updatePhase(agentId, 'thinking');
          } else {
            setActivityStatus({ phase: 'thinking' });
            agentActions?.updatePhase(agentId, 'thinking');
          }
        }

        // Early agent creation: register sub-agent as soon as Agent/Task tool_use
        // starts streaming, so subsequent events resolve to the correct agent.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
          agentActions?.upsertAgent({
            id: evt.content_block.id || `task_${Date.now()}`,
            parentId: agentId,
            description: '',
            phase: 'spawning',
            startTime: Date.now(),
            isMain: false,
          });
        }
        // Agent Team tools (TaskCreate, SendMessage): register as visible agents
        // so the agent panel shows team activity. These run in separate CLI processes
        // so we won't get real-time progress, but visibility is the goal.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'TaskCreate' || evt.content_block?.name === 'SendMessage')) {
          agentActions?.upsertAgent({
            id: evt.content_block.id || `team_${Date.now()}`,
            parentId: agentId,
            description: '',
            phase: 'tool',
            startTime: Date.now(),
            isMain: false,
          });
        }
        // Early detection: create plan_review card ONLY in explicit Plan mode.
        // In Code mode the CLI handles ExitPlanMode natively.
        // In Bypass mode the Rust backend auto-approves — no UI card needed.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && evt.content_block?.name === 'ExitPlanMode'
            && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

          // Guard: if plan_review_current already exists and was resolved,
          // this is a replay after plan approval — don't create a new card.
          const existingReview = currentMessages.find((m) => m.id === 'plan_review_current');
          if (!existingReview || !existingReview.resolved) {
            let planContent = '';
            for (let i = currentMessages.length - 1; i >= 0; i--) {
              const m = currentMessages[i];
              if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                planContent = m.toolInput.content;
                break;
              }
            }

            addMessage({
              id: 'plan_review_current',
              role: 'assistant',
              type: 'plan_review',
              content: planContent,
              planContent: planContent,
              resolved: false,
              timestamp: Date.now(),
            });
            setActivityStatus({ phase: 'awaiting' });
          }
        }

        // Track input tokens from message_start (per-turn + cumulative total)
        if (evt.type === 'message_start' && evt.message?.usage) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.message.usage.input_tokens || 0;
          const snapshot = contextSnapshot(evt.message.usage);
          setSessionMeta({
            inputTokens: (meta.inputTokens || 0) + delta,
            totalInputTokens: (meta.totalInputTokens || 0) + delta,
            ...(snapshot ? { ...snapshot, contextOutputTokens: 0 } : {}),
          });
          const updatedMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
          if (updatedMeta) _persistTokenState(tabId, updatedMeta);
        }

        // Track output tokens from message_delta (per-turn + cumulative total)
        if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.usage.output_tokens;
          setSessionMeta({
            outputTokens: (meta.outputTokens || 0) + delta,
            totalOutputTokens: (meta.totalOutputTokens || 0) + delta,
            contextOutputTokens: getContextOutputTokens(evt.usage),
          });
          const updatedMeta2 = useChatStore.getState().getTab(tabId)?.sessionMeta;
          if (updatedMeta2) _persistTokenState(tabId, updatedMeta2);
        }
        break;
      }

      case 'system':
        if (msg.subtype === 'init') {
          setSessionMeta({ model: msg.model });
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system-level errors instead of silently dropping them
          const rawError = msg.message || msg.error || 'System error';
          addMessage({
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: formatErrorForUser(rawError),
            timestamp: Date.now(),
          });
        } else if (msg.subtype === 'thinking_tokens') {
          // Track estimated thinking token usage (Claude CLI stream-json)
          // Updates sessionMeta with thinking token estimates for display
          const thinkingTokens = msg.estimated_tokens;
          if (typeof thinkingTokens === 'number') {
            const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
            setSessionMeta({
              thinkingTokens,
              totalThinkingTokens: (meta.totalThinkingTokens || 0) + (msg.estimated_tokens_delta || 0),
            });
          }
        } else if (msg.subtype === 'status') {
          // Session status updates (e.g. "requesting") — informational, silently tracked
          // We don't surface these as user-visible messages; they're internal CLI state
        } else if (msg.subtype === 'compact_boundary') {
          // 压缩完成：CLI 会用这条事件给出压缩后的真实 token 数，
          // 不处理的话右上角的上下文占用会一直停留在压缩前的旧数值，直到下一轮真实对话才刷新
          // 实时流里是蛇形命名 compact_metadata.post_tokens（驼峰的 compactMetadata 只出现在磁盘 JSONL 里）
          const postTokens = msg.compact_metadata?.post_tokens;
          const preTokens = msg.compact_metadata?.pre_tokens;
          if (typeof postTokens === 'number') {
            setSessionMeta({
              inputTokens: postTokens,
              outputTokens: 0,
              contextInputTokens: postTokens,
              contextOutputTokens: 0,
            });
            const boundaryMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
            if (boundaryMeta) _persistTokenState(tabId, boundaryMeta);

            // 把压缩前后的 token 数写进处理卡片，让用户知道这次压缩大概做了什么
            const boundaryCmdMsgId = boundaryMeta?.pendingCommandMsgId;
            if (boundaryCmdMsgId) {
              const boundaryCmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? [])
                .find((m) => m.id === boundaryCmdMsgId);
              if (boundaryCmdMsg) {
                useChatStore.getState().updateMessage(tabId, boundaryCmdMsgId, {
                  commandData: {
                    ...boundaryCmdMsg.commandData,
                    compactSummary: { preTokens, postTokens },
                  },
                });
              }
            }
          }
        } else {
          // FI-3: Log unknown subtypes so we know what we're missing
          console.warn('[ClaudeDeck] Unhandled system subtype:', msg.subtype, msg);
        }
        break;

      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;

        // With --include-partial-messages, intermediate assistant messages arrive
        // frequently. We must NOT aggressively wipe streaming text state when the
        // message only contains a thinking block (no text block yet).
        const hasTextBlock = content.some((b) => b.type === 'text' && b.text);

        if (hasTextBlock) {
          // Full clear — the text block supersedes streaming partial text
          clearPartial();
        } else {
          // Only clear thinking partial — preserve streaming text
          {
            const td = useChatStore.getState().getTab(tabId);
            if (td?.partialThinking) {
              const nt = new Map(useChatStore.getState().tabs);
              nt.set(tabId, { ...td, partialThinking: '' });
              useChatStore.setState({ tabs: nt });
            }
          }
        }

        // If there's a pending slash command processing card, mark it as
        // completed now — the assistant response means the CLI has responded.
        // Some commands (e.g. /compact) may not emit a 'result' event.
        const pendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmd) {
          const pendingCmdData = (useChatStore.getState().getTab(tabId)?.messages ?? [])
            .find((m) => m.id === pendingCmd)?.commandData;
          // /compact 的 compact_boundary 事件里 postTokens 时有时无（同 5h/7d 用量数据
          // 一样，是 CLI 那边不稳定的附加字段）；这里兜底用当前已经算出来的真实上下文
          // 占用量补上，不然只有 preTokens、没有对比数字，看起来像“压缩完成了但读不到
          // 压缩率”。
          const needsPostFallback = pendingCmdData?.command === '/compact'
            && pendingCmdData?.compactSummary?.postTokens === undefined;
          useChatStore.getState().updateMessage(tabId, pendingCmd, {
            commandCompleted: true,
            commandData: {
              ...pendingCmdData,
              completedAt: Date.now(),
              ...(needsPostFallback ? {
                compactSummary: {
                  ...pendingCmdData?.compactSummary,
                  postTokens: getContextUsedTokens(useChatStore.getState().getTab(tabId)?.sessionMeta ?? {}),
                },
              } : {}),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // If this message contains AskUserQuestion, skip text blocks —
        // the interactive question UI makes them redundant and avoids
        // showing raw question descriptions alongside the rich UI.
        const hasAskUserQuestion = content.some(
          (b) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );

        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            if (hasAskUserQuestion) continue;
            setActivityStatus({ phase: 'writing' });
            agentActions?.updatePhase(agentId, 'writing');
            // Use msg.uuid + block index as stable ID so re-delivered
            // messages de-duplicate correctly in the store.
            const textId = msg.uuid ? `${msg.uuid}_text_${blockIdx}` : generateMessageId();
            addMessage({
              id: textId,
              role: 'assistant',
              type: 'text',
              content: block.text,
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            // Code mode: EnterPlanMode/ExitPlanMode are transparent — CLI handles internally.
            // Don't show tool cards; track ExitPlanMode for auto-restart if CLI exits.
            if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
                && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
              // 静默重启只支持前台标签页，后台不记录
              if (block.name === 'ExitPlanMode' && isForeground) exitPlanModeSeenRef.current = true;
              continue;
            }
            setActivityStatus({ phase: 'tool', toolName: block.name });
            if (block.name === 'Task' || block.name === 'Agent') {
              agentActions?.upsertAgent({
                id: block.id || generateMessageId(),
                parentId: agentId,
                description: block.input?.description || block.input?.prompt || '',
                phase: 'spawning',
                startTime: Date.now(),
                isMain: false,
              });
            } else if (block.name === 'TaskCreate' || block.name === 'SendMessage') {
              // Agent Team tasks/messages: register as visible agents in the tree.
              // These run in separate CLI processes so we won't get progress events,
              // but showing them makes the team activity visible in the agent panel.
              agentActions?.upsertAgent({
                id: block.id || `team_${Date.now()}`,
                parentId: agentId,
                description: block.input?.subject || block.input?.description || block.input?.recipient || '',
                phase: 'tool',
                startTime: Date.now(),
                isMain: false,
              });
            } else {
              agentActions?.updatePhase(agentId, 'tool', block.name);
            }

            if (block.name === 'AskUserQuestion') {
              // Use a stable sentinel ID so re-delivered blocks de-duplicate
              // instead of creating duplicate question cards (TK-103).
              const questionId = block.id || 'ask_question_current';

              // Guard: skip if question already exists (resolved or not).
              // Search by exact ID first, then by any AskUserQuestion card —
              // the control_request handler may have already created one with
              // a different ID (e.g. 'ask_question_current' vs 'toolu_01abc').
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const existingQuestion = currentMessages.find(
                (m) => m.id === questionId && m.type === 'question',
              ) || currentMessages.find(
                (m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion',
              );
              if (existingQuestion) {
                // Already exists — just ensure awaiting state if unresolved
                if (!existingQuestion.resolved) {
                  setActivityStatus({ phase: 'awaiting' });
                }
                break;
              }

              const questions = block.input?.questions;
              addMessage({
                id: questionId,
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: Array.isArray(questions) ? questions : [],
                resolved: false,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });
              // Mark as awaiting user input (consistent with ExitPlanMode)
              setActivityStatus({ phase: 'awaiting' });
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });
            } else if (block.name === 'ExitPlanMode') {
              // Show ExitPlanMode as a collapsible tool_use (like other tools)
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

              // Only create plan_review card in Plan mode.
              // In Code mode the CLI handles ExitPlanMode natively.
              // In Bypass mode the Rust backend auto-approves — no UI card needed.
              if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
                const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

                // Guard: skip if already approved (replay)
                const toolAlreadyExisted = block.id && currentMessages.some(
                  (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
                );
                const existingReview = currentMessages.find(
                  (m) => m.type === 'plan_review' && m.resolved,
                );
                if (!(toolAlreadyExisted && existingReview)) {
                  let planContent = '';
                  for (let i = currentMessages.length - 1; i >= 0; i--) {
                    const m = currentMessages[i];
                    if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                      planContent = m.toolInput.content;
                      break;
                    }
                  }

                  addMessage({
                    id: 'plan_review_current',
                    role: 'assistant',
                    type: 'plan_review',
                    content: planContent,
                    planContent: planContent,
                    resolved: false,
                    timestamp: Date.now(),
                  });
                  setActivityStatus({ phase: 'awaiting' });
                }
              }
            } else {
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

            }
          } else if (block.type === 'thinking') {
            // Complete thinking block arrived — clear streaming thinking text.
            // DON'T override activityStatus here: if text is currently streaming,
            // the phase should remain 'writing'. The streaming events (thinking_delta,
            // text_delta) are the source of truth for activity phase.
            {
            const td = useChatStore.getState().getTab(tabId);
            if (td?.partialThinking) {
              const nt = new Map(useChatStore.getState().tabs);
              nt.set(tabId, { ...td, partialThinking: '' });
              useChatStore.setState({ tabs: nt });
            }
          }
            agentActions?.updatePhase(agentId, 'thinking');
            addMessage({
              id: msg.uuid ? `${msg.uuid}_thinking_${blockIdx}` : generateMessageId(),
              role: 'assistant',
              type: 'thinking',
              content: block.thinking || '',
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          }
        }

        // NOTE: No save/restore hack needed here. addMessage no longer clears
        // partialText/isStreaming as a side effect (TK-322 fix), so intermediate
        // assistant messages with only thinking/tool_use blocks won't wipe
        // streaming text state.
        break;
      }

      case 'user':
      case 'human': {
        // Store CLI checkpoint UUID on the most recent user message (for rewind).
        // Only store from genuine user-input messages, NOT tool-result messages.
        // Tool-result user messages have content with tool_result blocks and their
        // UUIDs don't match the file-history-snapshot messageId used by --rewind-files.
        {
          const content = msg.message?.content;
          const isToolResult = Array.isArray(content)
            && content.some((b) => b.type === 'tool_result');
          if (msg.uuid && !isToolResult) {
            const allMsgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
            for (let i = allMsgs.length - 1; i >= 0; i--) {
              if (allMsgs[i].role === 'user') {
                console.log('[stream] Storing checkpointUuid:', msg.uuid, 'on msg:', allMsgs[i].id);
                useChatStore.getState().updateMessage(tabId, allMsgs[i].id, { checkpointUuid: msg.uuid });
                break;
              }
            }
          }
        }

        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const resultText = toolResultText(block.content);
              const tuId = block.tool_use_id;
              if (tuId && resultText) {
                const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
                const parent = msgs.find((m) => m.id === tuId);
                if (parent) {
                  useChatStore.getState().updateMessage(tabId, tuId, { toolResultContent: resultText });
                }
              }
            }
          }
        }
        if (msg.tool_use_result) {
          const tur = msg.tool_use_result;
          const resultText = typeof tur === 'string' ? tur
            : typeof tur.stdout === 'string' ? tur.stdout
            : typeof tur.content === 'string' ? tur.content
            : Array.isArray(tur.content) ? tur.content.map((b) => typeof b.text === 'string' ? b.text : '').join('')
            : typeof tur.content === 'object' && tur.content?.text ? String(tur.content.text)
            : '';
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type === 'tool_result' && block.tool_use_id && resultText) {
                const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
                const parent = msgs.find((m) => m.id === block.tool_use_id);
                if (parent) {
                  useChatStore.getState().updateMessage(tabId, block.tool_use_id, { toolResultContent: resultText });
                }
              }
            }
          }
        }
        break;
      }

      case 'tool_result': {
        const resultContent = Array.isArray(msg.content) || typeof msg.content === 'string'
          ? toolResultText(msg.content)
          : msg.output || '';

        const toolUseId = msg.tool_use_id;
        // Auto-refresh file tree when file-mutating tools complete
        _maybeRefreshFileTree(tabId, toolUseId, msg.tool_name);

        if (toolUseId) {
          const currentMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const parentMsg = currentMessages.find((m) => m.id === toolUseId);
          if (parentMsg) {
            const updates: Partial<ChatMessage> = { toolResultContent: resultContent };

            // Backfill: if parent is AskUserQuestion created with empty questions
            // (due to streaming), or was mis-typed as tool_use, fix it now.
            if (parentMsg.toolName === 'AskUserQuestion') {
              if (parentMsg.type !== 'question') {
                updates.type = 'question';
                updates.resolved = false;
              }
              if (!parentMsg.questions || parentMsg.questions.length === 0) {
                // Try to extract questions from toolInput (may have been populated
                // by a later assistant message with complete content)
                const qs = parentMsg.toolInput?.questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  updates.questions = qs;
                }
              }
            }

            useChatStore.getState().updateMessage(tabId, toolUseId, updates);
            break;
          }
        }
        // Complete Agent Team agents when their tool result arrives
        if (toolUseId && agentActions?.agents.has(toolUseId)) {
          agentActions?.completeAgent(toolUseId, 'completed');
        }
        addMessage({
          id: msg.uuid || generateMessageId(),
          role: 'assistant',
          type: 'tool_result',
          content: resultContent,
          toolName: msg.tool_name,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool_use_summary':
        break;

      case 'result': {

        // Sub-agent results carry parent_tool_use_id — they must NOT terminate the
        // main session. Only the main agent's result (no parent_tool_use_id) ends the
        // session. Without this guard, the first parallel sub-agent to complete would
        // call setSessionStatus('completed') and freeze the UI mid-run.
        if (msg.parent_tool_use_id) {
          agentActions?.completeAgent(
            resolveAgentId(msg.parent_tool_use_id, agentActions?.agents),
            msg.subtype === 'success' ? 'completed' : 'error',
          );
          break;
        }

        // Preserve delta-only replies before clearing streaming state.
        commitPartialText(tabId, msgStdinId);
        clearPartial();

        // --- TK-303: Auto-retry on thinking signature error after provider/model switch ---
        // When user switches API provider or model mid-conversation, we attempt to resume
        // the session. If the new provider/model rejects the old thinking block signatures,
        // we automatically retry without resume to preserve UX continuity.
        // 重试流程读取当前设置（工作目录、模型等）并注册到当前选中的标签页，只用于前台。
        if (isForeground && msg.subtype !== 'success') {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          // Build a combined error string from all possible error fields
          const errorText = [msg.result, msg.error, msg.content]
            .filter(Boolean)
            .map(String)
            .join(' ');
          const isThinkingSignatureError = /invalid.*signature.*thinking|thinking.*invalid.*signature/i.test(errorText);

          const switchedFlag = meta.providerSwitched || meta.modelSwitched;
          const pendingText = meta.providerSwitchPendingText || meta.modelSwitchPendingText;
          // Find last user message as fallback retry text when no pendingText is set
          const lastUserMsg = !pendingText
            ? [...(useChatStore.getState().getTab(tabId)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
            : undefined;
          const retryCandidate = pendingText || (typeof lastUserMsg === 'string' ? lastUserMsg : undefined);
          if (isThinkingSignatureError && retryCandidate) {
            const switchType = switchedFlag ? (meta.modelSwitched ? '模型' : 'API 提供商') : '会话';
            console.warn(`[ClaudeDeck] Thinking signature error after ${switchType} switch — auto-retrying without resume`);
            const retryText = retryCandidate;

            // Kill the current (failed) process
            const failedStdinId = meta.stdinId;
            if (failedStdinId) {
              bridge.killSession(failedStdinId).catch(() => {});
              releaseStreamListener(failedStdinId);
            }

            // Clear sessionId (abandon resume) and switch flags
            setSessionMeta({
              sessionId: undefined,
              stdinId: undefined,
              providerSwitched: false,
              providerSwitchPendingText: undefined,
              modelSwitched: false,
              modelSwitchPendingText: undefined,
            });

            // Show system notice
            addMessage({
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: `已切换${switchType}，正在重新发送…`,
              commandType: 'info',
              timestamp: Date.now(),
            });

            // Re-send: spawn a fresh process without resume_session_id
            (async () => {
              // P0-5: Declare retryId outside try so catch can clean up listeners on failure
              const retryId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              try {
                const cwd = useSettingsStore.getState().workingDirectory;
                if (!cwd) return;
                const selectedModel = useSettingsStore.getState().selectedModel;
                const sessionMode = useSettingsStore.getState().sessionMode;

                const retryTurnStartedAt = Date.now();
                setSessionStatus('running');
                setSessionMeta({
                  turnStartTime: retryTurnStartedAt,
                  lastProgressAt: retryTurnStartedAt,
                  inputTokens: 0,
                  outputTokens: 0,
                });
                setActivityStatus({ phase: 'thinking' });
                agentActions?.clearAgents();
                agentActions?.upsertAgent({
                  id: 'main', parentId: null,
                  description: retryText.slice(0, 100),
                  phase: 'spawning', startTime: Date.now(), isMain: true,
                });
                const retryUnlisten = await onClaudeStream(retryId, (m: StreamMessage) => {
                  m.__stdinId = retryId;
                  handleStreamMessage(m);
                });
                const retryUnlistenStderr = await onClaudeStderr(retryId, (line: string) => {
                  handleStderrLineRef.current(line, retryId);
                });
                const retryRelease = () => { retryUnlisten(); retryUnlistenStderr(); };
                setStreamListener(retryId, retryRelease);
                window.__claudeUnlisten = retryRelease;

                const retryResolvedModel = resolveModelForProvider(selectedModel);
                const retryContextWindowMode = useSettingsStore.getState().contextWindowMode;
                const session = await bridge.startSession({
                  prompt: retryText,
                  cwd,
                  model: retryResolvedModel,
                  session_id: retryId,
                  // No resume_session_id — fresh start to avoid thinking signature issue
                  thinking_level: resolveThinkingLevelForProvider(
                    selectedModel,
                    useSettingsStore.getState().thinkingLevel,
                  ),
                  session_mode: (sessionMode === 'ask' || sessionMode === 'plan') ? sessionMode : undefined,
                  provider_id: useProviderStore.getState().activeProviderId || undefined,
                  context_window: getContextWindowForModel(retryResolvedModel, retryContextWindowMode),
                  permission_mode: mapSessionModeToPermissionMode(sessionMode),
                  enable_mcp: useSettingsStore.getState().enableMcp,
                });

                setSessionMeta({
                  sessionId: session.session_id,
                  stdinId: retryId,
                  envFingerprint: envFingerprint(),
                  snapshotContextWindowMode: retryContextWindowMode,
                  spawnedModel: retryResolvedModel,
                });
                const tabId = useSessionStore.getState().selectedSessionId;
                if (tabId) useSessionStore.getState().registerStdinTab(retryId, tabId);
              } catch (retryErr) {
                console.error('[ClaudeDeck] Provider-switch auto-retry failed:', retryErr);
                // P0-5: Clean up the retry listeners on failure
                releaseStreamListener(retryId);
                setSessionStatus('error');
                addMessage({
                  id: generateMessageId(),
                  role: 'system', type: 'text',
                  content: `重试失败: ${retryErr}`,
                  timestamp: Date.now(),
                });
              }
            })();
            break; // Exit the result case — retry flow takes over
          }
        }

        // Code mode: Auto-restart when ExitPlanMode caused CLI exit.
        // In stream-json mode, ExitPlanMode is treated as a permission denial,
        // causing the CLI to exit. Silently restart with --resume to continue.
        if (isForeground && exitPlanModeSeenRef.current && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
            && msg.subtype !== 'success') {
          exitPlanModeSeenRef.current = false;
          console.log('[ClaudeDeck] Code mode ExitPlanMode exit detected — auto-restarting with --resume');
          // Clean up dead process
          const oldStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
          if (oldStdinId) {
            useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
            bridge.killSession(oldStdinId).catch(() => {});
            releaseStreamListener(oldStdinId);
          }
          // Silently restart — no user message bubble
          silentRestartRef.current = true;
          setInputSync('Continue.');
          useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
          requestAnimationFrame(() => handleSubmitRef.current());
          break;
        }
        if (isForeground) exitPlanModeSeenRef.current = false;

        // Mark pending processing card (CLI slash command) as completed
        const pendingCmdMsgId = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmdMsgId) {
          const resultOutput = typeof msg.result === 'string' ? msg.result : '';
          const pendingResultCmdData = (useChatStore.getState().getTab(tabId)?.messages ?? [])
            .find((m) => m.id === pendingCmdMsgId)?.commandData;
          // 同前台 assistant 分支：postTokens 兜底，理由一样
          const needsPostFallback2 = pendingResultCmdData?.command === '/compact'
            && pendingResultCmdData?.compactSummary?.postTokens === undefined;
          useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
            commandCompleted: true,
            commandData: {
              ...pendingResultCmdData,
              output: resultOutput,
              completedAt: Date.now(),
              ...(needsPostFallback2 ? {
                compactSummary: {
                  ...pendingResultCmdData?.compactSummary,
                  postTokens: getContextUsedTokens(useChatStore.getState().getTab(tabId)?.sessionMeta ?? {}),
                },
              } : {}),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // Extract result text for display (e.g., slash command output)
        let resultDisplayText = '';
        if (typeof msg.result === 'string' && msg.result) {
          resultDisplayText = msg.result;
        } else if (typeof msg.content === 'string' && msg.content) {
          resultDisplayText = msg.content;
        }

        // If we have cost metadata AND a pending slash command (e.g., /compact, /cost),
        // inject cost summary into the processing card instead of creating a separate message.
        if (msg.total_cost_usd != null && pendingCmdMsgId) {
          const cost = msg.total_cost_usd?.toFixed(4) ?? '—';
          const duration = msg.duration_ms
            ? `${(msg.duration_ms / 1000).toFixed(1)}s`
            : '—';
          const turns = msg.num_turns ?? '—';
          const input = msg.usage?.input_tokens
            ? msg.usage.input_tokens.toLocaleString()
            : '';
          const output = msg.usage?.output_tokens
            ? msg.usage.output_tokens.toLocaleString()
            : '';
          const cmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId);
          if (cmdMsg) {
            useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
              commandData: {
                ...cmdMsg.commandData,
                costSummary: { cost, duration, turns, input, output },
              },
            });
          }
          // If there's also explicit result text, still add it as a message
          if (!resultDisplayText) resultDisplayText = '';
        }

        // Only add result text if it wasn't already delivered via an
        // 'assistant' event (which is the normal case for stream-json output)
        // AND there's no pending command card (which already displays the output).
        if (resultDisplayText && !pendingCmdMsgId) {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
          const isDuplicate = currentMessages.some(
            (m) => m.role === 'assistant' && m.type === 'text'
              && m.content === resultDisplayText,
          );
          if (!isDuplicate) {
            addMessage({
              id: msg.uuid || generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: resultDisplayText,
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          }
        }

        setSessionStatus(
          msg.subtype === 'success' ? 'completed' : 'error'
        );
        {
          // Correct cumulative totals for any drift between streaming
          // accumulation and the authoritative result values.
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const resultInput = msg.usage?.input_tokens || 0;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedInput = meta.inputTokens || 0;
          const streamedOutput = meta.outputTokens || 0;
          setSessionMeta({
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            inputTokens: resultInput,
            outputTokens: resultOutput,
            totalInputTokens: (meta.totalInputTokens || 0) + (resultInput - streamedInput),
            totalOutputTokens: (meta.totalOutputTokens || 0) + (resultOutput - streamedOutput),
            turnStartTime: undefined,
            lastProgressAt: undefined,
          });
          // Persist final token state for F5 recovery
          const resultMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
          if (resultMeta) _persistTokenState(tabId, resultMeta);
        }
        agentActions?.completeAll(
          msg.subtype === 'success' ? 'completed' : 'error'
        );
        useSessionStore.getState().fetchSessions();
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1000);

        // --- AI Title Generation (TK-001): on 3rd successful turn, generate a title ---
        if (msg.subtype === 'success') {
          const sessionId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId || tabId;
          if (sessionId) {
            const customPreviews = useSessionStore.getState().customPreviews;
            if (!customPreviews[sessionId]) {
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const userTextMsgs = currentMessages.filter(
                (m) => m.role === 'user' && m.type === 'text' && m.content,
              );
              if (userTextMsgs.length >= 3) {
                const assistantTextMsgs = currentMessages.filter(
                  (m) => m.role === 'assistant' && m.type === 'text' && m.content,
                );
                if (assistantTextMsgs.length >= 3) {
                  const userMsg = userTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  const assistantMsg = assistantTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  const titleGenCwd = useSessionStore.getState().sessions.find((s) => s.id === tabId)?.project;
                  bridge.generateSessionTitle(userMsg, assistantMsg, useProviderStore.getState().activeProviderId || undefined, titleGenCwd)
                    .then((title) => {
                      if (title) {
                        useSessionStore.getState().setCustomPreview(sessionId, title);
                      }
                    })
                    .catch((e) => {
                      if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
                    });
                }
              }
            }
          }
        }

        // --- Auto-compact: threshold follows the declared context window.
        // Default 200K models compact at 160K; declared 1M models compact at 800K.
        // Fires at most once per session to avoid infinite loops.
        const compactMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
        const resultContextTokens = getContextUsedTokens({
          inputTokens: msg.usage?.input_tokens,
          outputTokens: msg.usage?.output_tokens,
          contextInputTokens: compactMeta?.contextInputTokens,
          contextOutputTokens: compactMeta?.contextOutputTokens,
        });
        const compactStdinId = compactMeta?.stdinId;
        const compactCtx = resolveSessionContextWindow(
          { ...compactMeta, inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
          useSettingsStore.getState().selectedModel,
          useSettingsStore.getState().contextWindowMode,
        );
        const autoCompactThreshold = getAutoCompactThreshold(
          compactCtx.model,
          compactCtx.mode,
          useSettingsStore.getState().autoCompactThresholdTokens,
        );
        // autoCompactFiredRef 属于 InputBar 实例、不分标签页，自动压缩只对前台生效
        if (isForeground && resultContextTokens > autoCompactThreshold && !autoCompactFiredRef.current && compactStdinId && msg.subtype === 'success') {
          autoCompactFiredRef.current = true;
          console.log('[ClaudeDeck] Auto-compact triggered:', { contextTokens: resultContextTokens, threshold: autoCompactThreshold });
          const compactMsgId = generateMessageId();
          addMessage({
            id: compactMsgId,
            role: 'system',
            type: 'text',
            content: t('chat.autoCompacting'),
            commandType: 'processing',
            commandData: { command: '/compact', compactSummary: { preTokens: resultContextTokens } },
            commandStartTime: Date.now(),
            commandCompleted: false,
            timestamp: Date.now(),
          });
          // FI-4: Register pendingCommandMsgId so result handler can mark it completed
          setSessionMeta({ pendingCommandMsgId: compactMsgId });
          setSessionStatus('running');
          setActivityStatus({ phase: 'thinking' });
          bridge.sendStdin(compactStdinId, '/compact').catch((err) => {
            console.error('[ClaudeDeck] Auto-compact failed:', err);
          });
          // FI-4: Timeout fallback — if compact doesn't complete within 90s, auto-complete
          setTimeout(() => {
            const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
            if (meta.pendingCommandMsgId === compactMsgId) {
              useChatStore.getState().updateMessage(tabId, compactMsgId, {
                commandCompleted: true,
                commandData: {
                  ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === compactMsgId)?.commandData,
                  output: 'Compact timed out',
                  completedAt: Date.now(),
                },
              });
              useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
              if (useChatStore.getState().getTab(tabId)?.sessionStatus === 'running') {
                useChatStore.getState().setSessionStatus(tabId, 'idle');
              }
            }
          }, 15_000); // Bug C fix (#27): reduced from 90s to 15s
          break; // Skip pending message flush — compact takes priority
        }

        // FIFO drain: dequeue ONE pending message and send it (#142/#70).
        // When this turn completes, the next result event will dequeue the next one.
        // Previously all pending messages were joined and sent at once, which could
        // overwhelm the CLI. Sequential turn-by-turn processing is safer.
        {
          const drainTab = useChatStore.getState().getTab(tabId);
          const nextMsg = useChatStore.getState().shiftPendingMessage(tabId);
          const flushStdinId = drainTab?.sessionMeta.stdinId;
          if (nextMsg && flushStdinId) {
            const nextTurnStartedAt = Date.now();
            setSessionStatus('running');
            setSessionMeta({
              turnStartTime: nextTurnStartedAt,
              lastProgressAt: nextTurnStartedAt,
              inputTokens: 0,
              outputTokens: 0,
            });
            setActivityStatus({ phase: 'thinking' });
            agentActions?.clearAgents();
            agentActions?.upsertAgent({
              id: 'main',
              parentId: null,
              description: nextMsg.slice(0, 100),
              phase: 'spawning',
              startTime: Date.now(),
              isMain: true,
            });
            bridge.sendStdin(flushStdinId, nextMsg).catch((err) => {
              console.error('[TC] Failed to send pending message:', err);
              // Restore failed message + remaining queue to input draft
              const remaining = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
              const allFailed = [nextMsg, ...remaining];
              const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
              const failedText = allFailed.join('\n\n');
              useChatStore.getState().setInputDraft(tabId, draft ? `${draft}\n\n${failedText}` : failedText);
              useChatStore.getState().clearPendingMessages(tabId);
              setSessionStatus('error');
            });
          }
        }

        break;
      }

      case 'process_exit': {
        // The CLI process has exited — clear the stdin handle but keep sessionId for resume
        commitPartialText(tabId, msgStdinId);
        clearPartial();
        console.log('[ClaudeDeck:session] process_exit received', { stdinId: msg.__stdinId });

        // Bug C fix (#27): Clear stuck pendingCommandMsgId (e.g., /compact without result)
        const exitPendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (exitPendingCmd) {
          useChatStore.getState().updateMessage(tabId, exitPendingCmd, { commandCompleted: true });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // Check this turn only. Old assistant messages must not hide a failed
        // follow-up that exited without returning any text.
        const exitTabData = useChatStore.getState().getTab(tabId);
        const exitStatus = exitTabData?.sessionStatus;
        const exitMsgs = exitTabData?.messages ?? [];
        if (exitStatus === 'running') {
          const turnStartTime = exitTabData?.sessionMeta.turnStartTime ?? 0;
          const hasAssistantReply = hasAssistantReplyForTurn(exitMsgs, turnStartTime);
          if (!hasAssistantReply) {
            // lastStderrRef 只记录前台会话的 stderr；后台会话的 stderr 已逐行显示在聊天中
            if (isForeground && lastStderrRef.current) {
              const stderr = lastStderrRef.current;
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: formatErrorForUser(`CLI error: ${stderr}`),
                timestamp: Date.now(),
              });
            } else {
              // No stderr captured — CLI exited silently. Show a generic error
              // so the user knows something went wrong (previously this was silent).
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: t('error.cliExitedSilently'),
                timestamp: Date.now(),
              });
            }
          }
        }

        // P0-5: Clean up Tauri event listeners for this session to prevent leaks
        const exitingStdinId = msg.__stdinId || useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
        releaseStreamListener(exitingStdinId);
        if (isForeground && window.__claudeUnlisten) {
          window.__claudeUnlisten = null;
        }

        {
          const exitMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          for (const m of exitMessages) {
            if (['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved) {
              useChatStore.getState().updateMessage(tabId, m.id, {
                interactionState: 'failed',
                interactionError: 'CLI process exited',
              });
            }
          }
        }

        setSessionStatus('idle');
        if (isForeground && !document.hasFocus() && 'Notification' in window) {
          if (Notification.permission === 'granted') {
            new Notification('ClaudeDeck', { body: t('notification.chatComplete') });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                new Notification('ClaudeDeck', { body: t('notification.chatComplete') });
              }
            }).catch(() => {});
          }
        }

        setSessionMeta({ stdinId: undefined, lastProgressAt: undefined });
        // Clean up stdinId → tabId mapping to prevent memory leak
        if (exitingStdinId) {
          useSessionStore.getState().unregisterStdinTab(exitingStdinId);
        }
        // Bug B fix (#28): Don't discard pending messages — restore to input draft
        const remainingPending = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
        if (remainingPending.length > 0) {
          const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
          const pendingText = remainingPending.join('\n\n');
          useChatStore.getState().setInputDraft(tabId,
            draft ? `${draft}\n\n${pendingText}` : pendingText
          );
          useChatStore.getState().clearPendingMessages(tabId);
        }

        agentActions?.completeAll();
        useSessionStore.getState().fetchSessions();
        break;
      }

      default:
        // Fallback: handle content_block_delta at top level (without stream_event wrapper)
        if (msg.type === 'content_block_delta') {
          const text = msg.delta?.text || '';
          if (text && msgStdinId) {
            const buf = _getBuffer(msgStdinId);
            buf.text += text;
            _scheduleStreamFlush(msgStdinId);
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
  }, [exitPlanModeSeenRef, autoCompactFiredRef, silentRestartRef, handleSubmitRef, handleStderrLineRef, setInputSync]);

  return { handleStreamMessage };
}
