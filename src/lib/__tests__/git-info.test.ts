import { describe, it, expect } from 'vitest';
import { ghHintKey, ghNeedsAttention, type GitInfo } from '../git-info';

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
