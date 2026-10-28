import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react';
import { useActiveTab, type ChatMessage } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { ToolGroup } from './ToolGroup';
import { InputBar } from './InputBar';
import { ExportMenu } from '../conversations/ExportMenu';
import { UpdateButton } from '../shared/UpdateButton';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { UsageChip } from '../usage/UsageChip';
import { useFileStore } from '../../stores/fileStore';
import { toSessionFilePath } from '../../lib/remote';
import { useAgentStore } from '../../stores/agentStore';
import { AgentPanel } from '../agents/AgentPanel';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { useProviderStore } from '../../stores/providerStore';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { computeTurnDurations, parseTurns } from '../../lib/turns';
import { WelcomeScreen, LoadingSessionState, EmptyReadyState } from './WelcomeScreen';
import { ConversationTimeline } from './ConversationTimeline';
import { UsageStatusBar } from './UsageMeters';
import { GitChip } from './GitChip';
import { formatElapsed, getModelDisplayName } from './chatFormat';
import { ActivityIndicator } from './ActivityIndicator';
import { usePlanPanelStore, PlanPanel } from './PlanPanel';
import { AiAvatar } from '../shared/AiAvatar';

/** 首次只渲染最近这么多项（一个工具组算一项）：长会话全部渲染（含 Markdown）会让切换会话明显卡顿 */
const RENDER_WINDOW = 60;
/** 滚到顶部附近时每次往前补渲染的项数 */
const RENDER_PAGE = 60;
/** 打开会话后持续贴底的最长时间（毫秒），等待消息高度稳定 */
const PIN_DURATION = 2000;

