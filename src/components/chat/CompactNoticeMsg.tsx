// 上下文压缩提示：压缩前后 token 数、压缩后保留的文件、可展开的压缩摘要。
import { useState } from 'react';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { isLocalSessionFile, toSessionFilePath } from '../../lib/remote';
import type { CompactNoticeData } from '../../lib/compact-notice';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import type { MessageProps } from './messageShared';

export function CompactNoticeMsg({ message }: MessageProps) {
  const t = useT();
  const data = (message.commandData ?? {}) as CompactNoticeData;
  const [showSummary, setShowSummary] = useState(false);
  const files = data.files ?? [];

  const title = t(data.trigger === 'manual' ? 'compact.noticeManual' : 'compact.noticeAuto');
  const tokens = typeof data.preTokens === 'number' && typeof data.postTokens === 'number'
    ? t('compact.tokens')
      .replace('{pre}', data.preTokens.toLocaleString())
      .replace('{post}', data.postTokens.toLocaleString())
    : typeof data.preTokens === 'number'
      ? t('compact.tokensPre').replace('{pre}', data.preTokens.toLocaleString())
      : '';

  const openFile = (e: React.MouseEvent, path: string) => {
    if ((e.ctrlKey || e.metaKey) && useSettingsStore.getState().ctrlClickOpenExternally && isLocalSessionFile(path)) {
      bridge.openWithDefaultApp(path);
    } else {
      useFileStore.getState().selectFile(toSessionFilePath(path));
    }
  };

  return (
    <div className="my-2 animate-fade-in">
      {/* 分隔线 + 标题：压缩之前的内容模型已经看不到原文了 */}
      <div className="flex items-center gap-3 text-[12px] text-text-muted">
        <div className="flex-1 border-t border-dashed border-border-subtle" />
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
            <path d="M4 2v4h8V2M4 14v-4h8v4M2 8h12" />
          </svg>
          <span className="font-medium text-text-secondary">{title}</span>
          {tokens && <span>{tokens}</span>}
        </span>
        <div className="flex-1 border-t border-dashed border-border-subtle" />
      </div>

      {(files.length > 0 || data.summary) && (
        <div className="mt-2 mx-auto max-w-xl rounded-lg border border-border-subtle bg-bg-card px-3 py-2 shadow-sm">
          {files.length > 0 && (
            <>
              <div className="text-[11px] text-text-muted mb-1.5">{t('compact.files')}</div>
              <div className="flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={(e) => openFile(e, f.path)}
                    title={`${f.path}\n${t(f.full ? 'compact.fileFull' : 'compact.fileRef')}`}
                    className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md
                      border border-border-subtle bg-bg-secondary text-[11px] text-text-primary
                      hover:text-accent hover:border-accent/40 transition-smooth"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                      ${f.full ? 'bg-accent' : 'bg-text-tertiary/50'}`} />
                    <span className="truncate font-mono">{f.display}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {data.summary && (
            <div className={files.length > 0 ? 'mt-2' : ''}>
              <button
                onClick={() => setShowSummary((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary transition-smooth"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`transition-transform ${showSummary ? 'rotate-90' : ''}`}>
                  <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t(showSummary ? 'compact.hideSummary' : 'compact.showSummary')}
              </button>
              {showSummary && (
                <div className="mt-1.5 max-h-80 overflow-y-auto text-[12px] text-text-secondary leading-relaxed">
                  <MarkdownRenderer content={data.summary} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
