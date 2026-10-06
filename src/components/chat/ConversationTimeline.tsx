// 对话轮次导航条：按用户消息分轮，点击跳转，并提供回到底部按钮。
import { useRef, useEffect, useState, useCallback } from 'react';
import { useT } from '../../lib/i18n';
import { type Turn } from '../../lib/turns';

export function ConversationTimeline({ turns, scrollRef, messageRefs, showScrollBtn, onJumped, onJumpBottom }: {
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
