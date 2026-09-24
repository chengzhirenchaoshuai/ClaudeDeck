import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { create } from 'zustand';
import { useChatStore, useActiveTab, generateMessageId, type ChatMessage, type SessionMeta } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { ToolGroup } from './ToolGroup';
import { InputBar } from './InputBar';
import { ExportMenu } from '../conversations/ExportMenu';
import { UpdateButton } from '../shared/UpdateButton';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  mapSessionModeToPermissionMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../../stores/settingsStore';
import { getContextUsedTokens } from '../../lib/context-usage';
import { useSessionStore } from '../../stores/sessionStore';
import { useRateLimitsStore, type RateLimitWindow } from '../../stores/rateLimitsStore';
import { RemotePathInput } from '../layout/EnvSwitcher';
import { UsageChip } from '../usage/UsageChip';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { AgentPanel } from '../agents/AgentPanel';
import { bridge, onClaudeStream, onClaudeStderr } from '../../lib/tauri-bridge';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { SetupWizard } from '../setup/SetupWizard';
import { AiAvatar } from '../shared/AiAvatar';
import { displayProviderModelName } from '../../lib/deepseek-models';
import { parseTurns, type Turn } from '../../lib/turns';
import { ConfirmDialog } from '../shared/ConfirmDialog';

/** Shared plan panel toggle — used by ChatPanel (panel) and InputBar (button) */
export const usePlanPanelStore = create<{
  open: boolean;
  toggle: () => void;
  close: () => void;
}>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

