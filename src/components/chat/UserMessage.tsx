// 用户消息气泡：长消息折叠、行内文件路径可点击、附件、回溯入口。
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useLightboxStore } from '../shared/ImageLightbox';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { useRewind } from '../../hooks/useRewind';
import { isLocalSessionFile, toSessionFilePath } from '../../lib/remote';
import { parseInlineFilePath, resolveSessionPath } from '../../lib/file-path-link';
import { UserAvatar } from '../shared/UserAvatar';
import { safeContent, type MessageProps } from './messageShared';

/* ================================================================
   UserMsg — bubble on the right
   ================================================================ */
/** Collapse threshold: messages longer than this are collapsed by default */
const USER_MSG_COLLAPSE_LINES = 12;

/** Extract file extension from a filename */
function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Render a single backtick-inner segment: file path → clickable chip, else → inline code */
function renderCodeSegment(inner: string, key: number): ReactNode {
  const filePath = parseInlineFilePath(inner);
  if (filePath) {
    const resolved = resolveSessionPath(filePath.path, useSettingsStore.getState().workingDirectory || '');
    const fileName = (filePath.path.split(/[\\/]/).pop() || filePath.path)
      + (filePath.line ? `:${filePath.line}` : '');
    return (
      <button
        key={key}
        onClick={(e) => {
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && useSettingsStore.getState().ctrlClickOpenExternally && isLocalSessionFile(resolved)) {
            bridge.openWithDefaultApp(resolved);
          } else {
            useFileStore.getState().selectFile(resolved);
          }
        }}
        onContextMenu={(e) => {
          if ((e.ctrlKey || e.metaKey) && isLocalSessionFile(resolved)) {
            e.preventDefault();
            bridge.revealInFinder(resolved);
          }
        }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5
          bg-white/15 border border-white/25 rounded-md
          text-xs font-medium cursor-pointer
          hover:bg-white/25 hover:border-white/40
          transition-all duration-150 select-none
          align-baseline leading-normal whitespace-nowrap inline-block"
        title={resolved}
        data-copy-text={inner}
      >
        <span className="text-[10px]">📄</span>
        <span className="max-w-[180px] truncate">{fileName}</span>
      </button>
    );
  }
  return (
    <code key={key} className="px-1.5 py-0.5 mx-0.5 rounded-md text-[13px]
      bg-white/15 border border-white/20 font-mono">
      {inner}
    </code>
  );
}

/** Parse backtick-wrapped segments in user text into styled inline code elements.
 *  Handles both single ` and triple ``` (renders as single-line code).
 *  File paths inside backticks become clickable chips. */
function renderUserContent(text: string): ReactNode {
  // Split on backtick patterns: ```...``` or `...`
  const parts = text.split(/(```[^`]*```|`[^`\n]+`)/g);
  if (parts.length === 1) return text; // no backticks found, return plain string

  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3).trim();
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      const inner = part.slice(1, -1);
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    return part;
  });
}

