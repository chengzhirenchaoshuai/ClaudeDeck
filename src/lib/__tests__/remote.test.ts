import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import { isLocalSessionFile } from '../remote';

describe('isLocalSessionFile', () => {
  it('本机项目里的文件可以交给本机程序', () => {
    useSettingsStore.setState({ workingDirectory: 'F:/AI/proj' });
    expect(isLocalSessionFile('C:\\x\\a.ts')).toBe(true);
    expect(isLocalSessionFile('F:/AI/proj/a.ts')).toBe(true);
  });

  it('远程项目里的文件不能交给本机程序：远端绝对路径和 ssh:// 路径都算远程', () => {
    useSettingsStore.setState({ workingDirectory: 'ssh://h/C:/p' });
    expect(isLocalSessionFile('C:\\p\\a.ts')).toBe(false);
    expect(isLocalSessionFile('ssh://h/C:/p/a.ts')).toBe(false);
  });
});
