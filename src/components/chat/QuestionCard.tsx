import { useState, useCallback } from 'react';
import { type ChatMessage, useChatStore, getActiveTabState } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { buildAskUserQuestionAnswers } from '../../lib/ask-user-question';

/** Decode literal Unicode escape sequences (e.g. `—`) that appear in text. */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** 选项文字末尾的“(Recommended)”/“（推荐）”拆出来，改为显示“推荐”角标 */
function splitRecommended(label: string): { text: string; recommended: boolean } {
  const match = label.match(/\s*[(（]\s*(recommended|推荐)\s*[)）]\s*$/i);
  if (!match) return { text: label, recommended: false };
  return { text: label.slice(0, match.index).trimEnd(), recommended: true };
}

/** 已回答摘要里去掉选项文字中的推荐标记（回答可能是多个选项用逗号连接） */
function stripRecommended(answer: string): string {
  return answer.replace(/\s*[(（]\s*(recommended|推荐)\s*[)）]/gi, '');
}

/** 选项左侧的指示器：单选为圆点，多选为方框打勾 */
function OptionIndicator({ multi, checked }: { multi: boolean; checked: boolean }) {
  if (multi) {
    return (
      <span className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-[5px] border-[1.5px] flex items-center justify-center transition-colors
        ${checked ? 'bg-accent border-accent text-text-inverse' : 'border-text-tertiary/50'}`}>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.2l2.4 2.4 4.6-4.9" />
          </svg>
        )}
      </span>
    );
  }
  return (
    <span className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-[1.5px] flex items-center justify-center transition-colors
      ${checked ? 'border-accent' : 'border-text-tertiary/50'}`}>
      {checked && <span className="w-2 h-2 rounded-full bg-accent" />}
    </span>
  );
}

interface Props {
  message: ChatMessage;
  /** When true, card renders in floating overlay mode (no left margin). */
  floating?: boolean;
}

/**
 * QuestionCard — AskUserQuestion 的交互卡片。
 * 卡片头（标题 + 进度）、问题与单选/多选提示、带指示器的选项列表、“其他”自定义输入、底部操作按钮。
 * 已回答的问题在卡片内以列表形式保留。
 */
