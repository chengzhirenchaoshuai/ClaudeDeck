// 工具调用相关的消息：工具调用行（Edit/Write/Read 等带差异统计与文件图标）和工具结果。
import { memo, useState } from 'react';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { isLocalSessionFile, toSessionFilePath } from '../../lib/remote';
import { safeContent, type MessageProps } from './messageShared';

/* ================================================================
   ToolUseMsg — inline collapsible, no card
   Enhanced display for Edit/Write/Read with diff stats, file icons
   ================================================================ */

/** Compute line diff stats from Edit tool input (common prefix/suffix algorithm) */
function computeEditDiff(input: any): { added: number; removed: number } | null {
  if (!input?.old_string || !input?.new_string) return null;
  const oldLines: string[] = input.old_string.split('\n');
  const newLines: string[] = input.new_string.split('\n');

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length
         && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from remaining after prefix)
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen
         && suffixLen < newLines.length - prefixLen
         && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  return {
    added: Math.max(0, newLines.length - prefixLen - suffixLen),
    removed: Math.max(0, oldLines.length - prefixLen - suffixLen),
  };
}

/** Compute lines for Write tool input */
function computeWriteLines(input: any): number | null {
  if (!input?.content) return null;
  return input.content.split('\n').length;
}

/** Get short filename from path */
function shortPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || filePath;
}

/** Tool icon mini SVG */
function ToolIcon({ name }: { name: string }) {
  switch (name) {
    case 'Bash':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <rect x="1" y="2" width="10" height="8" rx="1.5" />
          <path d="M3.5 5.5L5 7l-1.5 1.5M6.5 8.5h2" />
        </svg>
      );
    case 'Read':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3M4 6.5h4M4 8.5h2" />
        </svg>
      );
    case 'Write':
      return (
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3" />
          <path d="M5 7l1.5-1.5L8 7M6.5 5.5v4" strokeLinecap="round" />
        </svg>
      );
    case 'Edit':
      return (
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M8.5 1.5l2 2-6.5 6.5H2V8L8.5 1.5z" />
          <path d="M7 3l2 2" />
        </svg>
      );
    case 'Glob':
    case 'Grep':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="5.5" cy="5.5" r="3" />
          <path d="M8 8l2.5 2.5" />
        </svg>
      );
    case 'Task':
    case 'Agent':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5v5M3.5 6h5" />
        </svg>
      );
    case 'WebFetch':
    case 'WebSearch':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M1.5 6h9M6 1.5c-1.5 1.5-2 3-2 4.5s.5 3 2 4.5M6 1.5c1.5 1.5 2 3 2 4.5s-.5 3-2 4.5" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
          <path d="M4.5 5l1.5 1.5L7.5 5" />
        </svg>
      );
  }
}

function getToolLabel(name: string, t: (key: string) => string): string {
  switch (name) {
    case 'Bash': return t('msg.terminal');
    case 'Read': return t('msg.readFile');
    case 'Write': return t('msg.writeFile');
    case 'Edit': return t('msg.editFile');
    case 'Glob': case 'Grep': return t('msg.search');
    case 'Task': case 'Agent': return t('msg.subAgent');
    case 'TodoWrite': return t('msg.todo');
    case 'WebFetch': case 'WebSearch': return t('msg.webFetch');
    case 'ExitPlanMode': case 'EnterPlanMode': return t('msg.planLabel');
    default: return name;
  }
}

