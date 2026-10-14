/**
 * CLI stream-json（stdout）消息的类型，只摘取前端用到的字段。
 *
 * 依据 @anthropic-ai/claude-agent-sdk 0.3.291 的 sdk.d.ts（SDKMessage）；另含：
 * - Rust 后端注入的 tokenicode_permission_request、process_exit；
 * - 旧版 CLI 的 tool_result / content_block_delta / human（SDK 已无，保留兼容）。
 *
 * 注意：实时流里的字段是蛇形命名（如 compact_metadata.pre_tokens），磁盘上的会话
 * JSONL 则是驼峰命名（compactMetadata.preTokens），两者不要混用。
 */
import type { TokenUsage } from './context-usage';

/** 所有消息共有的可选字段 */
interface StreamMessageBase {
  /** 前端监听器附加：消息来自哪个 CLI 进程 */
  __stdinId?: string;
  session_id?: string;
  /** 旧版字段名 */
  sessionId?: string;
  uuid?: string;
  /** 子代理产生的消息带有父 Task/Agent 的 tool_use id */
  parent_tool_use_id?: string | null;
}

/** 工具输入随工具而异（questions、todos、content、description……），不做细分 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolInput = Record<string, any>;

/** tool_result 的 content 为数组时的元素 */
export interface ToolResultPart {
  type?: string;
  text?: string;
  content?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id: string; name: string; input: ToolInput }
  | { type: 'tool_result'; tool_use_id: string; content?: string | ToolResultPart[]; is_error?: boolean }
  | { type: 'image'; source?: unknown };

/** Anthropic 流式事件（BetaRawMessageStreamEvent）中用到的部分 */
export type StreamEvent =
  | { type: 'message_start'; message?: { usage?: TokenUsage } }
  | { type: 'message_delta'; usage?: TokenUsage }
  | { type: 'message_stop' }
  | { type: 'content_block_start'; index?: number; content_block?: { type: string; id?: string; name?: string } }
  | {
      type: 'content_block_delta';
      index?: number;
      delta?:
        | { type: 'text_delta'; text?: string }
        | { type: 'thinking_delta'; thinking?: string }
        | { type: 'input_json_delta'; partial_json?: string }
        | { type: 'signature_delta'; signature?: string };
    }
  | { type: 'content_block_stop'; index?: number };

/** Rust 拦截 can_use_tool 控制请求后转发的权限请求 */
export interface PermissionRequestMessage extends StreamMessageBase {
  type: 'tokenicode_permission_request';
  request_id: string;
  tool_name: string;
  input: ToolInput;
  description?: string;
  tool_use_id?: string;
}

/** Rust 在 CLI 进程退出后发出 */
export interface ProcessExitMessage extends StreamMessageBase {
  type: 'process_exit';
}

export interface StreamEventMessage extends StreamMessageBase {
  type: 'stream_event';
  event?: StreamEvent;
}

/** 压缩边界（SDKCompactBoundaryMessage.compact_metadata） */
export interface CompactMetadata {
  trigger?: 'manual' | 'auto';
  pre_tokens?: number;
  post_tokens?: number;
}

/**
 * system 消息：init / compact_boundary / thinking_tokens / status / api_retry 等。
 * 子类型很多且会随 CLI 增加，这里不细分成联合类型，各字段按子类型可选。
 */
export interface SystemMessage extends StreamMessageBase {
  type: 'system';
  subtype: string;
  /** init */
  model?: string;
  /** compact_boundary */
  compact_metadata?: CompactMetadata;
  /** thinking_tokens */
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  /** error（旧版 CLI） */
  message?: string;
  error?: string;
  /** background_tasks_changed：当前全部存活的后台任务（CLI v2.1.203+） */
  tasks?: BackgroundTaskEntry[];
}

/** background_tasks_changed 中的一项（SDKBackgroundTasksChangedMessage.tasks） */
export interface BackgroundTaskEntry {
  task_id: string;
  run_id?: string;
  /** local_bash（后台 Bash / Monitor）、local_agent（子代理）、remote_agent */
  task_type: string;
  subagent_type?: string;
  description: string;
  parent_task_id?: string;
  /** CLI 自身运行所需的任务，不算用户的工作，不应计入活动指示 */
  ambient?: boolean;
}

export interface AssistantMessage extends StreamMessageBase {
  type: 'assistant';
  message?: { content?: ContentBlock[]; usage?: TokenUsage };
  error?: string;
}

/** 工具执行结果的结构化数据（SDK 中为 unknown，这里列出用到的形状） */
export type ToolUseResult =
  | string
  | { stdout?: string; content?: string | ToolResultPart[] | { text?: string } }
  | null;

export interface UserMessage extends StreamMessageBase {
  /** human 为旧版 CLI 的写法 */
  type: 'user' | 'human';
  message?: { content?: string | ContentBlock[] };
  tool_use_result?: ToolUseResult;
  isSynthetic?: boolean;
}

export interface ResultMessage extends StreamMessageBase {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  is_error?: boolean;
  /** 仅 success 有 */
  result?: string;
  /** 仅错误子类型有 */
  errors?: string[];
  usage?: TokenUsage;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  /** 旧版 CLI 的错误字段 */
  error?: string;
  content?: string;
}

/** 旧版 CLI 的顶层 tool_result */
export interface LegacyToolResultMessage extends StreamMessageBase {
  type: 'tool_result';
  tool_use_id?: string;
  tool_name?: string;
  content?: string | ToolResultPart[];
  output?: string;
}

/** 旧版 CLI 未包在 stream_event 里的文本增量 */
export interface LegacyContentBlockDeltaMessage extends StreamMessageBase {
  type: 'content_block_delta';
  delta?: { text?: string };
}

/** 已知但前端不处理的消息 */
export interface IgnoredMessage extends StreamMessageBase {
  type: 'tool_use_summary';
}

/** rate_limit_event.rate_limit_info：utilization 为 0~1 小数，resetsAt 为 Unix 秒 */
export interface RateLimitInfo {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

/** Pro/Max 账户的 5h/7d 用量 */
export interface RateLimitEventMessage extends StreamMessageBase {
  type: 'rate_limit_event';
  rate_limit_info?: RateLimitInfo;
}

export type StreamMessage =
  | PermissionRequestMessage
  | ProcessExitMessage
  | StreamEventMessage
  | SystemMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | LegacyToolResultMessage
  | LegacyContentBlockDeltaMessage
  | RateLimitEventMessage
  | IgnoredMessage;

/** 把 tool_result 的 content（字符串或片段数组）拼成文本 */
export function toolResultText(content: string | ToolResultPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : ''))
    .join('');
}