/** Resizable right-side plan panel */
function PlanPanel({ planMessages, onClose }: {
  planMessages: ChatMessage[];
  onClose: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState(420);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left edge → moving left = wider
      const delta = startX.current - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startW.current + delta));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      className="absolute right-3 top-3 bottom-3 z-20
        bg-bg-card/80 backdrop-blur-xl border border-white/10 rounded-2xl
        shadow-2xl shadow-black/20
        flex flex-col overflow-hidden"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize
          hover:bg-accent/20 active:bg-accent/30 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5
        border-b border-border-subtle bg-accent/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-accent">
            <path d="M2 3.5h10M2 7h8M2 10.5h5" />
          </svg>
          <span className="text-xs font-semibold text-text-primary">
            {t('msg.planTitle')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
            transition-smooth cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {planMessages.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-4">
            {t('msg.noPlan')}
          </p>
        ) : (
          planMessages.map((planMsg) => (
            <div key={planMsg.id} className="text-sm leading-relaxed">
              <MarkdownRenderer content={planMsg.planContent || planMsg.content || ''} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Map raw model ID to friendly display name */
function getModelDisplayName(modelId: string): string {
  const option = MODEL_OPTIONS.find((m) => modelId === m.id);
  return option?.short || displayProviderModelName(modelId);
}


/** Format token count: "3.2k" for >=1000, raw number for <1000 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format elapsed seconds into "Xm Ys" or "Xs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** Cycling typewriter text for thinking phase — like Claude Code website "Built for > coders" */
const THINKING_WORD_COUNT = 5;
const TYPING_SPEED = 80;      // ms per character (typing)
const DELETING_SPEED = 40;    // ms per character (deleting)
const PAUSE_DURATION = 2500;  // ms to hold full word
const TRANSITION_DELAY = 300; // ms between delete and next word

/** Fisher-Yates shuffle, always starts with index 0 ("思考中"/"Thinking") */
function shuffledOrder(count: number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i); // skip index 0
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CyclingThinkingText() {
  const t = useT();
  const [order, setOrder] = useState(() => shuffledOrder(THINKING_WORD_COUNT));
  const [cursor, setCursor] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting' | 'waiting'>('typing');

  const wordIndex = order[cursor];
  const fullWord = t(`chat.thinkingCycle.${wordIndex}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (phase === 'typing') {
      if (displayText.length < fullWord.length) {
        timer = setTimeout(() => {
          setDisplayText(fullWord.slice(0, displayText.length + 1));
        }, TYPING_SPEED);
      } else {
        timer = setTimeout(() => setPhase('pausing'), 0);
      }
    } else if (phase === 'pausing') {
      timer = setTimeout(() => setPhase('deleting'), PAUSE_DURATION);
    } else if (phase === 'deleting') {
      if (displayText.length > 0) {
        timer = setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, DELETING_SPEED);
      } else {
        const nextCursor = cursor + 1;
        if (nextCursor >= THINKING_WORD_COUNT) {
          // Reshuffle when all words shown
          setOrder(shuffledOrder(THINKING_WORD_COUNT));
          setCursor(0);
        } else {
          setCursor(nextCursor);
        }
        setPhase('waiting');
      }
    } else if (phase === 'waiting') {
      timer = setTimeout(() => {
        setDisplayText('');
        setPhase('typing');
      }, TRANSITION_DELAY);
    }

    return () => clearTimeout(timer);
  }, [displayText, phase, fullWord, cursor]);

  return (
    <span className="inline-flex items-baseline">
      <span>{displayText}</span>
      <span className="text-text-tertiary">...</span>
    </span>
  );
}

/** Activity indicator with elapsed time and token count */
function ActivityIndicator({ activityStatus, sessionMeta }: {
  activityStatus: { phase: string; toolName?: string };
  sessionMeta: {
    turnStartTime?: number;
    outputTokens?: number;
    inputTokens?: number;
    contextInputTokens?: number;
    lastProgressAt?: number;
    spawnedModel?: string;
    snapshotModel?: string;
    snapshotContextWindowMode?: import('../../stores/settingsStore').ContextWindowMode;
  };
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const phaseText = activityStatus.phase === 'thinking' ? t('chat.thinking')
    : activityStatus.phase === 'writing' ? t('chat.writing')
    : activityStatus.phase === 'tool' ? `${t('chat.runningTool')}: ${activityStatus.toolName || ''}`
    : activityStatus.phase === 'awaiting' ? t('chat.awaiting')
    : t('chat.running');

  const elapsed = sessionMeta.turnStartTime ? formatElapsed(now - sessionMeta.turnStartTime) : null;
  const tokens = sessionMeta.outputTokens ? formatTokens(sessionMeta.outputTokens) : null;
  const statsText = elapsed
    ? tokens ? `(${elapsed} · ↓ ${tokens})` : `(${elapsed})`
    : null;

  // Context pressure warning: threshold depends on model context window size
  // 1M models (claude-opus-4-6-1m, mimo-v2-pro[1m]) → warn at 600K; others at 120K (60% of 200K)
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const resolvedModel = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || resolveModelForProvider(selectedModel);
  const contextWindow = getContextWindowForModel(
    resolvedModel,
    sessionMeta.snapshotContextWindowMode ?? contextWindowMode,
  );
  const inputTokens = sessionMeta.contextInputTokens ?? sessionMeta.inputTokens ?? 0;
  const contextWarning = inputTokens > contextWindow * 0.6;

  // Stall detection: 120s of silence (no stream activity), not total elapsed time.
  const stallWarning = !!sessionMeta.lastProgressAt
    && !!elapsed
    && (now - sessionMeta.lastProgressAt) > 120_000;

  const isThinking = activityStatus.phase === 'thinking';

  return (
    <div className="flex items-center gap-1.5 py-1">
      <span className={`text-sm font-medium leading-none text-accent
        ${isThinking ? '' : 'animate-pulse-soft'}`}>/</span>
      <span className="text-sm text-text-muted">
        {isThinking ? <CyclingThinkingText /> : phaseText}
        {statsText && (
          <span className={`ml-1.5 ${stallWarning ? 'text-red-400' : 'text-text-tertiary'}`}>{statsText}</span>
        )}
      </span>
      {stallWarning && (
        <span className="text-xs text-red-400 ml-2 flex items-center gap-1">
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
          </svg>
          {t('chat.stallWarning')}
        </span>
      )}
      {contextWarning && !stallWarning && (
        <span className="text-xs text-amber-500 ml-2 flex items-center gap-1"
              title={t('chat.tokenWarning')}>
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          {t('chat.tokenWarning')}
        </span>
      )}
    </div>
  );
}

/** 上下文占用进度条 + 压缩按钮。现在渲染在 InputBar 工具行里、紧挨模型选择框左侧
 *  （原先在 ChatPanel 顶部标题栏），组件定义留在这里、导出给 InputBar 用，
 *  避免拆成单独文件时把一堆内部状态和依赖也拆散。 */
export function ContextMeter({ sessionMeta, tabId, sessionStatus }: {
  sessionMeta: SessionMeta;
  tabId: string | null;
  sessionStatus?: string;
}) {
  const t = useT();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const [isCompacting, setIsCompacting] = useState(false);
  const modelForContext = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || sessionMeta.model
    || resolveModelForProvider(selectedModel);
  const effectiveContextMode = sessionMeta.snapshotContextWindowMode ?? contextWindowMode;
  const contextWindow = getContextWindowForModel(modelForContext, effectiveContextMode);
  const compactThreshold = getAutoCompactThreshold(modelForContext, effectiveContextMode, autoCompactThresholdTokens);
  const used = Math.min(contextWindow, getContextUsedTokens(sessionMeta));
  const available = Math.max(0, contextWindow - used);
  const percent = Math.min(100, Math.round((used / contextWindow) * 100));
  const thresholdPercent = Math.min(100, Math.round((compactThreshold / contextWindow) * 100));
  const isBusy = sessionStatus === 'running';
  const hasLiveProcess = Boolean(sessionMeta.stdinId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 没有运行中的进程时（历史会话），只要是有内容的真实会话，也可以压缩：
  // 点击后由输入框把 /compact 作为第一条消息发给 CLI，续接会话并压缩
  const canResumeAndCompact = Boolean(
    tabId && !hasLiveProcess && used > 0
    && sessionMeta.sessionId && !sessionMeta.sessionId.startsWith('desk_'),
  );
  const canCompact = Boolean(tabId && !isBusy && !isCompacting && (hasLiveProcess || canResumeAndCompact));
  const compactHint = canCompact
    ? t('chat.compactNow')
    : isBusy || isCompacting ? t('chat.compactBusy') : t('chat.compactEmpty');

  const handleCompactClick = () => {
    if (!canCompact) return;
    setConfirmOpen(true);
  };

  const handleCompact = async () => {
    setConfirmOpen(false);
    if (!canCompact || !tabId) return;
    if (!hasLiveProcess) {
      window.dispatchEvent(new CustomEvent('tokenicode:compact-now'));
      return;
    }
    if (!sessionMeta.stdinId) return;
    setIsCompacting(true);
    const processingMsgId = generateMessageId();
    const store = useChatStore.getState();
    // 压缩前的 token 数自己先记下来，不等 CLI 的 compact_boundary 事件——
    // 那个事件里的 compactMetadata 时有时无（和 5h/7d 用量数据一样是 CLI 那边
    // 不太稳定的附加字段），等不到就会一直显示"压缩中"没有前后对比数字。
    store.addMessage(tabId, {
      id: processingMsgId,
      role: 'system',
      type: 'text',
      content: '',
      commandType: 'processing',
      commandData: { command: '/compact', compactSummary: { preTokens: used } },
      commandStartTime: Date.now(),
      commandCompleted: false,
      timestamp: Date.now(),
    });
    store.setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    try {
      await bridge.sendStdin(sessionMeta.stdinId, '/compact');
    } catch (e) {
      store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
      store.setSessionStatus(tabId, 'error');
      console.warn('[ClaudeDeck] manual compact failed:', e);
    } finally {
      setIsCompacting(false);
    }
  };

  return (
    <div className="hidden md:flex flex-shrink-0 items-center gap-2 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary whitespace-nowrap"
      title={t('chat.contextTooltip')
        .replace('{model}', displayProviderModelName(modelForContext))
        .replace('{used}', used.toLocaleString())
        .replace('{window}', contextWindow.toLocaleString())
        .replace('{free}', available.toLocaleString())
        .replace('{threshold}', compactThreshold.toLocaleString())}>
      <span className="font-medium text-text-muted">{t('chat.contextLabel')}</span>
      <div className="w-20 h-1.5 rounded-full bg-bg-tertiary overflow-hidden flex-shrink-0">
        <div
          className={`h-full rounded-full ${percent >= thresholdPercent ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={percent >= thresholdPercent ? 'text-warning' : 'text-text-tertiary'}>
        {percent}%
      </span>
      <span>{t('chat.contextFree').replace('{n}', formatTokens(available))}</span>
      <button
        onClick={handleCompactClick}
        disabled={!canCompact}
        className="flex-shrink-0 px-2 py-0.5 rounded border border-border-subtle bg-bg-card
          text-text-primary font-medium cursor-pointer transition-smooth
          hover:bg-accent/10 hover:text-accent hover:border-accent/30
          disabled:opacity-40 disabled:cursor-not-allowed
          disabled:hover:bg-bg-card disabled:hover:text-text-primary disabled:hover:border-border-subtle"
        title={compactHint}
      >
        {t('chat.compact')}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={t('chat.compactConfirmTitle')}
        message={t('chat.compactConfirmMessage')}
        confirmLabel={t('chat.compact')}
        onConfirm={handleCompact}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** 把 unix 秒转成"还剩 Xh Ym" / "还剩 Xd Yh"这样的倒计时文案；已过期返回 null */
function formatResetCountdown(resetsAtSec: number, t: (k: string) => string): string | null {
  const ms = resetsAtSec * 1000 - Date.now();
  if (ms <= 0) return null;
  const totalMin = Math.ceil(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${t('chat.resetsIn')} ${days}${t('chat.days')} ${hours}${t('chat.hours')}`;
  if (hours > 0) return `${t('chat.resetsIn')} ${hours}${t('chat.hours')} ${mins}${t('chat.minutes')}`;
  return `${t('chat.resetsIn')} ${mins}${t('chat.minutes')}`;
}

/** 一个用量窗口（5 小时 / 7 天）的小段：有百分比就画进度条，没有(数据缺失、只知道
 *  重置时间)就只显示状态点 + 倒计时——绝不能在缺失时拿本地数据凑一个假数字出来显示。 */
function RateLimitWindowView({ label, entry, t }: {
  label: string;
  entry?: RateLimitWindow;
  t: (k: string) => string;
}) {
  if (!entry) return null;
  const hasPercent = typeof entry.usedPercentage === 'number' && Number.isFinite(entry.usedPercentage);
  const percent = hasPercent ? Math.min(100, Math.round(entry.usedPercentage!)) : null;
  const isWarning = percent !== null && percent >= 80;
  const isRejected = percent !== null && percent >= 100;
  const colorClass = isRejected ? 'text-error' : isWarning ? 'text-warning' : 'text-text-tertiary';
  const countdown = entry.resetsAt ? formatResetCountdown(entry.resetsAt, t) : null;
  if (!hasPercent && !countdown) return null;

  return (
    <div className="flex items-center gap-1" title={countdown ?? undefined}>
      <span className="font-medium text-text-muted">{label}</span>
      {hasPercent ? (
        <>
          <div className="w-10 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className={`h-full rounded-full ${isRejected ? 'bg-error' : isWarning ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={colorClass}>{percent}%</span>
        </>
      ) : (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-success" />
      )}
      {countdown && !hasPercent && <span className="text-text-tertiary">{countdown}</span>}
    </div>
  );
}

/** 5 小时 / 7 天用量状态条。数据全局共享一份缓存（useRateLimitsStore，落一份到
 *  localStorage），不挂在某个会话 tab 下——账户级别的用量数据本来就不该按会话分开存：
 *  切换会话不会清空，哪个会话轮询到新数据全局都能看到，重开应用也先显示上次已知的值，
 *  不用等第一次轮询回来。只对本机会话生效——远程会话没有 sessionId 对应本地钩子文件。 */
function UsageStatusBar({ sessionMeta }: { sessionMeta: SessionMeta }) {
  const t = useT();
  const cliSessionId = sessionMeta.sessionId;
  const fiveHour = useRateLimitsStore((s) => s.fiveHour);
  const sevenDay = useRateLimitsStore((s) => s.sevenDay);
  const setFromHook = useRateLimitsStore((s) => s.setFromHook);

  useEffect(() => {
    if (!cliSessionId || cliSessionId.startsWith('desk_')) return;
    let cancelled = false;
    const poll = async () => {
      const data = await bridge.getSessionRateLimits(cliSessionId);
      if (cancelled || !data) return;
      setFromHook(data);
    };
    void poll();
    const timer = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cliSessionId, setFromHook]);

  if (!fiveHour && !sevenDay) return null;

  return (
    <div className="hidden md:flex items-center gap-3 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px]">
      <RateLimitWindowView label="5h" entry={fiveHour} t={t} />
      <RateLimitWindowView label={t('chat.weekly')} entry={sevenDay} t={t} />
    </div>
  );
}

function ConversationTimeline({ turns, scrollRef, messageRefs, showScrollBtn, onJumped, onJumpBottom }: {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  showScrollBtn: boolean;
  /** 跳转后通知聊天面板：暂停流式输出时的自动贴底，避免把视图拉回底部 */
  onJumped: () => void;
  onJumpBottom: () => void;
}) {
  const t = useT();
  // 当前高亮的轮次放在这里而不是 ChatPanel：滚动时它频繁变化，放在上层会导致整个消息列表重渲染而卡顿
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  // 点击跳转后短暂锁定高亮，避免滚动事件把它改成相邻的短轮次而闪烁
  const lockUntilRef = useRef(0);
  const rafRef = useRef(0);

  /** 节点相对滚动容器内容顶部的位置（不依赖 offsetParent，避免定位祖先带来的偏差） */
  const nodeTop = (container: HTMLElement, node: HTMLElement) =>
    node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el || turns.length === 0) {
      setActiveTurnId(undefined);
      return;
    }
    if (performance.now() < lockUntilRef.current) return;
    const marker = el.scrollTop + 140;
    let current = turns[0].userMessageId;
    for (const turn of turns) {
      const node = messageRefs.current.get(turn.userMessageId);
      if (!node) continue;
      if (nodeTop(el, node) <= marker) {
        current = turn.userMessageId;
      } else {
        break;
      }
    }
    setActiveTurnId((prev) => (prev === current ? prev : current));
  }, [turns, scrollRef, messageRefs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 每帧最多计算一次
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        recompute();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    recompute();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [scrollRef, recompute]);

  const jumpTo = (turn: Turn) => {
    const el = scrollRef.current;
    const node = messageRefs.current.get(turn.userMessageId);
    if (!el || !node) return;
    onJumped();
    lockUntilRef.current = performance.now() + 300;
    setActiveTurnId(turn.userMessageId);
    // 直接定位，不使用平滑滚动：平滑动画期间的连续滚动事件是卡顿和闪烁的来源
    el.scrollTo({ top: Math.max(0, nodeTop(el, node) - 16), behavior: 'auto' });
  };

  if (turns.length === 0) return null;

  return (
    <div className="hidden lg:flex absolute right-3 top-24 bottom-28 z-10
      flex-col items-center gap-2 pointer-events-none">
      <div className="flex-1 min-h-0 px-1 py-2 rounded-lg
        bg-bg-card/80 backdrop-blur border border-border-subtle shadow-lg
        overflow-y-auto scrollbar-none pointer-events-auto">
        <div className="flex flex-col items-center gap-1.5">
          {turns.map((turn) => {
            const active = activeTurnId === turn.userMessageId;
            return (
              <button
                key={turn.userMessageId}
                onClick={() => jumpTo(turn)}
                className={`group relative w-7 h-7 rounded-full text-[10px]
                  flex items-center justify-center border transition-colors
                  ${active
                    ? 'bg-accent text-text-inverse border-accent shadow-md'
                    : 'bg-bg-secondary/70 text-text-tertiary border-border-subtle hover:text-text-primary hover:bg-bg-tertiary'
                  }`}
                title={`${t('chat.turn')} ${turn.index}: ${turn.userContent}`}
              >
                {turn.index > 99 ? '99+' : turn.index}
              </button>
            );
          })}
        </div>
      </div>

      {/* 固定占位：始终占住这块高度，只切换可见性——只在向上翻离底部较远时才需要
          显示，但如果隐藏时不占位，上面圆点导航条（flex-1）会跟着变高变矮，
          高度一跳一跳的。图标尺寸和上面圆点导航条一致，不带文字。 */}
      <button
        onClick={onJumpBottom}
        className={`flex-shrink-0 w-7 h-7 rounded-full
          flex items-center justify-center
          border border-border-subtle bg-bg-card/90 backdrop-blur
          shadow-lg text-accent hover:bg-accent/10 transition-smooth
          ${showScrollBtn ? 'pointer-events-auto' : 'invisible pointer-events-none'}`}
        title={t('chat.latest')}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M7 2v10M3 8l4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useActiveTab((t) => t.messages);
  const isStreaming = useActiveTab((t) => t.isStreaming);
  const partialText = useActiveTab((t) => t.partialText);
  const partialThinking = useActiveTab((t) => t.partialThinking);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const activityStatus = useActiveTab((t) => t.activityStatus);
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
      useFileStore.getState().selectFile(filePath);
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
      items.push({ kind: 'message', msg: messages[i], idx: i });
      i++;
    }
    return items;
  }, [messages]);

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
  }, []);

  // Track whether user is near the bottom of the scroll container, throttled via rAF
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
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

  // Auto-scroll to bottom only when already near bottom and user isn't scrolling up
  useEffect(() => {
    if (isNearBottomRef.current && !userScrollingUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, partialText, partialThinking]);

  // Auto-scroll the internal thinking <pre> to bottom as new content streams in
  useEffect(() => {
    const el = thinkingPreRef.current;
    if (el && partialThinking) {
      el.scrollTop = el.scrollHeight;
    }
  }, [partialThinking]);

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar — with extra top padding for macOS traffic lights */}
      <div
        className="flex items-center h-[68px] pt-[20px] px-5 border-b border-border-subtle
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
        <UsageStatusBar sessionMeta={sessionMeta} />
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
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-6 selectable chat-scroll-container">
        {!workingDirectory && messages.length === 0 && !isStreaming ? (
          <WelcomeScreen />
        ) : messages.length === 0 && !isStreaming && sessionStatus === 'running' ? (
          <LoadingSessionState />
        ) : messages.length === 0 && !isStreaming ? (
          <EmptyReadyState />
        ) : (
          <div className="max-w-5xl mx-auto">
            {displayItems.map((item, displayIdx) => {
              // Determine spacing based on item type
              const isCompact = item.kind === 'tool_group'
                || (item.kind === 'message' && ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(item.msg.type));
              const prevItem = displayIdx > 0 ? displayItems[displayIdx - 1] : null;
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
                </div>
              );
            })}
            {/* Streaming thinking — collapsible like ThinkingMsg but with pulse cursor */}
            {isStreaming && partialThinking && (
              <div className="ml-11 mt-1">
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
                  <div className="w-8 h-8 rounded-[10px] bg-accent
                    flex items-center justify-center flex-shrink-0 text-text-inverse
                    text-xs font-bold shadow-md mt-0.5">C</div>
                ) : (
                  <div className="w-8 flex-shrink-0" />
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
        />
      )}

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

/** Start a new draft conversation for the given folder and pre-warm the CLI process */
async function startDraftSession(folderPath: string) {
  useSettingsStore.getState().setWorkingDirectory(folderPath);
  const currentTab = useSessionStore.getState().selectedSessionId;
  if (currentTab) useChatStore.getState().resetTab(currentTab);

  // Reuse existing draft tab if one is already selected, otherwise create a new one
  const currentTabId = useSessionStore.getState().selectedSessionId;
  const currentSession = useSessionStore.getState().sessions.find(
    (s) => s.id === currentTabId,
  );
  let draftId: string;
  if (currentSession && currentSession.path === '') {
    // Reuse the existing draft — just update its project info
    draftId = currentSession.id;
    useSessionStore.getState().updateDraftProject(draftId, folderPath);
  } else {
    // No draft selected — create a new one
    draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().addDraftSession(draftId, folderPath);
  }

  // Pre-warm: spawn CLI process in background so first message is fast.
  // Send empty prompt — Rust will skip the NDJSON send.
  const preWarmId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Register stream listeners before spawning
    const unlisten = await onClaudeStream(preWarmId, (msg: any) => {
      // Tag message with stdinId so the handler can route to correct session
      msg.__stdinId = preWarmId;
      // Forward to InputBar's handler via a global — will be overridden when InputBar mounts
      const handler = (window as any).__claudeStreamHandler;
      if (handler) {
        // Replay any events that arrived while handler was briefly null (React effect cycle)
        const queue: any[] = (window as any).__claudeStreamQueue;
        if (queue && queue.length > 0) {
          console.warn(`[ClaudeDeck] replaying ${queue.length} queued pre-warm events`);
          const pending = queue.splice(0);
          for (const queued of pending) handler(queued);
        }
        handler(msg);
      } else {
        // Handler not yet available (InputBar not mounted or React effect cycle) — queue the event
        if (!(window as any).__claudeStreamQueue) (window as any).__claudeStreamQueue = [];
        (window as any).__claudeStreamQueue.push(msg);
        console.warn('[ClaudeDeck] pre-warm event queued (handler not ready):', msg.type);
      }
    });
    const unlistenStderr = await onClaudeStderr(preWarmId, (line: string) => {
      // Log pre-warm stderr for debugging (errors here explain why CLI may fail)
      console.warn('[ClaudeDeck] pre-warm stderr:', line);
    });

    // Store unlisten per stdinId for multi-session support
    if (!(window as any).__claudeUnlisteners) {
      (window as any).__claudeUnlisteners = {};
    }
    (window as any).__claudeUnlisteners[preWarmId] = () => {
      unlisten();
      unlistenStderr();
    };

    const selectedModel = useSettingsStore.getState().selectedModel;
    const sessionMode = useSettingsStore.getState().sessionMode;
    const thinkingSetting = useSettingsStore.getState().thinkingLevel;
    const contextWindowMode = useSettingsStore.getState().contextWindowMode;
    const providerId = useProviderStore.getState().activeProviderId || null;
    const resolvedModel = resolveModelForProvider(selectedModel);
    const session = await bridge.startSession({
      prompt: '',  // empty = pre-warm, no message sent
      cwd: folderPath,
      model: resolvedModel,
      session_id: preWarmId,
      thinking_level: resolveThinkingLevelForProvider(
        selectedModel,
        thinkingSetting,
      ),
      provider_id: providerId || undefined,
      context_window: getContextWindowForModel(resolvedModel, contextWindowMode),
      permission_mode: mapSessionModeToPermissionMode(sessionMode),
      enable_mcp: useSettingsStore.getState().enableMcp,
    });

    // Store stdinId so InputBar can send the first message via stdin
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, {
      sessionId: session.session_id,
      stdinId: preWarmId,
      envFingerprint: envFingerprint(),
      snapshotMode: sessionMode,
      snapshotModel: selectedModel,
      snapshotThinking: thinkingSetting,
      snapshotContextWindowMode: contextWindowMode,
      snapshotProviderId: providerId,
      spawnedModel: resolvedModel,
    });

    // Register stdinId → tabId mapping for background stream routing
    useSessionStore.getState().registerStdinTab(preWarmId, draftId);
  } catch {
    // Pre-warm failed — InputBar will spawn on first message instead
  }
}

