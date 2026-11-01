// 悬浮在输入栏上方的卡片（提问、计划审批等）可用的最大高度：跟随消息区的实际高度，
// 选项多时尽量完整显示，窗口变小时跟着缩小，不会盖过消息区顶部。
import { useLayoutEffect, useState } from 'react';

/** 卡片顶部与消息区顶部之间至少留出的距离（像素） */
const TOP_GAP = 20;
/** 消息区很矮时卡片仍保留的最小高度 */
const MIN_HEIGHT = 200;

export function useFloatingMaxHeight(enabled: boolean): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = document.querySelector<HTMLElement>('.chat-scroll-container');
    if (!el) return;
    const update = () => setHeight(Math.max(MIN_HEIGHT, el.clientHeight - TOP_GAP));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return height;
}
