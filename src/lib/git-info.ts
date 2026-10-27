// 项目 Git 信息（后端 get_git_info 返回）的类型与展示用的判断逻辑。
// 分支、主分支、user.name 与 CLI 写入系统提示的 gitStatus 取法一致；gh 登录状态与 CLI 的检测逻辑一致。

export type GhAuthStatus = 'not_installed' | 'authenticated' | 'not_authenticated' | 'unknown';

export interface GitInfo {
  is_repo: boolean;
  /** 当前分支；游离 HEAD 时为 "HEAD" */
  branch: string;
  main_branch: string;
  user_name: string | null;
  /** 配置来源：local / global / system 等 */
  user_name_scope: string | null;
  user_email: string | null;
  user_email_scope: string | null;
  /** origin 地址（已去掉内嵌凭据） */
  remote_url: string | null;
  changed_files: number;
  gh_status: GhAuthStatus;
  gh_error: string | null;
  /** gh 当前活动账号；未登录但留有账号记录时也会有值 */
  gh_account: string | null;
  /** gh auth status 报告令牌失效 */
  gh_token_invalid: boolean;
}

/** gh 登录需要提醒用户处理的情况，返回 i18n 键；一切正常返回 null */
export function ghHintKey(info: GitInfo, isRemote: boolean): string | null {
  switch (info.gh_status) {
    case 'not_installed':
      return 'git.hint.ghMissing';
    case 'not_authenticated':
      // 留有账号记录却读不到令牌：远程项目经 SSH 登录，读不到远端 Windows 凭据管理器里的令牌
      return isRemote && info.gh_account ? 'git.hint.sshKeyring' : 'git.hint.ghLogin';
    case 'unknown':
      return 'git.hint.ghUnknown';
    default:
      return info.gh_token_invalid ? 'git.hint.tokenInvalid' : null;
  }
}

/** gh 状态是否需要在标签上标出提醒色 */
export function ghNeedsAttention(info: GitInfo): boolean {
  return info.gh_status !== 'authenticated' || info.gh_token_invalid;
}
