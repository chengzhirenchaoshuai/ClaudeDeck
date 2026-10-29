import { useSessionStore } from '../stores/sessionStore';
import { useChatStore } from '../stores/chatStore';
import { ask } from '@tauri-apps/plugin-dialog';
import { bridge } from './tauri-bridge';
import { APP_NAME } from './edition';

let quitPending = false;

/**
 * 退出应用：有任务正在运行时先确认，确认后有序终止所有会话进程，再退出。空闲时直接退出，不再弹窗。
 * 关闭窗口（未开启“关闭时最小化到托盘”时）和托盘菜单的“退出”都走这里。
 */
export async function requestQuit(t: (key: string) => string): Promise<void> {
  if (quitPending) return;
  quitPending = true;
  try {
    // 确认后先隐藏窗口：有序结束 CLI 进程要等它们退出（最多约 3 秒），期间窗口留在屏幕上看起来像卡住了
    const hideWindow = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide().catch(() => {});
    };
    if (!(await confirmAndShutdownSessions(t, 'confirm.exitRunning', hideWindow))) return;
    const { exit } = await import('@tauri-apps/plugin-process');
    await exit(0);
  } finally {
    quitPending = false;
  }
}

/**
 * 应用即将关闭前调用：有任务正在运行时用 messageKey 对应的文案确认（区分本地与各远程主机的任务数），
 * 取消返回 false；确认或空闲时有序终止本地与远端的会话进程后返回 true，避免留下孤儿进程。
 * messageKey 的文案里用 {n} 表示任务总数、{detail} 表示分布明细。
 * beforeShutdown 在确认之后、开始终止进程之前调用。
 */
export async function confirmAndShutdownSessions(
  t: (key: string) => string,
  messageKey: string,
  beforeShutdown?: () => Promise<void>,
): Promise<boolean> {
  const { runningSessions, backgroundTasks, sessions } = useSessionStore.getState();
  // 只统计退出时真的会被中断的任务：正在运行或仍有 CLI 后台任务，且本应用持有它存活的 CLI 进程。
  // 没有进程的“运行中”只是界面状态残留（如加载历史会话途中切走），退出不会中断任何东西。
  const active = new Set(await bridge.listActiveProcesses().catch(() => [] as string[]));
  const chat = useChatStore.getState();
  const candidates = new Set([...runningSessions, ...backgroundTasks.keys()]);
  const interruptible = [...candidates].filter((id) => {
    const stdinId = chat.getTab(id)?.sessionMeta.stdinId;
    return !!stdinId && active.has(stdinId);
  });
  let localCount = 0;
  const remoteCounts = new Map<string, number>();
  for (const id of interruptible) {
    const host = sessions.find((s) => s.id === id)?.host;
    if (host) remoteCounts.set(host, (remoteCounts.get(host) || 0) + 1);
    else localCount += 1;
  }

  if (interruptible.length > 0) {
    const parts: string[] = [];
    if (localCount > 0) parts.push(t('confirm.exitLocal').replace('{n}', String(localCount)));
    for (const [host, n] of remoteCounts) {
      parts.push(t('confirm.exitRemote').replace('{host}', host).replace('{n}', String(n)));
    }
    const message = t(messageKey)
      .replace('{n}', String(interruptible.length))
      .replace('{detail}', parts.join('、'));
    const confirmed = await ask(message, {
      title: APP_NAME,
      kind: 'warning',
      okLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!confirmed) return false;
  }

  await beforeShutdown?.();
  await bridge.shutdownAllSessions().catch(() => {});
  return true;
}
