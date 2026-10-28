import { describe, expect, it } from 'vitest';
import { describeTool } from '../activity-label';

describe('describeTool', () => {
  it('文件类工具显示文件名', () => {
    expect(describeTool('Read', { file_path: 'F:\\AI\\mywork\\ClaudeDock\\src\\lib\\turns.ts' }))
      .toEqual({ verbKey: 'activity.read', target: 'turns.ts', code: false });
    expect(describeTool('Edit', { file_path: 'src/stores/chatStore.ts' }).target).toBe('chatStore.ts');
    expect(describeTool('Write', { file_path: '/tmp/a/b.md' }).verbKey).toBe('activity.write');
  });

  it('命令优先显示说明，没有说明时显示命令并截断', () => {
    expect(describeTool('Bash', { command: 'pnpm vitest run', description: '运行全部测试' }))
      .toEqual({ verbKey: 'activity.run', target: '运行全部测试', code: false });
    const long = describeTool('PowerShell', { command: 'Get-ChildItem -Recurse -Filter *.ts | Where-Object { $_.Length -gt 1000 } | Select-Object FullName' });
    expect(long.code).toBe(true);
    expect(long.target.length).toBeLessThanOrEqual(48);
    expect(long.target.endsWith('…')).toBe(true);
  });

  it('搜索、网页、子代理', () => {
    expect(describeTool('Grep', { pattern: 'isBareFileMissing' }).target).toBe('isBareFileMissing');
    expect(describeTool('WebFetch', { url: 'https://glama.ai/mcp/servers/x' }).target).toBe('glama.ai');
    expect(describeTool('Agent', { description: '查找会话列表代码' }).target).toBe('查找会话列表代码');
  });

  it('MCP 工具只显示工具部分，未知工具显示原名，缺参数不报错', () => {
    expect(describeTool('mcp__codebase-memory-mcp__search_code', {}).target).toBe('search_code');
    expect(describeTool('SomethingNew', undefined)).toEqual({ verbKey: 'activity.call', target: 'SomethingNew', code: true });
    expect(describeTool('Read', null).target).toBe('');
  });
});