export function UserMsg({ message }: MessageProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { turns, executeRewind } = useRewind();
  const attachments = message.attachments;
  const content = safeContent(message.content);
  const lines = content.split('\n');
  const isLong = lines.length > USER_MSG_COLLAPSE_LINES || content.length > 600;
  const displayContent = (!expanded && isLong)
    ? lines.slice(0, USER_MSG_COLLAPSE_LINES).join('\n')
    : content;

  // 只有这条消息还能定位到对应的回退点（即它确实是某一轮的起始用户消息）才能编辑。
  // 会话运行中也允许编辑——confirmEdit 复用的 executeRewind 本来就会先杀掉当前
  // 进程再回退，所以"编辑一条已发出、正在处理中的消息"直接等价于"打断 + 改内容重发"，
  // 不需要等它跑完，这正是打错字不小心发出去时最需要的场景。
  const turn = turns.find((tn) => tn.userMessageId === message.id);
  const canEdit = !!turn;

  const startEdit = useCallback(() => {
    if (!canEdit) return;
    setEditText(content);
    setIsEditing(true);
  }, [canEdit, content]);

  useEffect(() => {
    if (!isEditing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isEditing]);

  const cancelEdit = useCallback(() => setIsEditing(false), []);

  const confirmEdit = useCallback(() => {
    const text = editText.trim();
    if (!text || !turn) return;
    setIsEditing(false);
    // 复用回退到这条消息之前的逻辑（撤销之后的对话，代码改动保留），
    // 只是把回填到输入框的文字换成编辑后的版本，而不是原文。
    void executeRewind(turn, 'restore_conversation', text);
  }, [editText, turn, executeRewind]);

  if (isEditing) {
    return (
      <div className="flex justify-end gap-2.5 group/user relative">
        <div className="max-w-[75%] w-full px-3.5 py-2.5 rounded-2xl rounded-br-md
          bg-bg-user-msg text-text-inverse shadow-md">
          <textarea
            ref={editRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                confirmEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              }
            }}
            rows={Math.min(12, Math.max(2, editText.split('\n').length))}
            className="w-full bg-transparent text-sm leading-relaxed resize-none
              outline-none placeholder:text-white/50"
          />
          <div className="flex justify-end gap-1.5 mt-1.5">
            <button
              onClick={cancelEdit}
              className="px-2.5 py-1 rounded-lg text-xs text-white/70
                hover:text-white hover:bg-white/10 transition-smooth"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmEdit}
              disabled={!editText.trim()}
              className="px-2.5 py-1 rounded-lg text-xs font-medium
                bg-white/20 hover:bg-white/30 disabled:opacity-40
                disabled:cursor-not-allowed transition-smooth"
            >
              {t('msg.resend')}
            </button>
          </div>
        </div>
        <UserAvatar size="w-8 h-8 text-xs" className="mt-0.5" />
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-2.5 group/user relative">
      {canEdit && (
        <button
          onClick={startEdit}
          title={t('msg.edit')}
          className="flex-shrink-0 self-center p-1.5 rounded-lg text-text-tertiary
            opacity-0 group-hover/user:opacity-100 hover:text-accent hover:bg-bg-secondary
            transition-smooth"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 2l3 3-8 8-3.5 1L3 10.5 11 2z" />
          </svg>
        </button>
      )}
      <div className="max-w-[75%] px-3.5 py-2.5 rounded-2xl rounded-br-md
        bg-bg-user-msg text-text-inverse
        text-sm leading-relaxed shadow-md whitespace-pre-wrap">
        {renderUserContent(displayContent)}
        {!expanded && isLong && (
          <span className="text-white/60">…</span>
        )}
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="block mt-1.5 text-xs text-white/60 hover:text-white/90
              transition-smooth"
          >
            {expanded ? '▲ 收起' : '▼ 展开全部'}
          </button>
        )}
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {attachments.map((att, i) => (
              <button
                key={i}
                onClick={(e) => {
                  if ((e.ctrlKey || e.metaKey) && useSettingsStore.getState().ctrlClickOpenExternally && isLocalSessionFile(att.path)) {
                    bridge.openWithDefaultApp(att.path);
                  } else if (att.isImage) {
                    // 远程项目里附件在远端：转成 ssh:// 路径读取
                    useLightboxStore.getState().openFile(toSessionFilePath(att.path), att.name);
                  } else {
                    useFileStore.getState().selectFile(toSessionFilePath(att.path));
                  }
                }}
                onContextMenu={(e) => {
                  if ((e.ctrlKey || e.metaKey) && isLocalSessionFile(att.path)) {
                    e.preventDefault();
                    bridge.revealInFinder(att.path);
                  }
                }}
                className="inline-flex items-center gap-2 px-2.5 py-1.5
                  bg-white/10 hover:bg-white/20 rounded-lg border border-white/15
                  transition-smooth cursor-pointer text-left"
              >
                {att.isImage && att.preview ? (
                  <img src={att.preview} alt="" className="w-8 h-8 rounded object-cover" />
                ) : (
                  <span className="flex items-center justify-center w-8 h-8 rounded
                    bg-white/10 text-[10px] font-mono font-semibold uppercase opacity-80">
                    {getFileExt(att.name) || (
                      <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
                        stroke="currentColor" strokeWidth="1.2">
                        <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
                        <path d="M7 1v3h3" />
                      </svg>
                    )}
                  </span>
                )}
                <span className="text-xs truncate max-w-[180px]">{att.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <UserAvatar size="w-8 h-8 text-xs" className="mt-0.5" />
    </div>
  );
}
