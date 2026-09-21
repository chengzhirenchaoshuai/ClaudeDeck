import { useSessionStore } from '../stores/sessionStore';
import { bridge } from './tauri-bridge';
import { APP_NAME } from './edition';

let quitPending = false;

/**
 * 退出应用：有任务正在运行时先确认（区分本地与各远程主机的任务数），
 * 确认后有序终止所有会话进程，再退出。空闲时直接退出，不再弹窗。
 * 关闭窗口（未开启“最小化到任务栏”时）、设置里的“退出应用”、Ctrl+Shift+Q 都走这里。
 */
export async function requestQuit(t: (key: string) => string): Promise<void> {
  if (quitPending) return;
  quitPending = true;
  try {
    const { runningSessions, sessions } = useSessionStore.getState();
    let localCount = 0;
    const remoteCounts = new Map<string, number>();
    for (const id of runningSessions) {
      const host = sessions.find((s) => s.id === id)?.host;
      if (host) remoteCounts.set(host, (remoteCounts.get(host) || 0) + 1);
      else localCount += 1;
    }

    if (runningSessions.size > 0) {
      const parts: string[] = [];
      if (localCount > 0) parts.push(t('confirm.exitLocal').replace('{n}', String(localCount)));
      for (const [host, n] of remoteCounts) {
        parts.push(t('confirm.exitRemote').replace('{host}', host).replace('{n}', String(n)));
      }
      const message = t('confirm.exitRunning')
        .replace('{n}', String(runningSessions.size))
        .replace('{detail}', parts.join('、'));
      const { ask } = await import('@tauri-apps/plugin-dialog');
      const confirmed = await ask(message, {
        title: APP_NAME,
        kind: 'warning',
        okLabel: t('common.confirm'),
        cancelLabel: t('common.cancel'),
      });
      if (!confirmed) return;
    }

    // 有序终止本地与远端的会话进程后再退出，避免留下孤儿进程
    await bridge.shutdownAllSessions().catch(() => {});
    const { exit } = await import('@tauri-apps/plugin-process');
    await exit(0);
  } finally {
    quitPending = false;
  }
}
