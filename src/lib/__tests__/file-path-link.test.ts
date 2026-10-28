import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import { isBareFileMissing, parseInlineFilePath, resolveSessionPath } from '../file-path-link';

describe('parseInlineFilePath', () => {
  it('识别原先漏掉的路径（例子取自真实会话）', () => {
    expect(parseInlineFilePath('scripts/gen-icons.py')).toEqual({ path: 'scripts/gen-icons.py' });
    expect(parseInlineFilePath('F:\\AI\\mywork\\ClaudeDock\\src\\App.tsx')?.path).toBe('F:\\AI\\mywork\\ClaudeDock\\src\\App.tsx');
    expect(parseInlineFilePath('src\\lib\\i18n.ts')?.path).toBe('src\\lib\\i18n.ts');
    expect(parseInlineFilePath('qt/pages/mod.py:921')).toEqual({ path: 'qt/pages/mod.py', line: 921 });
    expect(parseInlineFilePath('src/App.tsx:12-30')).toEqual({ path: 'src/App.tsx', line: 12 });
    expect(parseInlineFilePath('docs/说明文档.md')?.path).toBe('docs/说明文档.md');
    expect(parseInlineFilePath('/f/AI/mywork/a.ts')?.path).toBe('/f/AI/mywork/a.ts');
  });

  it('原先能识别的仍然能识别', () => {
    expect(parseInlineFilePath('src/stores/settingsStore.ts')?.path).toBe('src/stores/settingsStore.ts');
    expect(parseInlineFilePath('CLAUDE.md')?.path).toBe('CLAUDE.md');
    expect(parseInlineFilePath('./a/b.rs')?.path).toBe('./a/b.rs');
    expect(parseInlineFilePath('/etc/sudoers.d')?.path).toBe('/etc/sudoers.d');
  });

  it('不把普通代码当成文件', () => {
    for (const s of ['1.2.3', 'v1.2', 'a.b', 'foo.bar()', 'npm run dev', 'https://x.com/a.js', 'react-dom/client', 'obj.method', 'x.unknownext/y.zz']) {
      expect(parseInlineFilePath(s), s).toBeNull();
    }
  });
});

describe('resolveSessionPath', () => {
  beforeEach(() => {
    useSettingsStore.setState({ workingDirectory: 'F:/AI/proj' });
  });

  it('本机：相对路径拼到项目目录，反斜杠统一，.. 规整掉', () => {
    expect(resolveSessionPath('src\\lib\\a.ts', 'F:/AI/proj')).toBe('F:/AI/proj/src/lib/a.ts');
    expect(resolveSessionPath('../other/b.md', 'F:/AI/proj')).toBe('F:/AI/other/b.md');
    expect(resolveSessionPath('./c.ts', 'F:/AI/proj/')).toBe('F:/AI/proj/c.ts');
  });

  it('Git Bash 风格路径转成盘符路径', () => {
    expect(resolveSessionPath('/f/AI/x.ts', 'F:/AI/proj')).toBe('F:/AI/x.ts');
  });

  it('远程项目：绝对路径和相对路径都走 ssh://', () => {
    useSettingsStore.setState({ workingDirectory: 'ssh://h/C:/p' });
    expect(resolveSessionPath('C:\\p\\src\\a.ts', 'ssh://h/C:/p')).toBe('ssh://h/C:/p/src/a.ts');
    expect(resolveSessionPath('src\\a.ts', 'ssh://h/C:/p')).toBe('ssh://h/C:/p/src/a.ts');
    expect(resolveSessionPath('../q/b.ts', 'ssh://h/C:/p')).toBe('ssh://h/C:/q/b.ts');
  });
});

describe('isBareFileMissing', () => {
  const nodes = [
    { name: 'src', is_dir: true },
    { name: 'README.md', is_dir: false },
  ];
  const root = 'F:\\AI\\mywork\\GaussDB';
  const tree = { rootPath: root, nodes };

  it('项目根目录里没有的裸文件名判为缺失（例子取自真实会话：package.json 实际在临时目录）', () => {
    expect(isBareFileMissing('package.json', root, tree)).toBe(true);
  });

  it('根目录里有的文件不算缺失，大小写和斜杠写法不影响', () => {
    expect(isBareFileMissing('readme.md', 'f:/AI/mywork/GaussDB/', tree)).toBe(false);
  });

  it('带目录的路径、目录树属于别的项目或还没加载时不判断', () => {
    expect(isBareFileMissing('src/a.ts', root, tree)).toBe(false);
    expect(isBareFileMissing('src\\a.ts', root, tree)).toBe(false);
    expect(isBareFileMissing('package.json', 'F:\\AI\\other', tree)).toBe(false);
    expect(isBareFileMissing('package.json', root, { rootPath: root, nodes: [] })).toBe(false);
  });

  it('远程项目同样按目录树判断', () => {
    const remote = { rootPath: 'ssh://mylocal/F:/AI/mywork/GaussDB', nodes };
    expect(isBareFileMissing('package.json', 'ssh://mylocal/F:/AI/mywork/GaussDB', remote)).toBe(true);
  });
});
