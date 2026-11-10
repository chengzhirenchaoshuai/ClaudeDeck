/**
 * 各 CLI 会话（按 stdinId）的流事件监听器注销函数。
 * 沿用原有做法保存在 window 上，供各组件、hook 跨模块访问。
 */
import type { StreamMessage } from './stream-message';

type Unlisten = () => void;

declare global {
  interface Window {
    /** stdinId → 注销该会话 stream/stderr 监听器的函数 */
    __claudeUnlisteners?: Record<string, Unlisten>;
    /** 最近一次启动的前台会话的注销函数（旧逻辑仍在使用） */
    __claudeUnlisten?: Unlisten | null;
    /** InputBar 挂载后提供的流消息处理函数 */
    __claudeStreamHandler?: (msg: StreamMessage) => void;
    /** InputBar 挂载前收到的流消息，挂载后补处理 */
    __claudeStreamQueue?: StreamMessage[];
    /** 已记录过首个事件日志的 stdinId */
    __tcFirstEventLogged?: Record<string, boolean>;
  }
}

/** 登记某会话的注销函数（覆盖已有的） */
export function setStreamListener(stdinId: string, unlisten: Unlisten): void {
  (window.__claudeUnlisteners ??= {})[stdinId] = unlisten;
}

export function hasStreamListener(stdinId: string): boolean {
  return !!window.__claudeUnlisteners?.[stdinId];
}

/** 注销并移除某会话的监听器；不存在时什么也不做 */
export function releaseStreamListener(stdinId: string | null | undefined): void {
  if (!stdinId) return;
  const unlisten = window.__claudeUnlisteners?.[stdinId];
  if (!unlisten) return;
  unlisten();
  delete window.__claudeUnlisteners![stdinId];
}

/**
 * 把流消息交给 InputBar 提供的完整处理函数；InputBar 还没挂载时先排队，挂载后由它补处理。
 * 用于在 InputBar 之外注册的监听（预热进程、刷新后重新接上的进程）。
 */
export function dispatchToStreamHandler(msg: StreamMessage): void {
  const handler = window.__claudeStreamHandler;
  if (!handler) {
    (window.__claudeStreamQueue ??= []).push(msg);
    return;
  }
  const queue = window.__claudeStreamQueue;
  if (queue && queue.length > 0) {
    for (const queued of queue.splice(0)) handler(queued);
  }
  handler(msg);
}