/** Welcome screen shown when no project folder is selected */
function WelcomeScreen() {
  const t = useT();
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const recentProjects = useFileStore((s) => s.recentProjects);
  const fetchProjects = useFileStore((s) => s.fetchRecentProjects);
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const allSessions = useSessionStore((s) => s.sessions);
  const isRemoteEnv = activeEnv !== 'local';
  // 远程环境下，最近项目取自该主机上已有会话的项目目录
  const remoteRecent = useMemo(() => {
    if (!isRemoteEnv) return [];
    const latest = new Map<string, number>();
    for (const s of allSessions) {
      if (s.host !== activeEnv || !s.project) continue;
      latest.set(s.project, Math.max(latest.get(s.project) || 0, s.modifiedAt));
    }
    return Array.from(latest.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([path]) => ({
        path,
        name: path.split('/').filter(Boolean).pop() || path,
        shortPath: path,
      }));
  }, [isRemoteEnv, activeEnv, allSessions]);

  useEffect(() => { fetchProjects(); }, []);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (selected) {
      startDraftSession(selected as string);
    }
  }, [t]);

  // Show SetupWizard if setup has not been completed
  if (!setupCompleted) {
    return <SetupWizard />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-20 h-20" rounded="rounded-3xl" className="mb-6 shadow-glow" />
      <h2 className="text-xl font-semibold text-accent mb-2">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed mb-6">
        {t('welcome.subtitle')}
      </p>

      {isRemoteEnv && (
        <div className="w-full max-w-sm mb-8">
          <p className="text-xs text-text-tertiary mb-2">{t('env.remoteWelcome')}</p>
          <RemotePathInput hostId={activeEnv} onOpen={startDraftSession} />
        </div>
      )}

      {/* Primary action: new chat with folder picker */}
      {!isRemoteEnv && (
      <button
        onClick={handlePickFolder}
        className="px-6 py-3 rounded-[20px] text-sm font-medium
          bg-accent hover:bg-accent-hover text-text-inverse
          hover:shadow-glow transition-smooth
          flex items-center gap-2 mb-8"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h4l2 2h6v7H2V4z" />
        </svg>
        {t('welcome.newChat')}
      </button>
      )}

      {/* Recent projects */}
      {(isRemoteEnv ? remoteRecent : recentProjects).length > 0 && (
        <div className="w-full max-w-sm">
          <div className="text-[11px] font-medium text-text-tertiary uppercase
            tracking-wider mb-3">
            {t('welcome.recentProjects')}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {(isRemoteEnv ? remoteRecent : recentProjects).slice(0, 6).map((project) => (
              <button
                key={project.path}
                onClick={() => startDraftSession(project.path)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5
                  rounded-lg border border-border-subtle text-xs
                  text-text-muted hover:border-accent hover:text-accent
                  hover:bg-accent/5 transition-smooth"
                title={project.shortPath}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5"
                  className="flex-shrink-0 text-text-tertiary">
                  <path d="M2 4h4l2 2h6v7H2V4z" />
                </svg>
                {project.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Empty state shown when project is selected but no messages yet */
/** 从磁盘（含远程 ssh）加载会话内容期间显示，避免看起来和“空的新会话”一样 */
function LoadingSessionState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-4" />
      <p className="text-sm text-text-muted">{t('chat.loadingSession')}</p>
    </div>
  );
}

function EmptyReadyState() {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-16 h-16" rounded="rounded-2xl" className="mb-5 shadow-glow" />
      <h2 className="text-lg font-semibold text-accent mb-1">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed">
        {t('chat.welcomeWithProject')}
      </p>
      {workingDirectory && (
        <p className="text-xs text-text-tertiary mt-2 truncate max-w-xs">
          {workingDirectory}
        </p>
      )}
    </div>
  );
}
