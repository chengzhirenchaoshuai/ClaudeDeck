// 工具调用结果的结束方式：工具卡片据此显示“已中断 / 已拒绝 / 失败”，而不是一律显示成功的对勾。
// 依据 tool_result 的 is_error 和 CLI 写入的固定文案（实时 stream-json 与磁盘 JSONL 相同）。

export type ToolResultError = 'interrupted' | 'rejected' | 'failed';

/** CLI 拒绝或中断工具调用时 tool_result 的开头（权限被拒、回合被中断都用这一段） */
const REJECTED_PREFIX = "The user doesn't want to proceed with this tool use";
/** 回合被中断时 CLI 在上面那段后补的更正说明 */
const INTERRUPTED_MARK = 'this call was stopped while running';

/** 没有出错（is_error 不为 true）时返回 undefined */
export function classifyToolResult(isError: boolean | undefined, text: string): ToolResultError | undefined {
  if (isError !== true) return undefined;
  if (text.startsWith(REJECTED_PREFIX)) return text.includes(INTERRUPTED_MARK) ? 'interrupted' : 'rejected';
  return 'failed';
}
