import { useEffect, useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { bridge, isRemotePath } from '../../lib/tauri-bridge';

/* ================================================================
   Lightbox store — global state for the image lightbox overlay
   ================================================================ */

interface LightboxState {
  isOpen: boolean;
  /** Data URL or file path to display */
  imageSrc: string | null;
  /** Original file path (for "open externally" action) */
  filePath: string | null;
  /** Optional alt text */
  alt: string;

  open: (src: string, filePath?: string, alt?: string) => void;
  /** Open by loading a file from disk via Rust base64 */
  openFile: (path: string, alt?: string) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>()((set) => ({
  isOpen: false,
  imageSrc: null,
  filePath: null,
  alt: '',

  open: (src, filePath, alt) =>
    set({ isOpen: true, imageSrc: src, filePath: filePath || null, alt: alt || '' }),

  openFile: async (path, alt) => {
    set({ isOpen: true, imageSrc: null, filePath: path, alt: alt || '' });
    try {
      const dataUrl = await bridge.readFileBase64(path);
      set({ imageSrc: dataUrl });
    } catch {
      set({ isOpen: false, imageSrc: null });
    }
  },

  close: () =>
    set({ isOpen: false, imageSrc: null, filePath: null, alt: '' }),
}));

/* ================================================================
   ImageLightbox component — fullscreen overlay
   ================================================================ */

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
/** 每格滚轮的缩放倍率 */
const WHEEL_FACTOR = 1.15;

interface View { scale: number; x: number; y: number }
const INITIAL_VIEW: View = { scale: 1, x: 0, y: 0 };

/**
 * 以屏幕上的点 (px, py) 为中心把缩放调到 nextScale：保持该点下的图片内容不动。
 * 图片居中显示、以自身中心为变换原点，所以以视口中心为坐标原点计算。
 */
function zoomAt(view: View, nextScale: number, px: number, py: number): View {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  const cx = px - window.innerWidth / 2;
  const cy = py - window.innerHeight / 2;
  const k = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

export function ImageLightbox() {
  const isOpen = useLightboxStore((s) => s.isOpen);
  const imageSrc = useLightboxStore((s) => s.imageSrc);
  const filePath = useLightboxStore((s) => s.filePath);
  const alt = useLightboxStore((s) => s.alt);
  const close = useLightboxStore((s) => s.close);

  const overlayRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);
  // 拖动时记录起点；拖动过就不把随后的 click 当成“点背景关闭”
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // 换图或关闭时还原缩放
  useEffect(() => { setView(INITIAL_VIEW); }, [imageSrc, isOpen]);

  // ESC 关闭；+ / - 缩放，0 还原
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    if (e.key === '+' || e.key === '=') setView((v) => zoomAt(v, v.scale * WHEEL_FACTOR, cx, cy));
    if (e.key === '-') setView((v) => zoomAt(v, v.scale / WHEEL_FACTOR, cx, cy));
    if (e.key === '0') setView(INITIAL_VIEW);
  }, [close]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  // 滚轮缩放（带不带 Ctrl 都行）。必须用非 passive 监听才能 preventDefault，
  // 否则滚轮会穿透浮层滚动后面的聊天记录
  useEffect(() => {
    const el = overlayRef.current;
    if (!isOpen || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!imageSrc) return;
      const factor = e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
      setView((v) => zoomAt(v, v.scale * factor, e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isOpen, imageSrc]);

  // 拖动平移：按下后在 window 上跟踪，鼠标移出图片也不中断
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.viewX + dx, y: d.viewY + dy }));
    };
    const onUp = () => {
      suppressClickRef.current = !!dragRef.current?.moved;
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  if (!isOpen) return null;

  const zoomed = view.scale !== 1 || view.x !== 0 || view.y !== 0;

  return (
    <div
      ref={overlayRef}
      data-own-wheel
      className="fixed inset-0 z-[99999] flex items-center justify-center overflow-hidden
        bg-black/80 backdrop-blur-sm animate-fade-in cursor-zoom-out"
      onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        close();
      }}
    >
      {/* Close button */}
      <button
        onClick={close}
        className="absolute top-4 right-4 p-2 rounded-full
          bg-white/10 hover:bg-white/20 text-white
          transition-smooth z-10"
      >
        <svg width="20" height="20" viewBox="0 0 14 14" fill="none"
          stroke="currentColor" strokeWidth="2">
          <path d="M4 4l6 6M10 4l-6 6" />
        </svg>
      </button>

      {/* Open externally button：远程图片在远端，本机程序打不开 */}
      {filePath && !isRemotePath(filePath) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            bridge.openWithDefaultApp(filePath);
          }}
          className="absolute top-4 left-4 px-3 py-1.5 rounded-lg
            bg-white/10 hover:bg-white/20 text-white text-xs font-medium
            transition-smooth z-10"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="inline mr-1.5">
            <path d="M5 1H2a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V7" />
            <path d="M7 1h4v4M11 1L5.5 6.5" />
          </svg>
          Open
        </button>
      )}

      {/* Image */}
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={alt}
          className={`max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl select-none
            ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: dragging ? 'none' : 'transform 80ms ease-out',
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragRef.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: false };
            setDragging(true);
          }}
          // 双击：已缩放则还原，否则在双击处放大到 2 倍
          onDoubleClick={(e) => {
            e.stopPropagation();
            const { clientX, clientY } = e;
            setView((v) => (zoomed ? INITIAL_VIEW : zoomAt(v, 2, clientX, clientY)));
          }}
          draggable={false}
        />
      ) : (
        /* Loading spinner */
        <div className="flex items-center justify-center">
          <svg className="animate-spin-slow" width="32" height="32"
            viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>
      )}

      {/* 当前缩放比例；点击还原 */}
      {imageSrc && (
        <button
          onClick={(e) => { e.stopPropagation(); setView(INITIAL_VIEW); }}
          className="absolute bottom-6 left-6 px-2.5 py-1 rounded-lg z-10
            bg-black/60 hover:bg-black/75 text-white/80 text-xs tabular-nums transition-smooth"
        >
          {Math.round(view.scale * 100)}%
        </button>
      )}

      {/* Alt text caption */}
      {alt && imageSrc && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2
          px-4 py-2 rounded-lg bg-black/60 text-white/80 text-xs
          max-w-[80vw] truncate">
          {alt}
        </div>
      )}
    </div>
  );
}