export function ChatPanel() {
  const t = useT();
  const messages = useActiveTab((t) => t.messages);
  const isStreaming = useActiveTab((t) => t.isStreaming);
  const partialText = useActiveTab((t) => t.partialText);
  const partialThinking = useActiveTab((t) => t.partialThinking);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const activityStatus = useActiveTab((t) => t.activityStatus);
  const pendingUserMessages = useActiveTab((t) => t.pendingUserMessages);
  const sidebarOpen = useSettingsStore((s) => s.sidebarOpen);
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSecondaryPanel = useSettingsStore((s) => s.toggleSecondaryPanel);
  const agentPanelOpen = useSettingsStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useSettingsStore((s) => s.toggleAgentPanel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  // “缺失”只对当前工作目录有效：切换到别的目录（包括跳过加载的主目录 / 远程项目）时不会沿用旧的标记
  const directoryMissing = useFileStore((s) => s.directoryMissing && s.rootPath === workingDirectory);
  // 目录被判定为缺失时自动复查（立即、每 3 秒、窗口重新获得焦点时）：
  // 目录其实存在只是一次读取失败的话，会自己恢复，不需要切换项目或重启
  useEffect(() => {
    if (!workingDirectory || !directoryMissing) return;
    const recheck = () => { void useFileStore.getState().recheckDirectory(workingDirectory); };
    recheck();
    const timer = setInterval(recheck, 3000);
    window.addEventListener('focus', recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
    };
  }, [workingDirectory, directoryMissing]);
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const isFilePreviewMode = !!useFileStore((s) => s.selectedFile);

  // Agent activity for floating button badge
  const agents = useAgentStore((s) => s.agents);
  const activeAgentCount = useMemo(
    () => Array.from(agents.values()).filter(
      (a) => a.phase !== 'completed' && a.phase !== 'error'
    ).length,
    [agents],
  );
  const totalAgentCount = agents.size;

  const showPlanPanel = usePlanPanelStore((s) => s.open);
  const closePlanPanel = usePlanPanelStore((s) => s.close);

  // Listen for internal file tree drag-drop (mouse-based, not HTML5 drag-and-drop)
  // HTML5 drag events don't work in Tauri because dragDropEnabled: true intercepts them.
  // Listen for file-chip click → open file in secondary panel's file browser
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail;
      if (!filePath) return;
      // Open secondary panel to files tab and select the file
      useSettingsStore.getState().setSecondaryTab('files');
      // 输入框里的文件块在远程项目中存的是远端原生路径，要转成 ssh:// 才能读取
      useFileStore.getState().selectFile(toSessionFilePath(filePath));
    };
    window.addEventListener('tokenicode:open-file', onOpenFile);
    return () => window.removeEventListener('tokenicode:open-file', onOpenFile);
  }, []);

  // --- Tool grouping: group 3+ consecutive tool_use messages ---
  type DisplayItem =
    | { kind: 'message'; msg: ChatMessage; idx: number }
    | { kind: 'tool_group'; msgs: ChatMessage[]; startIdx: number };

  const displayItems = useMemo<DisplayItem[]>(() => {
    const items: DisplayItem[] = [];
    let i = 0;
    while (i < messages.length) {
      // Detect runs of consecutive tool_use messages
      if (messages[i].type === 'tool_use') {
        let j = i;
        while (j < messages.length && messages[j].type === 'tool_use') j++;
        const runLength = j - i;
        if (runLength >= 3) {
          items.push({ kind: 'tool_group', msgs: messages.slice(i, j), startIdx: i });
          i = j;
          continue;
        }
      }
      // 空思考块（模型只返回签名、不返回思考内容）不显示
      const isEmptyThinking = messages[i].type === 'thinking'
        && !(typeof messages[i].content === 'string' && messages[i].content.trim());
      if (!isEmptyThinking) items.push({ kind: 'message', msg: messages[i], idx: i });
      i++;
    }
    return items;
  }, [messages]);

  // --- 分段渲染：只渲染从锚点项开始到末尾的部分，锚点按会话记录 ---
  // 锚点用列表项的 key 而不是下标：流式输出追加消息、磁盘同步重新加载时位置都不会乱
  const itemKey = (item: DisplayItem) => (item.kind === 'tool_group' ? `tg_${item.msgs[0].id}` : item.msg.id);
  const [windowAnchor, setWindowAnchor] = useState<{ sessionId: string | null; key: string | null }>(
    { sessionId: null, key: null },
  );
  const anchorKey = windowAnchor.sessionId === selectedSessionId ? windowAnchor.key : null;
  const renderStart = useMemo(() => {
    const autoStart = Math.max(0, displayItems.length - RENDER_WINDOW);
    if (!anchorKey) return autoStart;
    const idx = displayItems.findIndex((item) => itemKey(item) === anchorKey);
    // 锚点找不到（如回退截断了消息）时退回默认窗口；任何情况下都至少渲染最近一个窗口
    return idx === -1 ? autoStart : Math.min(idx, autoStart);
  }, [displayItems, anchorKey]);
  const renderedItems = useMemo(() => displayItems.slice(renderStart), [displayItems, renderStart]);

  // 列表超过一个窗口后固定锚点，之后流式追加的新消息只会接在末尾，不会把顶部的消息挤掉导致视图跳动
  useEffect(() => {
    if (!anchorKey && displayItems.length > RENDER_WINDOW) {
      setWindowAnchor({ sessionId: selectedSessionId, key: itemKey(displayItems[renderStart]) });
    }
  }, [anchorKey, displayItems, renderStart, selectedSessionId]);

  // Collect plan review messages from the session (created by ExitPlanMode)
  const planMessages = useMemo(
    () => messages.filter((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
    [messages],
  );

  // Find the path of the currently selected session for export
  const currentSessionPath = sessions.find(
    (s) => s.id === selectedSessionId
  )?.path;

  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingPreRef = useRef<HTMLPreElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isNearBottomRef = useRef(true);
  // When user scrolls up via wheel, suppress auto-scroll until they return to bottom
  const userScrollingUpRef = useRef(false);
  // Show "scroll to bottom" button when user is far from bottom
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const showScrollBtnRef = useRef(false);
  const scrollRafRef = useRef(0);
  const turns = useMemo(() => parseTurns(messages), [messages]);
  // 每轮结束后在最后一条回复下方显示用时（与 CLI 的 "Cooked for 1m 23s" 对应）
  const turnDurations = useMemo(
    () => computeTurnDurations(messages, sessionStatus === 'running'),
    [messages, sessionStatus],
  );
  const renderTurnDuration = (lastMsgId: string) => {
    const ms = turnDurations.get(lastMsgId);
    if (ms === undefined) return null;
    return (
      <div className="ml-13 mt-1.5 text-[11px] text-text-muted select-none">
        {t('chat.turnDuration').replace('{t}', formatElapsed(ms))}
      </div>
    );
  };

  /** 往前补渲染时记下补之前的滚动高度，渲染后据此恢复位置，避免视图跳到别处 */
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const loadEarlier = useCallback(() => {
    if (renderStart === 0 || prependRef.current) return;
    const el = scrollRef.current;
    prependRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    const nextStart = Math.max(0, renderStart - RENDER_PAGE);
    setWindowAnchor({ sessionId: selectedSessionId, key: itemKey(displayItems[nextStart]) });
  }, [renderStart, displayItems, selectedSessionId]);
  const loadEarlierRef = useRef(loadEarlier);
  loadEarlierRef.current = loadEarlier;

  useLayoutEffect(() => {
    const prev = prependRef.current;
    const el = scrollRef.current;
    if (!prev || !el) return;
    prependRef.current = null;
    el.scrollTop = prev.top + (el.scrollHeight - prev.height);
  }, [renderStart]);

  /** 轮次导航跳转用：目标消息还没渲染时扩展渲染范围并返回 false，渲染后再跳转 */
  const ensureMessageRendered = useCallback((messageId: string): boolean => {
    const idx = displayItems.findIndex((item) => item.kind === 'message'
      ? item.msg.id === messageId
      : item.msgs.some((m) => m.id === messageId));
    if (idx === -1 || idx >= renderStart) return true;
    setWindowAnchor({ sessionId: selectedSessionId, key: itemKey(displayItems[idx]) });
    return false;
  }, [displayItems, renderStart, selectedSessionId]);

  const setMessageNode = useCallback((id: string) => (node: HTMLDivElement | null) => {
    if (node) {
      messageRefs.current.set(id, node);
    } else {
      messageRefs.current.delete(id);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 直接定位到底部；平滑滚动会与流式输出的自动贴底互相打架
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    userScrollingUpRef.current = false;
    setShowScrollBtn(false);
  }, []);

  // 右侧导航跳转后，暂停流式输出时的自动贴底，避免视图被拉回底部
  const handleTimelineJumped = useCallback(() => {
    userScrollingUpRef.current = true;
    pinBottomRef.current = false;
  }, []);

  // Track whether user is near the bottom of the scroll container, throttled via rAF
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 接近顶部时往前补渲染更早的消息
    if (el.scrollTop < 300) loadEarlierRef.current();
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) {
      userScrollingUpRef.current = false;
    }
    // Only update React state when the boolean actually changes, and throttle via rAF
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 300;
    if (far !== showScrollBtnRef.current) {
      showScrollBtnRef.current = far;
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        setShowScrollBtn(showScrollBtnRef.current);
      });
    }
  }, []);

  // Detect intentional upward scroll via wheel event
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User is scrolling up — suppress auto-scroll
        userScrollingUpRef.current = true;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 会话刚加载时持续贴底：消息用了 content-visibility，屏幕外的项先按估算高度占位，
  // 渲染出真实高度后总高度会变，一次性滚到底会停在中间。内容区尺寸变化时重新贴底，
  // 用户主动滚动/点击或超过 PIN_DURATION 后停止。pinTick 变化时重新开始一轮贴底。
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const pinBottomRef = useRef(true);
  const [pinTick, setPinTick] = useState(0);

  // 用户发出新消息（含运行中排队的消息）时跳到底部：即使之前往上翻过也要看到刚发的消息
  const userMessageCount = useMemo(
    () => messages.filter((m) => m.role === 'user' && m.type === 'text').length
      + pendingUserMessages.filter((p) => p.message).length,
    [messages, pendingUserMessages],
  );
  // 记最大值而不是上一次的值：排队消息收到回显时先从排队中取出、再写入消息列表，
  // 中间计数会短暂减一，按上一次的值比较会误判为又发了一条
  const maxUserCountRef = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount <= maxUserCountRef.current) return;
    maxUserCountRef.current = userMessageCount;
    userScrollingUpRef.current = false;
    isNearBottomRef.current = true;
    showScrollBtnRef.current = false;
    setShowScrollBtn(false);
    pinBottomRef.current = true;
    setPinTick((n) => n + 1);
  }, [userMessageCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!contentEl || !el || !pinBottomRef.current) return;
    const stopPin = () => { pinBottomRef.current = false; };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stopPin(); };
    const ro = new ResizeObserver(() => {
      if (pinBottomRef.current && !prependRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(contentEl);
    el.scrollTop = el.scrollHeight;
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', stopPin);
    el.addEventListener('keydown', stopPin);
    const timer = setTimeout(stopPin, PIN_DURATION);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', stopPin);
      el.removeEventListener('keydown', stopPin);
    };
  }, [contentEl, pinTick]);

  // Auto-scroll to bottom only when already near bottom and user isn't scrolling up
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (isNearBottomRef.current && !userScrollingUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      // 新消息先按 contain-intrinsic-size 估算的高度占位，渲染出真实高度后才向下撑开，
      // 只滚一次会停在新消息开头（头像处）。新增消息时开一轮持续贴底，直到高度稳定
      if (grew) {
        pinBottomRef.current = true;
        setPinTick((n) => n + 1);
      }
    }
  }, [messages, partialText, partialThinking, pendingUserMessages]);

  // Auto-scroll the internal thinking <pre> to bottom as new content streams in
  useEffect(() => {
    const el = thinkingPreRef.current;
    if (el && partialThinking) {
      el.scrollTop = el.scrollHeight;
    }
  }, [partialThinking]);

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar — 高度与侧边栏、右侧面板的顶栏对齐 */}
      <div
        className="flex items-center h-[48px] px-5 border-b border-border-subtle
        flex-shrink-0 bg-bg-chat cursor-default">
        {/* Show sidebar toggle when sidebar is not visible:
            either user closed it, or it's hidden by file preview mode */}
        {(!sidebarOpen || isFilePreviewMode) && (
          <button onClick={toggleSidebar}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
              transition-smooth mr-3" title={t('chat.showSidebar')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        )}
        <div className="flex flex-col justify-center min-w-0 gap-0.5">
        <div className="flex items-center">
        {/* Integrated status: Agent + API route — 与下一行的路径左对齐 */}
        <div className="relative flex items-center gap-3">
          {/* Agent status — clickable dot + label → opens AgentPanel */}
          <button onClick={toggleAgentPanel}
            className={`flex items-center gap-1.5 -ml-1.5 px-1.5 py-0.5 rounded-lg
              transition-smooth text-[9px]
              ${agentPanelOpen ? 'bg-accent/10' : 'hover:bg-bg-secondary/50'}`}
            title={t('agents.toggle')}>
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${activeAgentCount > 0
                ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)] animate-pulse-soft'
                : totalAgentCount > 0
                  ? 'bg-success'
                  : 'bg-text-tertiary/30'}`} />
            <span className={`${activeAgentCount > 0 ? 'text-amber-400' : totalAgentCount > 0 ? 'text-success' : 'text-text-tertiary'}`}>
              Agent{totalAgentCount > 1 ? ` (${totalAgentCount})` : ''}
            </span>
          </button>

          {/* API route status — dot + label */}
          <div className="flex items-center gap-1.5 text-[9px]">
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${sessionStatus === 'running'
                ? 'bg-success shadow-[0_0_6px_var(--color-accent-glow)] animate-pulse-soft'
                : sessionStatus === 'error'
                  ? 'bg-error'
                  : 'bg-text-tertiary/30'}`} />
            <span className="text-text-tertiary">
              {activeEnv !== 'local'
                ? `${t('env.remoteMode')} · ${activeEnv}`
                : activeProvider ? (activeProvider.name || 'Custom') : 'CLI'}
            </span>
          </div>

          {/* Current session mode indicator */}
          <div className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded
            ${sessionMode === 'bypass'
              ? 'text-warning/80'
              : 'text-text-tertiary'}`}>
            <span>{t(`mode.${sessionMode}`)}</span>
          </div>

          {/* Floating agent panel popover — anchored to agent button */}
          {agentPanelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={toggleAgentPanel} />
              <div className="absolute left-0 top-full mt-2 z-50
                w-72 max-h-80 rounded-xl border border-border-subtle
                bg-bg-primary shadow-lg overflow-y-auto">
                <AgentPanel />
              </div>
            </>
          )}
        </div>

        {sessionMeta.model && (
          <span className="ml-4 text-[11px] font-medium text-text-muted pointer-events-none">
            {getModelDisplayName(sessionMeta.model)}
          </span>
        )}
        </div>
        {/* 项目完整路径，单独一行 */}
        {workingDirectory && (
          <div className="text-[10px] text-text-tertiary truncate max-w-[560px] pointer-events-none"
            title={workingDirectory}>
            {workingDirectory}
          </div>
        )}
        </div>

        {/* Spacer + right-side actions */}
        <div className="ml-auto flex items-center" />
        <GitChip />
        <UsageStatusBar />
        <UsageChip />
        <UpdateButton />
        <ExportMenu sessionPath={currentSessionPath} />
        <button onClick={toggleSecondaryPanel}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
            transition-smooth" title={t('chat.toggleFiles')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <path d="M10 2v12" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 min-h-0 relative">
      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-w-0">
      {/* 消息区单独作为定位容器：右侧轮次导航条按消息区定位，输入栏和悬浮的选项卡变高时不会被它盖住 */}
      <div className="relative flex flex-col flex-1 min-h-0">
      {/* 右侧轮次导航条（lg 及以上显示）悬浮在消息区上方，显示时给消息区留出等宽的右边距，避免挡住文字 */}
      <div ref={scrollRef} onScroll={handleScroll} className={`flex-1 overflow-y-auto px-5 py-6 selectable chat-scroll-container
        ${!showPlanPanel && turns.length > 0 ? 'lg:pr-16' : ''}`}>
        {!workingDirectory && messages.length === 0 && !isStreaming ? (
          <WelcomeScreen />
        ) : messages.length === 0 && !isStreaming && sessionStatus === 'running' ? (
          <LoadingSessionState />
        ) : messages.length === 0 && !isStreaming ? (
          <EmptyReadyState />
        ) : (
          <div ref={setContentEl} className="max-w-5xl mx-auto">
            {renderStart > 0 && (
              // 兜底入口：内容不足一屏、无法靠滚动触发时也能手动加载
              <div className="flex justify-center mb-4">
                <button onClick={loadEarlier}
                  className="px-3 py-1 rounded-lg text-xs text-text-tertiary
                    hover:bg-bg-secondary hover:text-text-primary transition-smooth">
                  {t('chat.showEarlier').replace('{n}', String(renderStart))}
                </button>
              </div>
            )}
            {renderedItems.map((item, displayIdx) => {
              // Determine spacing based on item type
              const isCompact = item.kind === 'tool_group'
                || (item.kind === 'message' && ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(item.msg.type));
              const prevItem = displayIdx > 0 ? renderedItems[displayIdx - 1] : null;
              const prevIsCompact = prevItem && (
                prevItem.kind === 'tool_group'
                || (prevItem.kind === 'message' && ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(prevItem.msg.type))
              );
              const spacing = displayIdx === 0
                ? ''
                : isCompact && prevIsCompact
                  ? 'mt-0.5'
                  : isCompact || prevIsCompact
                    ? 'mt-2'
                    : 'mt-5';

              if (item.kind === 'tool_group') {
                return (
                  <div key={`tg_${item.msgs[0].id}`} className={spacing}>
                    <ToolGroup messages={item.msgs} />
                    {renderTurnDuration(item.msgs[item.msgs.length - 1].id)}
                  </div>
                );
              }

              const msg = item.msg;
              const idx = item.idx;
              // Show avatar only for the FIRST assistant text in a turn.
              let isFirstInGroup = true;
              if (msg.role === 'assistant' && msg.type === 'text') {
                for (let j = idx - 1; j >= 0; j--) {
                  const prev = messages[j];
                  if (prev.role === 'user') break;
                  if (prev.role === 'assistant' && prev.type === 'text') {
                    isFirstInGroup = false;
                    break;
                  }
                }
              }
              return (
                <div key={msg.id} ref={setMessageNode(msg.id)} className={`${spacing} chat-message-item`}>
                  <MessageBubble message={msg} isFirstInGroup={isFirstInGroup} />
                  {renderTurnDuration(msg.id)}
                </div>
              );
            })}
            {/* Streaming thinking — collapsible like ThinkingMsg but with pulse cursor */}
            {isStreaming && partialThinking && (
              <div className="ml-13 mt-1">
                <details open className="group">
                  <summary className="flex items-center gap-1.5 py-1
                    cursor-pointer text-[11px] text-text-tertiary list-none select-none">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.5"
                      className="transition-transform duration-150 group-open:rotate-90">
                      <path d="M3 2l4 3-4 3" />
                    </svg>
                    {t('msg.thinking')}
                    <span className="inline-block w-1.5 h-3 bg-text-tertiary ml-0.5
                      animate-pulse-soft rounded-sm" />
                  </summary>
                  <pre ref={thinkingPreRef} className="ml-5 mt-0.5 text-[11px] text-text-tertiary
                    whitespace-pre-wrap max-h-48 overflow-y-auto
                    font-mono leading-relaxed">
                    {partialThinking}
                  </pre>
                </details>
              </div>
            )}
            {isStreaming && partialText && (() => {
              // Hide streaming text while an unresolved question is pending —
              // the CLI may keep sending text_delta events for the next turn's
              // content, but the user needs to answer the question first.
              // Check both resolved flag AND interactionState to handle edge
              // cases where setInteractionState hasn't propagated yet.
              const hasPendingQuestion = messages.some(
                (m) => m.type === 'question' && !m.resolved
                  && m.interactionState !== 'resolved' && m.interactionState !== 'sending',
              );
              if (hasPendingQuestion) return null;

              // Check if there's already an assistant text in this turn
              let showStreamAvatar = true;
              for (let j = messages.length - 1; j >= 0; j--) {
                if (messages[j].role === 'user') break;
                if (messages[j].role === 'assistant' && messages[j].type === 'text') {
                  showStreamAvatar = false;
                  break;
                }
              }
              return (
              <div className="flex gap-3 mt-2">
                {showStreamAvatar ? (
                  <AiAvatar size="w-10 h-10" rounded="rounded-xl" />
                ) : (
                  <div className="w-10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
                  <MarkdownRenderer content={partialText} />
                  <span className="inline-block w-2 h-5 bg-accent ml-0.5
                    animate-pulse-soft rounded-sm shadow-[0_0_8px_var(--color-accent-glow)]" />
                </div>
              </div>
              );
            })()}
            {/* Inline activity status indicator — like Claude Desktop App */}
            {(sessionStatus === 'running' || activityStatus.phase === 'awaiting') && (
              <ActivityIndicator activityStatus={activityStatus} sessionMeta={sessionMeta} />
            )}
            {/* 运行中发出的消息：CLI 真正处理（已发送）或本轮结束后发送（排队）时才进入消息列表 */}
            {pendingUserMessages.map((p, i) => p.message && (
              <div key={`queued_${p.message.id}`} className="mt-5 opacity-60" title={t(p.sent ? 'chat.sentWaiting' : 'chat.queued')}>
                <MessageBubble message={p.message} isFirstInGroup={i === 0} />
                <div className="mt-1 text-right text-[11px] text-text-tertiary">{t(p.sent ? 'chat.sentWaiting' : 'chat.queued')}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!showPlanPanel && (
        <ConversationTimeline
          turns={turns}
          scrollRef={scrollRef}
          messageRefs={messageRefs}
          showScrollBtn={showScrollBtn}
          onJumped={handleTimelineJumped}
          onJumpBottom={scrollToBottom}
          ensureRendered={ensureMessageRendered}
        />
      )}
      </div>{/* end 消息区定位容器 */}

      {/* Directory missing banner */}
      {workingDirectory && directoryMissing && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-xl bg-status-warning/10 border border-status-warning/30
          flex items-center gap-3 text-sm text-text-secondary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" className="flex-shrink-0 text-status-warning">
            <path d="M8 1.5L1.5 13h13L8 1.5z" strokeLinejoin="round" />
            <path d="M8 6v3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
          <span className="flex-1">{t('project.directoryMissing')}</span>
          <button
            onClick={() => { void useFileStore.getState().recheckDirectory(workingDirectory); }}
            className="px-3 py-1 rounded-lg text-xs font-medium
              bg-bg-secondary hover:bg-bg-tertiary text-text-muted
              hover:text-text-primary transition-smooth"
          >
            {t('project.recheck')}
          </button>
          <button
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false, title: t('project.selectFolder') });
              if (selected) useSettingsStore.getState().setWorkingDirectory(selected as string);
            }}
            className="px-3 py-1 rounded-lg text-xs font-medium
              bg-status-warning/20 hover:bg-status-warning/30
              text-status-warning transition-smooth"
          >
            {t('project.reselect')}
          </button>
        </div>
      )}

      {/* Input — only show when a project folder is selected and exists */}
      {workingDirectory && !directoryMissing && <InputBar />}
      </div>{/* end main chat area */}

      {/* Right-side plan panel (resizable) */}
      {showPlanPanel && (
        <PlanPanel
          planMessages={planMessages}
          onClose={closePlanPanel}
        />
      )}
      </div>{/* end flex row */}
    </div>
  );
}