export function QuestionCard({ message, floating }: Props) {
  const t = useT();
  const questions = message.questions || [];
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedMap, setSelectedMap] = useState<Record<number, Set<number>>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [useOther, setUseOther] = useState<Record<number, boolean>>({});
  const [answeredMap, setAnsweredMap] = useState<Record<number, string>>({});

  const currentQ = questions[currentIdx];
  const isFullyResolved = message.resolved;

  const handleToggle = useCallback((optIdx: number, multi: boolean) => {
    if (isFullyResolved) return;
    const qIdx = currentIdx;
    setSelectedMap((prev) => {
      const current = prev[qIdx] || new Set<number>();
      const next = new Set(current);
      if (multi) {
        if (next.has(optIdx)) next.delete(optIdx);
        else next.add(optIdx);
      } else {
        next.clear();
        next.add(optIdx);
      }
      setUseOther((p) => ({ ...p, [qIdx]: false }));
      return { ...prev, [qIdx]: next };
    });
  }, [isFullyResolved, currentIdx]);

  const handleOtherToggle = useCallback(() => {
    if (isFullyResolved) return;
    const qIdx = currentIdx;
    setUseOther((prev) => {
      const next = !prev[qIdx];
      if (next) {
        setSelectedMap((p) => ({ ...p, [qIdx]: new Set<number>() }));
      }
      return { ...prev, [qIdx]: next };
    });
  }, [isFullyResolved, currentIdx]);

  const getCurrentAnswer = useCallback((): string => {
    const qIdx = currentIdx;
    const q = questions[qIdx];
    if (!q) return '';
    if (useOther[qIdx] && otherText[qIdx]?.trim()) {
      return otherText[qIdx].trim();
    }
    const selected = selectedMap[qIdx] || new Set<number>();
    return Array.from(selected)
      .map((i) => q.options[i]?.label)
      .filter(Boolean)
      .join(', ');
  }, [currentIdx, questions, selectedMap, useOther, otherText]);

  const hasCurrentSelection = useOther[currentIdx]
    ? !!otherText[currentIdx]?.trim()
    : (selectedMap[currentIdx]?.size || 0) > 0;

  const interactionState = message.interactionState ?? (isFullyResolved ? 'resolved' : 'pending');
  const isSending = interactionState === 'sending';
  const isFailed = interactionState === 'failed';
  const awaitingSdkPatch = !isFullyResolved && !message.permissionData?.requestId;

  const handleConfirm = useCallback(async () => {
    if (isFullyResolved || isSending || awaitingSdkPatch) return;
    const answerText = getCurrentAnswer();
    setAnsweredMap((prev) => ({ ...prev, [currentIdx]: answerText }));

    const isLast = currentIdx >= questions.length - 1;
    if (isLast) {
      const qTabId = useSessionStore.getState().selectedSessionId;
      if (!qTabId) return;
      const { setInteractionState, setSessionStatus, setActivityStatus } = useChatStore.getState();
      const stdinId = getActiveTabState().sessionMeta.stdinId;
      if (!stdinId) return;
      const answers = buildAskUserQuestionAnswers(questions, selectedMap, otherText, useOther);
      setInteractionState(qTabId, message.id, 'sending');
      try {
        const permData = message.permissionData;
        if (!permData?.requestId) throw new Error('AskUserQuestion request is not ready');
        const updatedInput = { ...message.toolInput, answers };
        await bridge.respondPermission(stdinId, permData.requestId, true, undefined, permData.toolUseId, updatedInput);
        setInteractionState(qTabId, message.id, 'resolved');
        setSessionStatus(qTabId, 'running');
        setActivityStatus(qTabId, { phase: 'thinking' });
      } catch (err) {
        setInteractionState(qTabId, message.id, 'failed', String(err));
      }
    } else {
      setCurrentIdx(currentIdx + 1);
    }
  }, [isFullyResolved, isSending, awaitingSdkPatch, currentIdx, questions, selectedMap, useOther, otherText, message.id, message.permissionData, message.toolInput, getCurrentAnswer]);

  // 上一步：回到前一个问题，之前的选择与自定义文字都保留，只撤销它的“已回答”记录
  const handleBack = useCallback(() => {
    if (isFullyResolved || isSending || currentIdx === 0) return;
    const prevIdx = currentIdx - 1;
    setAnsweredMap((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (Number(key) >= prevIdx) delete next[Number(key)];
      }
      return next;
    });
    setCurrentIdx(prevIdx);
  }, [isFullyResolved, isSending, currentIdx]);

  const handleSkip = useCallback(async () => {
    if (isFullyResolved || isSending || awaitingSdkPatch) return;
    const skipTabId = useSessionStore.getState().selectedSessionId;
    if (!skipTabId) return;
    const { setInteractionState, setSessionStatus, setActivityStatus } = useChatStore.getState();
    const stdinId = getActiveTabState().sessionMeta.stdinId;
    if (!stdinId) return;
    setInteractionState(skipTabId, message.id, 'sending');
    try {
      const permData = message.permissionData;
      if (!permData?.requestId) throw new Error('AskUserQuestion request is not ready');
      const updatedInput = { ...message.toolInput, answers: {} };
      await bridge.respondPermission(stdinId, permData.requestId, true, undefined, permData.toolUseId, updatedInput);
      setInteractionState(skipTabId, message.id, 'resolved');
      setSessionStatus(skipTabId, 'running');
      setActivityStatus(skipTabId, { phase: 'thinking' });
    } catch (err) {
      setInteractionState(skipTabId, message.id, 'failed', String(err));
    }
  }, [isFullyResolved, isSending, awaitingSdkPatch, message.id]);

  // 已完成的卡片：一行“已响应”，有本地记录的回答时逐条列出
  if (isFullyResolved) {
    const answered = Object.entries(answeredMap);
    return (
      <div className={`${floating ? '' : 'ml-11'} max-w-[50rem] animate-scale-in`}>
        <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-success">
              <path d="M2.5 6l2.5 2.5 4.5-4.5" />
            </svg>
            {t('msg.responded')}
          </div>
          {answered.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {answered.map(([idxStr, answer]) => {
                const q = questions[Number(idxStr)];
                if (!q) return null;
                return (
                  <div key={idxStr} className="text-xs text-text-muted">
                    <span className="text-text-secondary">{decodeUnicodeEscapes(q.question)}</span>
                    <span className="mx-1.5 text-text-tertiary">{'→'}</span>
                    <span className="text-text-primary font-medium">{stripRecommended(decodeUnicodeEscapes(answer))}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!currentQ) return null;
  const multi = !!currentQ.multiSelect;
  const isLast = currentIdx >= questions.length - 1;

  return (
    <div className={`${floating ? '' : 'ml-11'} max-w-[50rem] animate-scale-in`}>
      {/* 悬浮在消息区上方时限制高度，选项很多时在卡片内滚动 */}
      <div className={`rounded-2xl border border-accent/25 bg-bg-card shadow-[0_4px_18px_-6px_rgba(0,0,0,0.12)]
        ${floating ? 'max-h-[65vh] overflow-y-auto' : 'overflow-hidden'}`}>

        {/* 卡片头：标题 + 问题分类 + 进度 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-accent/[0.04]">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" className="text-accent flex-shrink-0">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.6" />
            <path d="M8 11.4h.01" />
          </svg>
          <span className="text-xs font-semibold text-text-primary">{t('msg.questionTitle')}</span>
          {currentQ.header && (
            <span className="px-1.5 py-px rounded-md bg-accent/10 text-accent text-[10px] font-medium">
              {decodeUnicodeEscapes(currentQ.header)}
            </span>
          )}
          {questions.length > 1 && (
            <div className="ml-auto flex items-center gap-2">
              <div className="flex gap-1">
                {questions.map((_, i) => (
                  <span key={i} className={`h-1.5 rounded-full transition-all duration-300
                    ${i < currentIdx ? 'w-1.5 bg-success' : i === currentIdx ? 'w-4 bg-accent' : 'w-1.5 bg-border'}`} />
                ))}
              </div>
              <span className="text-[11px] text-text-tertiary tabular-nums">
                {currentIdx + 1} / {questions.length}
              </span>
            </div>
          )}
        </div>

        <div className="px-4 pt-3.5 pb-3">
          {/* 已回答的问题 */}
          {Object.keys(answeredMap).length > 0 && (
            <div className="mb-3 space-y-1">
              {Object.entries(answeredMap).map(([idxStr, answer]) => {
                const q = questions[Number(idxStr)];
                if (!q) return null;
                return (
                  <div key={idxStr} className="flex items-start gap-1.5 text-xs text-text-muted">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
                      className="text-success mt-0.5 flex-shrink-0">
                      <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                    </svg>
                    <span className="min-w-0">
                      <span className="text-text-secondary">{decodeUnicodeEscapes(q.question)}</span>
                      <span className="mx-1.5 text-text-tertiary">{'→'}</span>
                      <span className="text-text-primary font-medium">{stripRecommended(decodeUnicodeEscapes(answer))}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* 问题 */}
          <div className="text-[13px] font-semibold text-text-primary leading-relaxed">
            {decodeUnicodeEscapes(currentQ.question)}
          </div>
          <div className="mt-0.5 mb-3 text-[11px] text-text-tertiary">
            {multi ? t('msg.questionMultiHint') : t('msg.questionSingleHint')}
          </div>

          {/* 选项 */}
          <div className="flex flex-col gap-2">
            {currentQ.options.map((opt, optIdx) => {
              const isSelected = selectedMap[currentIdx]?.has(optIdx) || false;
              const { text, recommended } = splitRecommended(decodeUnicodeEscapes(opt.label));
              return (
                <button
                  key={optIdx}
                  onClick={() => handleToggle(optIdx, multi)}
                  className={`w-full flex items-start gap-2.5 text-left px-3 py-2.5 rounded-xl border cursor-pointer
                    transition-colors duration-150
                    ${isSelected
                      ? 'border-accent/70 bg-accent/[0.07]'
                      : 'border-border-subtle hover:border-accent/35 hover:bg-bg-secondary/60'
                    }`}
                >
                  <OptionIndicator multi={multi} checked={isSelected} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[13px] font-medium ${isSelected ? 'text-accent' : 'text-text-primary'}`}>{text}</span>
                      {recommended && (
                        <span className="px-1.5 py-px rounded-md bg-success/12 text-success text-[10px] font-medium">
                          {t('msg.questionRecommended')}
                        </span>
                      )}
                    </span>
                    {opt.description && (
                      <span className="block mt-0.5 text-xs text-text-tertiary leading-relaxed">
                        {decodeUnicodeEscapes(opt.description)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}

            {/* 其他：自定义回答 */}
            <div className={`rounded-xl border transition-colors duration-150
              ${useOther[currentIdx] ? 'border-accent/70 bg-accent/[0.07]' : 'border-dashed border-border hover:border-accent/35'}`}>
              <button
                onClick={handleOtherToggle}
                className="w-full flex items-center gap-2.5 text-left px-3 py-2.5 cursor-pointer"
              >
                <OptionIndicator multi={false} checked={!!useOther[currentIdx]} />
                <span className={`text-[13px] ${useOther[currentIdx] ? 'text-accent font-medium' : 'text-text-secondary'}`}>
                  {t('msg.questionOther')}
                </span>
              </button>
              {useOther[currentIdx] && (
                <div className="px-3 pb-2.5 pl-[2.375rem]">
                  <input
                    type="text"
                    value={otherText[currentIdx] || ''}
                    onChange={(e) => setOtherText((p) => ({ ...p, [currentIdx]: e.target.value }))}
                    placeholder={t('msg.questionOtherPlaceholder')}
                    autoFocus
                    className="w-full px-3 py-1.5 rounded-lg text-[13px]
                      bg-bg-card border border-border-subtle
                      focus:border-accent/60 outline-none text-text-primary
                      placeholder:text-text-tertiary transition-smooth"
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (hasCurrentSelection) handleConfirm();
                      }
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* 错误提示 */}
          {isFailed && message.interactionError && (
            <div className="mt-3 text-[11px] text-error bg-error/5 rounded-lg px-2.5 py-1.5 border border-error/20">
              {message.interactionError}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border-subtle bg-bg-secondary/30">
          {currentIdx > 0 && (
            <button
              onClick={handleBack}
              disabled={isSending}
              className="mr-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
                text-text-secondary hover:text-text-primary hover:bg-bg-tertiary
                transition-smooth cursor-pointer
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 2.5L4 6l3.5 3.5" />
              </svg>
              {t('msg.questionBack')}
            </button>
          )}
          <button
            onClick={handleSkip}
            disabled={isSending || awaitingSdkPatch}
            className="px-3 py-1.5 rounded-lg text-xs font-medium
              text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary
              transition-smooth cursor-pointer
              disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {t('msg.questionSkip')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!hasCurrentSelection || isSending || awaitingSdkPatch}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold
              bg-accent text-text-inverse hover:bg-accent-hover
              transition-smooth cursor-pointer shadow-sm
              disabled:opacity-35 disabled:cursor-not-allowed
              ${isSending ? 'animate-pulse-soft' : ''}`}
          >
            {isSending
              ? t('msg.questionSending')
              : awaitingSdkPatch
                ? t('msg.questionLoading')
                : isLast ? t('msg.questionSubmit') : t('msg.questionNext')}
          </button>
        </div>
      </div>
    </div>
  );
}
