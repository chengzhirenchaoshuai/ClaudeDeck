import { useEffect } from 'react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { useSessionStore } from '../stores/sessionStore';
import { finishedSessionIds } from '../lib/session-finish';

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
  await tray.setTooltip(count > 0 ? `TOKENICODE · ${count} 个会话已结束` : 'TOKENICODE');
}

/**
 * 任务栏 / 托盘角标：应用不在最前（未获得焦点或已最小化）时，每有一个会话结束，
 * 任务栏图标上的数字加一（同一会话只计一次）；窗口重新获得焦点后清零。
 * 结束的判定取自 sessionStore.runningSessions 中会话的移除。
 */
export function useTaskbarBadge(): void {
  useEffect(() => {
    let disposed = false;
    let win: TauriWindow | null = null;
    let unlistenFocus: (() => void) | undefined;
    const finished = new Set<string>();

    const apply = async () => {
      if (!win) return;
      try {
        if (finished.size === 0) {
          await win.setOverlayIcon(undefined);
        } else {
          const icon = await renderBadge(finished.size);
          if (icon) await win.setOverlayIcon(icon);
        }
      } catch (err) {
        console.warn('[TOKENICODE] failed to update taskbar badge:', err);
      }
      try {
        await updateTray(finished.size);
      } catch (err) {
        console.warn('[TOKENICODE] failed to update tray badge:', err);
      }
    };

    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      win = getCurrentWindow();
      unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (focused && finished.size > 0) {
          finished.clear();
          void apply();
        }
      });
      if (disposed) unlistenFocus();
    });

    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.runningSessions === prev.runningSessions) return;
      const removed = finishedSessionIds(prev.runningSessions, state.runningSessions);
      if (removed.length === 0 || !win) return;
      void win.isFocused().then((focused) => {
        if (focused) return;
        removed.forEach((id) => finished.add(id));
        void apply();
      });
    });

    return () => {
      disposed = true;
      unsubscribe();
      unlistenFocus?.();
    };
  }, []);
}
