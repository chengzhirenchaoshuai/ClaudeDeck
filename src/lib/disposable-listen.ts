/**
 * 把异步注册的事件监听（Tauri 的 listen / onDragDropEvent / onCloseRequested 等）包装成
 * useEffect 可直接返回的同步清理函数。
 *
 * 注册是异步的：若 effect 在注册完成前就被清理（StrictMode 双挂载、组件快速重挂载），
 * 直接 `unlisten?.()` 什么也不会做，监听器从此泄漏，同一事件会被处理多次。
 * 这里在注册完成时检查是否已清理，已清理则立即注销。
 */
export function disposableListen(register: Promise<() => void>): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  register
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}