export const ToolUseMsg = memo(function ToolUseMsg({ message }: MessageProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'Tool';
  const label = getToolLabel(toolName, t);
  const input = message.toolInput;
  const isFileEdit = toolName === 'Edit' || toolName === 'Write';

  // Compute diff stats for Edit tool
  const editDiff = toolName === 'Edit' ? computeEditDiff(input) : null;
  // Compute line count for Write tool
  const writeLines = toolName === 'Write' ? computeWriteLines(input) : null;

  // Build preview content based on tool type
  const renderPreview = () => {
    if (toolName === 'Bash' && input?.command) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0
          font-mono bg-bg-secondary/60 px-1.5 py-0.5 rounded"
          title={input.command}>
          {input.command}
        </span>
      );
    }

    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && input?.file_path) {
      return (
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if ((e.ctrlKey || e.metaKey) && useSettingsStore.getState().ctrlClickOpenExternally && isLocalSessionFile(input.file_path)) {
                bridge.openWithDefaultApp(input.file_path);
              } else {
                useFileStore.getState().selectFile(toSessionFilePath(input.file_path));
              }
            }}
            onContextMenu={(e) => {
              if ((e.ctrlKey || e.metaKey) && isLocalSessionFile(input.file_path)) {
                e.preventDefault();
                e.stopPropagation();
                bridge.revealInFinder(input.file_path);
              }
            }}
            className={`text-accent/70 hover:text-accent font-mono
              truncate min-w-0 hover:underline cursor-pointer transition-smooth
              ${isFileEdit ? 'text-[12px]' : 'text-[11px]'}`}
            title={input.file_path}
          >
            {shortPath(input.file_path)}
          </button>
          {/* Diff stats for Edit */}
          {editDiff && (
            <span className="inline-flex items-center gap-1 ml-0.5 flex-shrink-0">
              <span className="text-[11px] font-mono text-success">+{editDiff.added}</span>
              <span className="text-[11px] font-mono text-error">-{editDiff.removed}</span>
            </span>
          )}
          {/* Line count for Write */}
          {writeLines !== null && (
            <span className="text-[11px] font-mono text-success ml-0.5 flex-shrink-0 whitespace-nowrap">
              +{writeLines} lines
            </span>
          )}
        </span>
      );
    }

    if ((toolName === 'Glob' || toolName === 'Grep') && input?.pattern) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0
          font-mono" title={input.pattern}>
          {input.pattern}
        </span>
      );
    }

    if ((toolName === 'Task' || toolName === 'Agent') && input?.description) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0 italic">
          {input.description}
        </span>
      );
    }

    if (toolName === 'TeamCreate' && (input?.team_name || input?.name)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0 italic">
          Team: {input.team_name || input.name}
        </span>
      );
    }

    if (toolName === 'TaskCreate' && (input?.subject || input?.description)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0 italic">
          {input.subject || input.description}
        </span>
      );
    }

    if (toolName === 'SendMessage' && input?.recipient) {
      return (
        <span className="text-[11px] text-text-tertiary truncate min-w-0 italic">
          &rarr; {input.recipient}
        </span>
      );
    }

    if ((toolName === 'WebFetch' || toolName === 'WebSearch') && (input?.url || input?.query)) {
      const display = input.url || input.query;
      return (
        <span className="text-[11px] text-accent/70 truncate min-w-0 font-mono">
          {display}
        </span>
      );
    }

    return null;
  };

  // Determine if input has meaningful content (not empty {} or null)
  const hasInput = input && typeof input === 'object'
    ? Object.keys(input).length > 0
    : !!input;

  // Whether there's a result to show
  const resultContent = typeof message.toolResultContent === 'string'
    ? message.toolResultContent
    : message.toolResultContent ? JSON.stringify(message.toolResultContent) : '';
  const hasResult = resultContent.length > 0;

  // Render the expanded detail section
  /** Render a side-by-side diff view for Edit tool old_string → new_string */
  const renderEditDiff = () => {
    if (!input?.old_string && !input?.new_string) return null;
    const oldLines = (input.old_string || '').split('\n');
    const newLines = (input.new_string || '').split('\n');

    return (
      <div key="diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {/* Removed lines */}
        {oldLines.length > 0 && oldLines[0] !== '' && (
          <div>
            {oldLines.map((line: string, i: number) => (
              <div key={`old-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-red-500/8 dark:bg-red-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-red-400/60
                  select-none border-r border-red-500/10">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-red-400 select-none">−</span>
                <span className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* Added lines */}
        {newLines.length > 0 && newLines[0] !== '' && (
          <div>
            {newLines.map((line: string, i: number) => (
              <div key={`new-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-blue-500/8 dark:bg-blue-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-blue-400/60
                  select-none border-r border-blue-500/10">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-blue-400 select-none">+</span>
                <span className="text-blue-600 dark:text-blue-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* File path */}
        {input.file_path && (
          <div className="px-2 py-1 border-t border-border-subtle/50
            text-[10px] text-text-tertiary font-mono truncate">
            {input.file_path}
          </div>
        )}
      </div>
    );
  };

  /** Render a Write tool diff — all lines shown as additions (blue) */
  const renderWriteDiff = () => {
    if (!input?.content) return null;
    const allLines = input.content.split('\n');
    const maxDisplay = 20;
    const displayLines = allLines.slice(0, maxDisplay);
    const remaining = allLines.length - maxDisplay;

    return (
      <div key="write-diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {displayLines.map((line: string, i: number) => (
          <div key={i}
            className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
              bg-blue-500/8 dark:bg-blue-500/10">
            <span className="flex-shrink-0 w-8 text-right pr-2 text-blue-400/60
              select-none border-r border-blue-500/10">
              {i + 1}
            </span>
            <span className="flex-shrink-0 w-5 text-center text-blue-400 select-none">+</span>
            <span className="text-blue-600 dark:text-blue-400 whitespace-pre-wrap break-all
              flex-1 px-1">{line}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className="px-2 py-1 text-[10px] text-text-tertiary font-mono
            bg-blue-500/5 border-t border-blue-500/10">
            ... +{remaining} more lines
          </div>
        )}
        {input.file_path && (
          <div className="px-2 py-1 border-t border-border-subtle/50
            text-[10px] text-text-tertiary font-mono truncate">
            {input.file_path}
          </div>
        )}
      </div>
    );
  };

  const renderExpandedContent = () => {
    const sections: React.ReactNode[] = [];

    // Show tool input (if meaningful)
    if (hasInput) {
      if (toolName === 'Bash' && input?.command) {
        sections.push(
          <div key="cmd" className="flex items-start gap-1.5">
            <span className="text-text-tertiary/60 text-[11px] font-mono select-none">$</span>
            <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all">
              {input.command}
            </pre>
          </div>
        );
      } else if (toolName === 'Edit' && (input?.old_string || input?.new_string)) {
        const diffView = renderEditDiff();
        if (diffView) sections.push(diffView);
      } else if (toolName === 'Write' && input?.content) {
        const writeDiffView = renderWriteDiff();
        if (writeDiffView) sections.push(writeDiffView);
      } else {
        sections.push(
          <pre key="input" className="text-[11px] text-text-tertiary
            overflow-x-auto font-mono leading-relaxed
            max-h-32 overflow-y-auto whitespace-pre-wrap">
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        );
      }
    }

    // Show result content
    if (hasResult) {
      if (hasInput) {
        // Divider between input and result
        sections.push(
          <div key="divider" className="border-t border-border-subtle/50 my-1" />
        );
      }
      sections.push(
        <pre key="result" className="text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-96 overflow-y-auto whitespace-pre-wrap">
          {resultContent}
        </pre>
      );
    }

    return sections.length > 0 ? sections : null;
  };

  // Determine if expand makes sense
  const canExpand = hasInput || hasResult;
  const depth = message.subAgentDepth ?? 0;

  return (
    <div className={depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11'}>
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 py-1 text-left group w-full min-w-0
          ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {canExpand ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className={`flex-shrink-0 text-text-tertiary transition-transform
              duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <path d="M3 2l4 3-4 3" />
          </svg>
        ) : (
          <span className="w-[10px] flex-shrink-0" />
        )}
        <ToolIcon name={toolName} />
        <span className={`font-medium text-text-muted flex-shrink-0 whitespace-nowrap ${isFileEdit ? 'text-[13px]' : 'text-xs'}`}>{label}</span>
        {renderPreview()}
        {/* Show a small result indicator when collapsed with result */}
        {!expanded && hasResult && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0 ml-0.5">
            <path d="M2.5 6l2.5 2.5 4.5-4.5" />
          </svg>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5">
          {renderExpandedContent()}
        </div>
      )}
    </div>
  );
});

/* ================================================================
   ToolResultMsg — inline result
   ================================================================ */
export function ToolResultMsg({ message }: MessageProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const content = safeContent(message.content);
  const depth = message.subAgentDepth ?? 0;

  // Show a short one-line preview on the same line as the "Result" label
  const preview = content.length > 0
    ? content.split('\n')[0]
    : '';

  return (
    <div className={depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11'}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-0.5 cursor-pointer group w-full min-w-0 text-left"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0">
          <path d="M2.5 6l2.5 2.5 4.5-4.5" />
        </svg>
        <span className="text-[11px] text-text-tertiary flex-shrink-0">{t('msg.result')}</span>
        {!expanded && preview && (
          <span className="text-[11px] text-text-tertiary/60 font-mono truncate min-w-0">
            {preview}
          </span>
        )}
      </button>
      {expanded && content && (
        <pre className="ml-5 mt-0.5 text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-96 overflow-y-auto whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}
