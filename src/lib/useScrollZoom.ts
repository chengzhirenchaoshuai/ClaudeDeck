/**
 * Scroll zoom hook — Ctrl/Cmd + mouse wheel scales the chat area only.
 * Ported from vscode-cc-enhance/webview/enhance.js (setupZoom, lines 599-631).
 *
 * Targets the chat scroll container (.chat-scroll-container) instead of
 * document.body so the sidebar, settings panel, etc. remain at normal scale.
 * Uses CSS zoom (not transform: scale) so layout reflows correctly.
 * Works on WebView2 (Windows) and WKWebView (macOS).
 */

import { useEffect, useRef } from 'react';

const STORAGE_KEY = 'tokenicode-zoom';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;
const INDICATOR_DURATION_MS = 800;
const TARGET_SELECTOR = '.chat-scroll-container';

/**
 * @param selector - CSS selector for the element to zoom. Defaults to
 *   `.chat-scroll-container` (the chat messages area).
 */
export function useScrollZoom(selector: string = TARGET_SELECTOR) {
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const getTarget = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(selector);

    // Restore persisted zoom level
    let zoom = parseFloat(localStorage.getItem(STORAGE_KEY) || '1.0');
    if (isNaN(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) zoom = 1.0;
    const el = getTarget();
    if (el) el.style.zoom = String(zoom);

    /** Show a transient indicator overlay with the current zoom percentage */
    const showIndicator = (z: number) => {
      if (!indicatorRef.current) {
        const div = document.createElement('div');
        div.id = 'tokenicode-zoom-indicator';
        div.style.cssText = [
          'position: fixed; top: 20px; right: 20px; z-index: 99999;',
          'background: rgba(40, 40, 40, 0.95); color: #fff;',
          'padding: 8px 16px; border-radius: 8px; font-size: 14px;',
          'pointer-events: none; transition: opacity 0.3s;',
          'font-family: system-ui, sans-serif;',
        ].join(' ');
        document.body.appendChild(div);
        indicatorRef.current = div;
      }
      indicatorRef.current.textContent =
        `缩放: ${Math.round(z * 100)}%`;
      indicatorRef.current.style.opacity = '1';

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (indicatorRef.current) indicatorRef.current.style.opacity = '0';
      }, INDICATOR_DURATION_MS);
    };

    /** Ctrl/Cmd + wheel handler */
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      // Don't intercept wheel events inside input/textarea/editor
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      // 自己处理滚轮的浮层（如大图查看器）里不缩放聊天区
      if (target?.closest?.('[data-own-wheel]')) return;

      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
      const t = getTarget();
      if (t) t.style.zoom = String(zoom);
      localStorage.setItem(STORAGE_KEY, zoom.toString());
      showIndicator(zoom);
    };

    document.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      document.removeEventListener('wheel', handleWheel);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (indicatorRef.current) {
        indicatorRef.current.remove();
        indicatorRef.current = null;
      }
    };
  }, [selector]);
}
