// 自绘标题栏：主窗口关闭了系统标题栏（decorations: false），由这里提供拖动区域和窗口按钮。
// 背景透明，透出主题的应用背景或自定义壁纸，和界面融为一体。
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { disposableListen } from '../../lib/disposable-listen';

/** showTitle：侧栏收起时显示应用名（侧栏展开时左上角已有 Logo，不重复） */
export function TitleBar({ showTitle }: { showTitle: boolean }) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  // 最大化状态决定按钮图标；双击标题栏、Win+方向键等系统操作也会触发 resized
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => {
      win.isMaximized().then((m) => {
        setMaximized(m);
        // 最大化时窗口贴满屏幕，取消圆角（App.css 的 --window-radius）
        document.documentElement.toggleAttribute('data-maximized', m);
      }).catch(() => {});
    };
    sync();
    return disposableListen(win.onResized(sync));
  }, []);

  const win = () => getCurrentWindow();

  return (
    <div data-tauri-drag-region className="app-titlebar">
      {/* data-tauri-drag-region 只对元素本身生效，文字也要加，否则按在文字上拖不动 */}
      <span data-tauri-drag-region className="app-titlebar-title">
        {showTitle && (import.meta.env.DEV ? `${APP_NAME} Dev` : APP_NAME)}
      </span>
      <div className="app-titlebar-buttons">
        <button title={t('window.minimize')} onClick={() => win().minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button
          title={t(maximized ? 'window.restore' : 'window.maximize')}
          onClick={() => win().toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M2.5 2.5V0.5h7v7h-2" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        {/* 走 close()：触发 onCloseRequested，按设置最小化到托盘或退出 */}
        <button className="app-titlebar-close" title={t('window.close')} onClick={() => win().close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1">
            <path d="M0 0l10 10M10 0L0 10" />
          </svg>
        </button>
      </div>
    </div>
  );
}
