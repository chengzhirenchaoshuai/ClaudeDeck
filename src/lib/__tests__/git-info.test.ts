import { describe, it, expect } from 'vitest';
import { changeKind, ghHintKey, ghNeedsAttention, splitChangedPath, type GitInfo } from '../git-info';

const base: GitInfo = {
  is_repo: true,
  branch: 'main',
  main_branch: 'main',
  user_name: 'chengzhiren66',
  user_name_scope: 'local',
  user_email: null,
  user_email_scope: null,
  remote_url: null,
  changed_files: 0,
  changed_list: [],
  gh_status: 'authenticated',
  gh_error: null,
  gh_account: 'someone',
  gh_token_invalid: false,
};

describe('ghHintKey', () => {
  it('shows no hint when logged in with a valid token', () => {
    expect(ghHintKey(base, false)).toBeNull();
    expect(ghNeedsAttention(base)).toBe(false);
  });

  it('points to the SSH keyring issue when a remote account has no readable token', () => {
    const info = { ...base, gh_status: 'not_authenticated' as const };
    expect(ghHintKey(info, true)).toBe('git.hint.sshKeyring');
    expect(ghHintKey(info, false)).toBe('git.hint.ghLogin');
    expect(ghHintKey({ ...info, gh_account: null }, true)).toBe('git.hint.ghLogin');
    expect(ghNeedsAttention(info)).toBe(true);
  });

  it('covers invalid token, missing gh and unknown status', () => {
    expect(ghHintKey({ ...base, gh_token_invalid: true }, false)).toBe('git.hint.tokenInvalid');
    expect(ghNeedsAttention({ ...base, gh_token_invalid: true })).toBe(true);
    expect(ghHintKey({ ...base, gh_status: 'not_installed' }, false)).toBe('git.hint.ghMissing');
    expect(ghHintKey({ ...base, gh_status: 'unknown' }, false)).toBe('git.hint.ghUnknown');
  });
});

describe('changeKind', () => {
  it('按暂存区和工作区两位状态归类', () => {
    expect(changeKind(' M')).toBe('modified');
    expect(changeKind('MM')).toBe('modified');
    expect(changeKind('A ')).toBe('added');
    expect(changeKind('??')).toBe('untracked');
    expect(changeKind(' D')).toBe('deleted');
    expect(changeKind('R ')).toBe('renamed');
    expect(changeKind('UU')).toBe('conflict');
    expect(changeKind('AA')).toBe('conflict');
  });
});

describe('splitChangedPath', () => {
  it('拆出文件名和目录，根目录文件的目录为空，未跟踪目录保留结尾的 /', () => {
    expect(splitChangedPath('src/lib/a.ts')).toEqual({ name: 'a.ts', dir: 'src/lib' });
    expect(splitChangedPath('README.md')).toEqual({ name: 'README.md', dir: '' });
    expect(splitChangedPath('assets/new/')).toEqual({ name: 'new/', dir: 'assets' });
  });
});
