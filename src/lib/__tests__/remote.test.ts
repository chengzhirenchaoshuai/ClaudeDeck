import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node 测试环境没有浏览器存储；切换会话时会写入上次会话 ID 等
const memoryStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
};
vi.stubGlobal('sessionStorage', memoryStorage());
vi.stubGlobal('localStorage', memoryStorage());

const { useSettingsStore } = await import('../../stores/settingsStore');
const { useSessionStore } = await import('../../stores/sessionStore');
const { useChatStore } = await import('../../stores/chatStore');
const {
  LOCAL_ENV, isLocalSessionFile, remoteNativePath, remoteUri, startRemoteProject, switchEnv, toSessionFilePath,
} = await import('../remote');

describe('remoteUri', () => {
  it('拼出 ssh://<主机>/<路径>，统一正斜杠并去掉开头多余的斜杠', () => {
    expect(remoteUri('win-pc', 'C:\\Users\\me\\proj')).toBe('ssh://win-pc/C:/Users/me/proj');
    expect(remoteUri('win-pc', '  /C:/p  ')).toBe('ssh://win-pc/C:/p');
  });

  it('路径为空时返回空串，不能生成只有主机的 URI', () => {
    expect(remoteUri('win-pc', '')).toBe('');
    expect(remoteUri('win-pc', '  / ')).toBe('');
  });
});

describe('remoteNativePath', () => {
  it('转回远端 claude 看到的原生 Windows 路径', () => {
    expect(remoteNativePath('ssh://win-pc/C:/Users/me/my proj')).toBe('C:\\Users\\me\\my proj');
  });

  it('本机路径原样返回', () => {
    expect(remoteNativePath('F:/AI/proj')).toBe('F:/AI/proj');
  });
});

describe('toSessionFilePath', () => {
  it('远程项目里，远端绝对路径转成同一主机的 ssh:// 路径（任意盘符）', () => {
    useSettingsStore.setState({ workingDirectory: 'ssh://win-pc/C:/p' });
    expect(toSessionFilePath('D:\\data\\a.csv')).toBe('ssh://win-pc/D:/data/a.csv');
    expect(toSessionFilePath('C:/p/a.ts')).toBe('ssh://win-pc/C:/p/a.ts');
  });

  it('已是 ssh:// 的路径和相对路径不改', () => {
    useSettingsStore.setState({ workingDirectory: 'ssh://win-pc/C:/p' });
    expect(toSessionFilePath('ssh://other/C:/x')).toBe('ssh://other/C:/x');
    expect(toSessionFilePath('src/a.ts')).toBe('src/a.ts');
  });

  it('本机项目里不转换', () => {
    useSettingsStore.setState({ workingDirectory: 'F:/AI/proj' });
    expect(toSessionFilePath('C:\\x\\a.ts')).toBe('C:\\x\\a.ts');
  });
});

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

describe('环境切换', () => {
  let fetchRemoteSessions: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchRemoteSessions = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ fetchRemoteSessions, sessions: [], selectedSessionId: 'local-session' } as never);
    useSettingsStore.setState({ activeEnv: LOCAL_ENV, workingDirectory: 'F:/AI/proj' });
  });
  afterEach(() => {
    useSettingsStore.setState({ activeEnv: LOCAL_ENV, workingDirectory: '' });
  });

  it('切到远程主机：取消选中会话、清空工作目录（两边路径不通用），并刷新远程列表', () => {
    switchEnv('win-pc');
    expect(useSettingsStore.getState()).toMatchObject({ activeEnv: 'win-pc', workingDirectory: '' });
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(fetchRemoteSessions).toHaveBeenCalledTimes(1);
  });

  it('切回本地不拉远程列表；已在目标环境时什么都不做', () => {
    switchEnv(LOCAL_ENV);
    expect(useSessionStore.getState().selectedSessionId).toBe('local-session');
    useSettingsStore.setState({ activeEnv: 'win-pc' });
    switchEnv(LOCAL_ENV);
    expect(fetchRemoteSessions).not.toHaveBeenCalled();
  });

  it('切走前保存当前标签页，回来还能恢复', () => {
    useChatStore.getState().removeTab('local-session');
    switchEnv('win-pc');
    expect(useChatStore.getState().getTab('local-session')).toBeDefined();
  });

  it('新建远程项目：切到该主机，工作目录为 ssh:// URI，草稿行带主机名', () => {
    startRemoteProject('win-pc', 'C:\\Users\\me\\proj');
    expect(useSettingsStore.getState()).toMatchObject({ activeEnv: 'win-pc', workingDirectory: 'ssh://win-pc/C:/Users/me/proj' });
    const draft = useSessionStore.getState().sessions[0];
    expect(draft).toMatchObject({ path: '', project: 'ssh://win-pc/C:/Users/me/proj', host: 'win-pc' });
    expect(draft.id.startsWith('draft_')).toBe(true);
    expect(useSessionStore.getState().selectedSessionId).toBe(draft.id);
  });

  it('远程路径为空时不新建', () => {
    startRemoteProject('win-pc', '  ');
    expect(useSettingsStore.getState().activeEnv).toBe(LOCAL_ENV);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });
});
