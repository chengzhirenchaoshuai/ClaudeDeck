import { useEffect } from 'react';
import { useUpdateStore } from '../stores/updateStore';

// 启动后稍等再查，避开启动时的网络与 CLI 检测；程序常驻托盘，之后每 6 小时再查一次
const STARTUP_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 静默检查应用更新，有新版时顶栏显示更新按钮。开发模式下不检查 */
export function useAutoUpdateCheck(): void {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const run = () => useUpdateStore.getState().check(false);
    const startupTimer = setTimeout(run, STARTUP_DELAY_MS);
    const intervalTimer = setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
    };
  }, []);
}
