/**
 * 会话消息里文件链接的右键菜单：预览、复制路径、下载到本机、定位等。
 * 助手消息（MarkdownRenderer）和用户消息（UserMessage）共用；
 * 菜单状态放在一个小 store 里，由 App 挂载唯一的 FileLinkMenuHost 渲染，
 * 这样纯函数渲染的链接（UserMessage 里的 renderCodeSegment）也能打开菜单。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { bridge } from '../../lib/tauri-bridge';
import { isLocalSessionFile, remoteNativePath } from '../../lib/remote';
import { saveFileAsWithDialog } from '../../lib/file-transfer';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { showToast } from './Toast';

interface MenuState {
  x: number;
  y: number;
  /** 已解析的路径：本机绝对路径，或远程的 ssh://主机/... */
  path: string;
}

const useFileLinkMenuStore = create<{ menu: MenuState | null; set: (m: MenuState | null) => void }>((set) => ({
  menu: null,
  set: (menu) => set({ menu }),
}));

/**
 * 文件链接的 onContextMenu 处理：Ctrl+右键保持原行为（本机文件在资源管理器中定位），
 * 普通右键弹出菜单。
 */
export function handleFileLinkContextMenu(e: React.MouseEvent, path: string) {
  e.preventDefault();
  e.stopPropagation();
  if ((e.ctrlKey || e.metaKey) && isLocalSessionFile(path)) {
    bridge.revealInFinder(path).catch((err) => showToast(String(err), 'error'));
    return;
  }
  useFileLinkMenuStore.getState().set({ x: e.clientX, y: e.clientY, path });
}

type Item = { label: string; icon: React.ReactNode; action: () => void } | 'separator';

const ICON = { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function FileLinkMenuHost() {
  const t = useT();
  const menu = useFileLinkMenuStore((s) => s.menu);
  const close = () => useFileLinkMenuStore.getState().set(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // 打开时按菜单实际尺寸把位置收进窗口内
  useEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8));
    setPos({ x, y });
  }, [menu]);

  // 点外部、按 Esc、滚动或窗口失焦时关闭
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  const { path } = menu;
  const local = isLocalSessionFile(path);
  const run = (fn: () => unknown) => () => { close(); void fn(); };

  const items: Item[] = [
    {
      label: t('files.preview'),
      icon: <svg {...ICON}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>,
      action: run(() => useFileStore.getState().selectFile(path)),
    },
    {
      label: t('files.copyPath'),
      icon: <svg {...ICON}><path d="M5 2H2v12h8v-3" /><path d="M6 6h8v8H6V6z" /></svg>,
      action: run(() => navigator.clipboard.writeText(remoteNativePath(path))
        .then(() => showToast(t('files.pathCopied'), 'success'))),
    },
    {
      label: local ? t('files.saveAs') : t('files.downloadTo'),
      icon: <svg {...ICON}><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5" /><path d="M2.5 11v1.5A1.5 1.5 0 004 14h8a1.5 1.5 0 001.5-1.5V11" /></svg>,
      action: run(() => saveFileAsWithDialog(path)),
    },
    'separator',
    ...(local ? [
      {
        label: t('files.revealInFinder'),
        icon: <svg {...ICON}><path d="M2 4h4l2 2h6v7H2V4z" /></svg>,
        action: run(() => bridge.revealInFinder(path).catch((err) => showToast(String(err), 'error'))),
      },
      {
        label: t('files.openDefault'),
        icon: <svg {...ICON}><path d="M12 9v4H4V5h4" /><path d="M8 8l6-6M10 2h4v4" /></svg>,
        action: run(() => bridge.openWithDefaultApp(path).catch((err) => showToast(String(err), 'error'))),
      },
    ] : [
      {
        label: t('files.revealInTree'),
        icon: <svg {...ICON}><path d="M2 4h4l2 2h6v7H2V4z" /></svg>,
        action: run(() => {
          if (!useFileStore.getState().revealInTree(path)) {
            showToast(t('files.notInTree'), 'error');
            return;
          }
          useSettingsStore.getState().setSecondaryTab('files');
        }),
      },
    ]),
  ];

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[180px] py-1 rounded-xl border border-border-subtle
        bg-bg-card shadow-lg animate-fade-in whitespace-nowrap"
      style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 border-t border-border-subtle" />
        ) : (
          <button
            key={i}
            onClick={item.action}
            className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-primary
              hover:bg-bg-secondary transition-smooth text-left cursor-pointer"
          >
            <span className="flex-shrink-0 text-text-tertiary">{item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
