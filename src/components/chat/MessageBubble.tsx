import { memo, useState } from 'react';
import { useT } from '../../lib/i18n';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { CommandProcessingCard } from './CommandProcessingCard';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { AiAvatar } from '../shared/AiAvatar';
import { safeContent, type MessageProps } from './messageShared';
import { ToolUseMsg, ToolResultMsg } from './ToolMessages';
import { CommandFeedbackMsg } from './CommandFeedbackMsg';
import { CompactNoticeMsg } from './CompactNoticeMsg';
import { UserMsg } from './UserMessage';

export const MessageBubble = memo(function MessageBubble({ message, isFirstInGroup = true }: MessageProps) {
  if (message.role === 'user') return <UserMsg message={message} />;
  if (message.role === 'system' && message.commandType === 'processing') return <CommandProcessingCard message={message} />;
  if (message.role === 'system' && message.commandType === 'compact') return <CompactNoticeMsg message={message} />;
  if (message.role === 'system' && message.commandType) return <CommandFeedbackMsg message={message} />;
  // Unresolved question/plan_review cards are rendered as floating overlays
  // above the InputBar. Only show them inline once resolved.
  if (message.type === 'question' && !message.resolved) return null;
  if (message.type === 'question') return <QuestionCard message={message} />;
  if (message.type === 'todo') return <TodoMsg message={message} />;
  if (message.type === 'plan_review' && !message.resolved) return null;
  if (message.type === 'plan_review') return <PlanReviewCard message={message} />;
  if (message.type === 'tool_use') return <ToolUseMsg message={message} />;
  if (message.type === 'thinking') return <ThinkingMsg message={message} />;
  if (message.type === 'tool_result') return <ToolResultMsg message={message} />;
  // Unresolved permission cards are rendered as floating overlays above InputBar
  if (message.type === 'permission' && !message.resolved && message.interactionState !== 'resolved') return null;
  if (message.type === 'permission') return <PermissionCard message={message} />;
  if (message.type === 'plan') return <PlanMsg message={message} />;
  return <AssistantMsg message={message} isFirstInGroup={isFirstInGroup} />;
});

/* ================================================================
   AssistantMsg — markdown with avatar (uses shared MarkdownRenderer)
   ================================================================ */
function AssistantMsg({ message, isFirstInGroup = true }: MessageProps) {
  return (
    <div className="flex gap-3">
      {/* Avatar: show only for the first message in a consecutive group */}
      {isFirstInGroup ? (
        <AiAvatar size="w-10 h-10" rounded="rounded-xl" />
      ) : (
        <div className="w-10 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
        <MarkdownRenderer content={safeContent(message.content)} />
      </div>
    </div>
  );
}

/* ================================================================
   ThinkingMsg — minimal collapsible
   ================================================================ */
function ThinkingMsg({ message }: MessageProps) {
  const t = useT();
  return (
    <div className="ml-13">
      <details open className="group">
        <summary className="flex items-center gap-1.5 py-1
          cursor-pointer text-[11px] text-text-tertiary list-none select-none">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="transition-transform duration-150 group-open:rotate-90">
            <path d="M3 2l4 3-4 3" />
          </svg>
          {t('msg.thought')}
        </summary>
        <pre className="ml-5 mt-0.5 text-[11px] text-text-tertiary
          whitespace-pre-wrap max-h-48 overflow-y-auto
          font-mono leading-relaxed">
          {safeContent(message.content)}
        </pre>
      </details>
    </div>
  );
}

/* PermissionMsg — extracted to PermissionCard.tsx */

/* ================================================================
   PlanMsg — inline collapsible list (no card)
   ================================================================ */
function PlanMsg({ message }: MessageProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = message.planItems || (typeof message.content === 'string' ? message.content.split('\n').filter(Boolean) : []);

  return (
    <div className="ml-13">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-medium text-text-muted">
          {t('msg.planTitle')}
        </span>
        <span className="text-[11px] text-text-tertiary">
          ({items.length} {t('msg.planSteps')})
        </span>
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5 space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-text-muted">
              <span className="flex-shrink-0 text-text-tertiary font-mono w-4 text-right">
                {i + 1}.
              </span>
              <span className="leading-relaxed">
                {item.replace(/^[\d]+\.\s*/, '').replace(/^[-•]\s*/, '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   TodoMsg — tree-style with indent connector lines (Claude Code style)
   ================================================================ */
function TodoMsg({ message }: MessageProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = Array.isArray(message.todoItems) ? message.todoItems : [];
  const completedCount = items.filter((i) => i.status === 'completed').length;
  const inProgressItem = items.find((i) => i.status === 'in_progress');

  return (
    <div className="ml-13">
      {/* Header — collapsible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer text-left"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-bold text-text-primary">{t('msg.todo')}</span>
        <span className="text-[10px] text-text-tertiary">
          {completedCount}/{items.length}
        </span>
        {inProgressItem && (
          <span className="text-[10px] text-accent italic ml-1 truncate max-w-[200px]">
            {inProgressItem.activeForm || inProgressItem.content}
          </span>
        )}
      </button>
      {/* Tree-style checklist with connector lines */}
      {expanded && (
        <div className="ml-[7px] mt-0.5">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <div key={i} className="flex items-stretch">
                {/* Connector line column */}
                <div className="flex flex-col items-center w-4 flex-shrink-0">
                  {/* Horizontal branch + vertical trunk */}
                  <div className="flex items-center h-5">
                    <div className={`w-px h-full ${isLast ? 'h-1/2 self-start' : ''}`}
                      style={{
                        background: 'var(--color-border)',
                        height: isLast ? '50%' : '100%',
                        alignSelf: isLast ? 'flex-start' : undefined,
                      }}
                    />
                    <div className="w-2 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                  {/* Continuing trunk below (hidden for last item) */}
                  {!isLast && (
                    <div className="w-px flex-1" style={{ background: 'var(--color-border)' }} />
                  )}
                </div>
                {/* Status icon + text */}
                <div className="flex items-center gap-1.5 py-0.5 min-h-[20px]">
                  {item.status === 'completed' ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="var(--color-success)" fillOpacity="0.15"
                        stroke="var(--color-success)" strokeWidth="1" />
                      <path d="M3 6l2 2 4-4" stroke="var(--color-success)"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  ) : item.status === 'in_progress' ? (
                    <span className="w-[11px] h-[11px] flex items-center justify-center flex-shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full border-2 border-accent
                        bg-accent/20 animate-pulse-soft" />
                    </span>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1"
                        strokeOpacity="0.4" />
                    </svg>
                  )}
                  <span className={`text-[11px] leading-tight
                    ${item.status === 'completed'
                      ? 'text-text-tertiary line-through'
                      : item.status === 'in_progress'
                        ? 'text-text-primary font-medium'
                        : 'text-text-muted'
                    }`}>
                    {item.content}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* PlanReviewMsg — extracted to PlanReviewCard.tsx */

/* QuestionMsg — extracted to QuestionCard.tsx */
