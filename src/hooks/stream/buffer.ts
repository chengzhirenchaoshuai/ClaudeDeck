// 流式文本缓冲：按 stdinId 合并高频的 text/thinking 增量，再批量写入 chatStore。
import { useChatStore, generateMessageId, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';

// --- Streaming text buffer (rAF-throttled + interval fallback, per-stdinId) ---
// Coalesces rapid text_delta / thinking_delta events into a single state update
// per animation frame (~60/s), preventing JS main thread starvation from
// excessive React re-renders when the message list is large.
//
// CRITICAL: rAF alone is unreliable — heavy React re-renders can block the
// rendering pipeline, preventing rAF callbacks from firing. A 200ms setInterval
// fallback ensures buffered text is always flushed even when rAF is starved.
//
// TK-329 fix: each session gets its own buffer to prevent cross-contamination
// when multiple sessions stream concurrently.
interface _StreamBuffer {
  text: string;
  thinking: string;
  raf: number;
}
const _streamBuffers = new Map<string, _StreamBuffer>();

// Interval fallback: flush any stuck buffers every 200ms
let _flushIntervalId: ReturnType<typeof setInterval> | null = null;

function _ensureFlushInterval() {
  if (_flushIntervalId) return;
  _flushIntervalId = setInterval(() => {
    for (const [stdinId, buf] of _streamBuffers) {
      if (buf.text || buf.thinking) {
        _doFlush(stdinId, buf);
      }
    }
    // Stop interval when no active buffers remain
    if (_streamBuffers.size === 0 && _flushIntervalId) {
      clearInterval(_flushIntervalId);
      _flushIntervalId = null;
    }
  }, 200);
}

function _getBuffer(stdinId: string): _StreamBuffer {
  let buf = _streamBuffers.get(stdinId);
  if (!buf) {
    buf = { text: '', thinking: '', raf: 0 };
    _streamBuffers.set(stdinId, buf);
  }
  return buf;
}

/** Core flush logic — shared by rAF callback and interval fallback. */
function _doFlush(stdinId: string, buf: _StreamBuffer) {
  if (!buf.text && !buf.thinking) return;

  const mappedId = useSessionStore.getState().getTabForStdin(stdinId);
  const tabId = mappedId || useSessionStore.getState().selectedSessionId || undefined;
  if (!mappedId && tabId) {
    console.warn('[stream-flush] stdinId mapping missing, fallback to selectedSessionId:', stdinId, '→', tabId);
    useSessionStore.getState().registerStdinTab(stdinId, tabId);
  }
  if (!tabId) {
    // No active tab to render into — the selectedSessionId is likely null
    // (e.g. app just launched, no tab selected yet). Log and discard buffered
    // text so stale data won't be flushed to the wrong tab later.
    console.warn('[stream-flush] no tabId for stdinId:', stdinId,
      'mappedId:', mappedId,
      'selectedSessionId:', useSessionStore.getState().selectedSessionId,
      'dropping text:', buf.text.slice(0, 80),
      'dropping thinking:', buf.thinking.slice(0, 80));
    buf.text = '';
    buf.thinking = '';
    return;
  }

  const store = useChatStore.getState();
  if (buf.text) {
    store.updatePartialMessage(tabId, buf.text);
    buf.text = '';
  }
  if (buf.thinking) {
    store.updatePartialThinking(tabId, buf.thinking);
    buf.thinking = '';
  }
}

function _scheduleStreamFlush(stdinId: string) {
  const buf = _getBuffer(stdinId);
  // Start the interval fallback on first buffer activity
  _ensureFlushInterval();
  if (buf.raf) return;
  buf.raf = requestAnimationFrame(() => {
    buf.raf = 0;
    _doFlush(stdinId, buf);
  });
}

/** 追加一段流式增量（正文或思考），并安排刷新 */
export function bufferStreamDelta(stdinId: string, kind: 'text' | 'thinking', delta: string) {
  _getBuffer(stdinId)[kind] += delta;
  _scheduleStreamFlush(stdinId);
}

/** Flush any buffered streaming text immediately (call before clearPartial).
 *  If stdinId is provided, flush only that session's buffer.
 *  If omitted, flush ALL buffers (backward compat). */
export function flushStreamBuffer(stdinId?: string) {
  const ids = stdinId ? [stdinId] : Array.from(_streamBuffers.keys());

  for (const id of ids) {
    const buf = _streamBuffers.get(id);
    if (!buf) continue;

    if (buf.raf) {
      cancelAnimationFrame(buf.raf);
      buf.raf = 0;
    }
    _doFlush(id, buf);
  }

  // Clean up buffers and stop interval when all cleared
  if (!stdinId) {
    _streamBuffers.clear();
  } else {
    _streamBuffers.delete(stdinId);
  }
  if (_streamBuffers.size === 0 && _flushIntervalId) {
    clearInterval(_flushIntervalId);
    _flushIntervalId = null;
  }
}

/** Preserve streamed text when a provider omits the final full assistant event. */
export function commitPartialText(tabId: string, stdinId?: string): boolean {
  flushStreamBuffer(stdinId);
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const content = tab?.partialText?.trim();
  if (!content) return false;

  const alreadyPresent = tab?.messages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && message.content.trim() === content,
  );
  if (!alreadyPresent) {
    store.addMessage(tabId, {
      id: generateMessageId(),
      role: 'assistant',
      type: 'text',
      content,
      timestamp: Date.now(),
    });
  }
  return true;
}

export function hasAssistantReplyForTurn(messages: ChatMessage[], turnStartTime: number): boolean {
  return messages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && !!message.content.trim()
      && message.timestamp >= turnStartTime,
  );
}
