import { useEffect } from 'react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { useSessionStore } from '../stores/sessionStore';

/** 绘制任务栏角标：红底白字数字，超过 99 显示 99+ */
async function renderBadge(count: number): Promise<Uint8Array | null> {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();

  const text = count > 99 ? '99+' : String(count);
  const fontSize = text.length === 1 ? 22 : text.length === 2 ? 18 : 13;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

let trayBaseImage: Promise<HTMLImageElement> | null = null;

function loadTrayBase(): Promise<HTMLImageElement> {
  if (!trayBaseImage) {
    trayBaseImage = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = '/tray-icon.png';
    });
  }
  return trayBaseImage;
}

/** 托盘图标：在基础图标右上角叠加红色数字角标；count 为 0 时就是基础图标 */
async function renderTrayIcon(count: number): Promise<Uint8Array | null> {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(await loadTrayBase(), 0, 0, size, size);

  if (count > 0) {
    const r = 20;
    const cx = size - r;
    const cy = r;
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    const text = count > 99 ? '99+' : String(count);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${text.length === 1 ? 28 : text.length === 2 ? 22 : 16}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function updateTray(count: number): Promise<void> {
  const { TrayIcon } = await import('@tauri-apps/api/tray');
  const tray = await TrayIcon.getById('main');
  if (!tray) return;
  const icon = await renderTrayIcon(count);
  if (icon) await tray.setIcon(icon);
  await tray.setTooltip(count > 0 ? `TOKENICODE · ${count} 个未读会话` : 'TOKENICODE');
}

/** 未读会话总数：只统计仍在会话列表里的未读会话（已删除的会话不再计入） */
function countUnread(): number {
  const { unreadSessions, sessions } = useSessionStore.getState();
  if (unreadSessions.size === 0) return 0;
  const existing = new Set(sessions.map((s) => s.id));
  let n = 0;
  for (const id of unreadSessions) if (existing.has(id)) n += 1;
  return n;
}

/**
 * 任务栏 / 托盘角标：显示会话列表中“未读会话”的总数，与列表里的蓝色未读圆点一致。
 * 打开某个会话或回到应用查看它，该会话变为已读，数字随之减少；全部已读时角标消失。
 */
export function useTaskbarBadge(): void {
  useEffect(() => {
    let disposed = false;
    let win: TauriWindow | null = null;
    let applied = -1;
    let running = false;
    let again = false;

    const applyOnce = async () => {
      if (!win) return;
      const count = countUnread();
      if (count === applied) return;
      applied = count;
      try {
        if (count === 0) {
          await win.setOverlayIcon(undefined);
        } else {
          const icon = await renderBadge(count);
          if (icon) await win.setOverlayIcon(icon);
        }
      } catch (err) {
        console.warn('[TOKENICODE] failed to update taskbar badge:', err);
      }
      try {
        await updateTray(count);
      } catch (err) {
        console.warn('[TOKENICODE] failed to update tray badge:', err);
      }
    };

    // 串行执行：更新期间又有变化时，结束后按最新数字再来一次，避免乱序覆盖
    const apply = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await applyOnce();
        } while (again);
      } finally {
        running = false;
      }
    };

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return;
      win = getCurrentWindow();
      void apply(); // 启动时，上次遗留的未读也要显示出来
    });

    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.unreadSessions === prev.unreadSessions && state.sessions === prev.sessions) return;
      void apply();
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}
