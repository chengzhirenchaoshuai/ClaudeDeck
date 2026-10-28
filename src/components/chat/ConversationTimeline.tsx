// 对话轮次导航条：按用户消息分轮，点击跳转，并提供回到底部按钮。
import { useRef, useEffect, useState, useCallback } from 'react';
import { useT } from '../../lib/i18n';
import { type Turn } from '../../lib/turns';

export function ConversationTimeline({ turns, scrollRef, messageRefs, showScrollBtn, onJumped, onJumpBottom, ensureRendered }: {
  turns: Turn[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  showScrollBtn: boolean;
  /** 跳转后通知聊天面板：暂停流式输出时的自动贴底，避免把视图拉回底部 */
  onJumped: () => void;
  onJumpBottom: () => void;
  /** 消息列表分段渲染：目标消息尚未渲染时由聊天面板扩展渲染范围并返回 false */
  ensureRendered?: (messageId: string) => boolean;
}) {
  const t = useT();
  // 当前高亮的轮次放在这里而不是 ChatPanel：滚动时它频繁变化，放在上层会导致整个消息列表重渲染而卡顿
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  // 点击跳转后锁定高亮，直到用户自己滚动（滚轮/拖动/按键）才解除：
  // 跳到的轮次很短、或靠近末尾滚不到位时，按位置计算会落到相邻轮次
  const jumpLockRef = useRef(false);
  const rafRef = useRef(0);
  const navRef = useRef<HTMLDivElement>(null);

  /** 节点相对滚动容器内容顶部的位置（不依赖 offsetParent，避免定位祖先带来的偏差） */
  const nodeTop = (container: HTMLElement, node: HTMLElement) =>
    node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el || turns.length === 0) {
      setActiveTurnId(undefined);
      return;
    }
    if (jumpLockRef.current) return;
    // 已滚到底：最后一轮可能很短，它的用户消息够不到判定线，直接算最后一轮
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) {
      const last = turns[turns.length - 1].userMessageId;
      setActiveTurnId((prev) => (prev === last ? prev : last));
      return;
    }
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
    // 用户主动滚动时解除跳转锁定
    const unlock = () => { jumpLockRef.current = false; };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', unlock, { passive: true });
    el.addEventListener('pointerdown', unlock);
    el.addEventListener('keydown', unlock);
    // 内容高度变化（流式输出、展开工具卡片）不一定伴随滚动事件，也要重新计算
    const ro = new ResizeObserver(onScroll);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    recompute();
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', unlock);
      el.removeEventListener('pointerdown', unlock);
      el.removeEventListener('keydown', unlock);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [scrollRef, recompute]);

  // 新增一轮（发出新消息后会自动贴底）时解除锁定。只依赖轮数：turns 在流式输出时
  // 每次都是新数组，依赖它会让锁定被频繁解除
  useEffect(() => {
    jumpLockRef.current = false;
    recompute();
  }, [turns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // 轮次多时导航条自身可滚动：保证高亮的按钮在导航条可视范围内
  useEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>('[data-active="true"]');
    if (!nav || !btn) return;
    const top = btn.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop) nav.scrollTop = top - 8;
    else if (top + btn.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + btn.offsetHeight - nav.clientHeight + 8;
    }
  }, [activeTurnId]);

  // 目标消息还没渲染时先记下，等聊天面板补渲染后（本组件随之重新渲染）再跳转
  const pendingJumpRef = useRef<Turn | null>(null);
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (pending && messageRefs.current.has(pending.userMessageId)) {
      pendingJumpRef.current = null;
      jumpTo(pending);
    }
  });

  const jumpTo = (turn: Turn) => {
    const el = scrollRef.current;
    const node = messageRefs.current.get(turn.userMessageId);
    if (!el) return;
    if (!node) {
      if (ensureRendered && !ensureRendered(turn.userMessageId)) pendingJumpRef.current = turn;
      return;
    }
    onJumped();
    jumpLockRef.current = true;
    setActiveTurnId(turn.userMessageId);
    // 直接定位，不使用平滑滚动：平滑动画期间的连续滚动事件是卡顿和闪烁的来源
    el.scrollTo({ top: Math.max(0, nodeTop(el, node) - 16), behavior: 'auto' });
  };

  if (turns.length === 0) return null;

  return (
    <div className="hidden lg:flex absolute right-3 top-24 bottom-3 z-10
      flex-col items-center gap-2 pointer-events-none">
      <div ref={navRef} className="flex-1 min-h-0 px-1 py-2 rounded-lg
        bg-bg-card/80 backdrop-blur border border-border-subtle shadow-lg
        overflow-y-auto scrollbar-none pointer-events-auto">
        <div className="flex flex-col items-center gap-1.5">
          {turns.map((turn) => {
            const active = activeTurnId === turn.userMessageId;
            return (
              <button
                key={turn.userMessageId}
                data-active={active}
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
        onClick={() => { jumpLockRef.current = false; onJumpBottom(); }}
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
