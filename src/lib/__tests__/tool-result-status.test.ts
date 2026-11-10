import { describe, expect, it } from 'vitest';
import { classifyToolResult } from '../tool-result-status';

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

describe('classifyToolResult', () => {
  it('没有 is_error 就是成功，即使内容像拒绝文案', () => {
    expect(classifyToolResult(undefined, REJECTED)).toBeUndefined();
    expect(classifyToolResult(false, 'Exit code 1')).toBeUndefined();
  });
  it('回合被中断：拒绝文案后带“stopped while running”的更正', () => {
    expect(classifyToolResult(true, `${REJECTED} Correction to the text above: this call was stopped while running, not refused before it ran.`)).toBe('interrupted');
  });
  it('权限被拒：只有拒绝文案', () => {
    expect(classifyToolResult(true, REJECTED)).toBe('rejected');
  });
  it('其他出错（非零退出码、工具报错）', () => {
    expect(classifyToolResult(true, 'Exit code 1\nboom')).toBe('failed');
    expect(classifyToolResult(true, '<tool_use_error>File does not exist.</tool_use_error>')).toBe('failed');
  });
});
