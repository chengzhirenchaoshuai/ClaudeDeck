// 导出为图片：选轮次范围，预览后复制到剪贴板或保存为 PNG，方便发给别人看问题和结论。
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { save } from '@tauri-apps/plugin-dialog';
import { useActiveTab, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { parseTurns } from '../../lib/turns';
import { APP_NAME } from '../../lib/edition';
import {
  EXPORT_WIDTH, blobToBase64, copyPngToClipboard, defaultExportFileName,
  renderNodeToPng, selectExportMessages,
} from '../../lib/export-image';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';
import { showToast } from '../shared/Toast';
import { ToolUseMsg } from './ToolMessages';
import { safeContent } from './messageShared';

/** 打开导出对话框的入口：记下从哪条用户消息（哪一轮）开始 */
export const useExportImageStore = create<{
  messageId: string | null;
  open: (messageId: string) => void;
  close: () => void;
}>((set) => ({
  messageId: null,
  open: (messageId) => set({ messageId }),
  close: () => set({ messageId: null }),
}));

export function ExportImageDialog() {
  const messageId = useExportImageStore((s) => s.messageId);
  if (!messageId) return null;
  return <ExportImageDialogInner messageId={messageId} />;
}

function ExportImageDialogInner({ messageId }: { messageId: string }) {
  const t = useT();
  const close = useExportImageStore((s) => s.close);
  const messages = useActiveTab((tab) => tab.messages);
  const turns = useMemo(() => parseTurns(messages), [messages]);
  const initial = Math.max(0, turns.findIndex((tn) => tn.userMessageId === messageId));
  const [startTurn, setStartTurn] = useState(initial);
  const [endTurn, setEndTurn] = useState(initial);
  const [includeTools, setIncludeTools] = useState(false);
  // 默认只导出结论：发给别人时一般只需要问题和最终答复
  const [conclusionOnly, setConclusionOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);

  // 文件名用会话显示名（没改名时是首条消息的前 120 个字，截断不加省略号）
  const title = useSessionStore((s) => {
    const session = s.sessions.find((x) => x.id === s.selectedSessionId);
    return session ? s.getDisplayName(session) : '';
  });
  // 图片顶部只放用户自己改过的会话名：首条消息截断后像半句话，和导出的这几轮也未必相关
  const headerTitle = useSessionStore((s) => (s.selectedSessionId ? s.customPreviews[s.selectedSessionId] || '' : ''));

  const selected = useMemo(
    () => selectExportMessages(messages, turns, startTurn, endTurn, { includeTools, conclusionOnly }),
    [messages, turns, startTurn, endTurn, includeTools, conclusionOnly],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  /** 生成 PNG；失败时提示原因并返回 null */
  const render = async (): Promise<Blob | null> => {
    const node = nodeRef.current;
    if (!node || selected.length === 0) return null;
    try {
      // 背景色取导出节点实际的背景，跟随当前主题
      return await renderNodeToPng(node, getComputedStyle(node).backgroundColor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg === 'too-tall' ? t('msg.exportImageTooTall') : t('msg.exportImageFailed').replace('{error}', msg), 'error');
      return null;
    }
  };

  const handleCopy = async () => {
    setBusy(true);
    try {
      const blob = await render();
      if (!blob) return;
      await copyPngToClipboard(blob);
      showToast(t('msg.exportImageCopied'), 'success');
      close();
    } catch (e) {
      showToast(t('msg.exportImageFailed').replace('{error}', String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      const blob = await render();
      if (!blob) return;
      const path = await save({
        defaultPath: defaultExportFileName(title),
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (!path) return;
      await bridge.writeFileBase64(path, await blobToBase64(blob));
      showToast(`${t('export.success')} ${path}`, 'success');
      close();
    } catch (e) {
      showToast(t('msg.exportImageFailed').replace('{error}', String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const turnOptions = turns.map((tn, i) => (
    <option key={tn.userMessageId} value={i}>
      {t('msg.exportImageTurn').replace('{n}', String(tn.index))}
      {' '}{tn.userContent.replace(/\s+/g, ' ').slice(0, 24)}
    </option>
  ));
  const selectCls = 'max-w-[220px] px-2 py-1 rounded-lg text-xs bg-bg-secondary border border-border-subtle text-text-primary outline-none';

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={close}>
      <div
        className="flex flex-col max-h-[90vh] max-w-[95vw] bg-bg-card border border-border-subtle rounded-xl shadow-lg animate-fade-in"
        style={{ width: EXPORT_WIDTH + 48 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 选项栏 */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border-subtle text-xs text-text-muted">
          <span className="text-sm font-semibold text-text-primary mr-2">{t('msg.exportImage')}</span>
          <select className={selectCls} value={startTurn}
            onChange={(e) => { const v = Number(e.target.value); setStartTurn(v); if (v > endTurn) setEndTurn(v); }}>
            {turnOptions}
          </select>
          <span>{t('msg.exportImageTo')}</span>
          <select className={selectCls} value={endTurn}
            onChange={(e) => { const v = Number(e.target.value); setEndTurn(v); if (v < startTurn) setStartTurn(v); }}>
            {turnOptions}
          </select>
          <label className="flex items-center gap-1.5 ml-2 cursor-pointer select-none"
            title={t('msg.exportImageConclusionOnlyHint')}>
            <input type="checkbox" checked={conclusionOnly} onChange={(e) => setConclusionOnly(e.target.checked)} />
            {t('msg.exportImageConclusionOnly')}
          </label>
          <label className={`flex items-center gap-1.5 select-none
            ${conclusionOnly ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input type="checkbox" checked={includeTools && !conclusionOnly} disabled={conclusionOnly}
              onChange={(e) => setIncludeTools(e.target.checked)} />
            {t('msg.exportImageIncludeTools')}
          </label>
        </div>

        {/* 预览：预览里的节点就是最终截图的节点 */}
        <div className="flex-1 min-h-0 overflow-auto p-6 bg-bg-secondary/50">
          {selected.length === 0 ? (
            <div className="py-16 text-center text-sm text-text-muted">{t('msg.exportImageEmpty')}</div>
          ) : (
            <div ref={nodeRef} className="bg-bg-primary rounded-xl px-6 py-5 shadow-md" style={{ width: EXPORT_WIDTH }}>
              {headerTitle && (
                <div className="mb-5 pb-3 border-b border-border-subtle text-sm font-semibold text-text-primary">
                  {headerTitle}
                </div>
              )}
              <ExportMessageList messages={selected} />
              <div className="mt-6 pt-3 border-t border-border-subtle flex justify-between text-[11px] text-text-tertiary">
                <span>{APP_NAME}</span>
                <span>{new Date().toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>

        {/* 操作 */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button onClick={close}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary text-text-muted hover:bg-bg-tertiary transition-smooth">
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={busy || selected.length === 0}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary text-text-primary hover:bg-bg-tertiary
              disabled:opacity-40 disabled:cursor-not-allowed transition-smooth">
            {t('msg.exportImageSave')}
          </button>
          <button onClick={handleCopy} disabled={busy || selected.length === 0}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent hover:bg-accent/20
              disabled:opacity-40 disabled:cursor-not-allowed transition-smooth">
            {busy ? t('msg.exportImageRendering') : t('msg.exportImageCopy')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 导出用的精简消息列表：用户消息不折叠、没有编辑按钮，助手回复同一轮只显示一次头像 */
function ExportMessageList({ messages }: { messages: ChatMessage[] }) {
  let lastRole: string | null = null;
  return (
    <div>
      {messages.map((msg, i) => {
        const showAvatar = msg.role === 'assistant' && msg.type !== 'tool_use' && lastRole !== 'assistant-text';
        const spacing = i === 0 ? '' : msg.type === 'tool_use' ? 'mt-1' : 'mt-4';
        if (msg.role === 'user') lastRole = 'user';
        else if (msg.type !== 'tool_use') lastRole = 'assistant-text';

        if (msg.role === 'user') {
          return (
            <div key={msg.id} className={`${spacing} flex justify-end gap-2.5`}>
              <div className="max-w-[80%] px-3.5 py-2 rounded-2xl rounded-br-md bg-bg-user-msg text-text-inverse
                text-sm leading-6 shadow-md whitespace-pre-wrap break-words">
                {safeContent(msg.content)}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {msg.attachments.map((att, j) => att.isImage && att.preview ? (
                      <img key={j} src={att.preview} alt="" className="max-h-40 rounded-lg" />
                    ) : (
                      <span key={j} className="px-2 py-1 rounded-lg bg-white/10 border border-white/15 text-xs">
                        📄 {att.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <UserAvatar size="w-9 h-9 text-sm" rounded="rounded-xl" />
            </div>
          );
        }

        if (msg.type === 'tool_use') {
          return <div key={msg.id} className={spacing}><ToolUseMsg message={msg} /></div>;
        }

        return (
          <div key={msg.id} className={`${spacing} flex gap-3`}>
            {showAvatar ? <AiAvatar size="w-9 h-9" rounded="rounded-xl" /> : <div className="w-9 flex-shrink-0" />}
            <div className="flex-1 min-w-0 text-[15px] text-text-primary leading-relaxed">
              <MarkdownRenderer content={safeContent(msg.content)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
