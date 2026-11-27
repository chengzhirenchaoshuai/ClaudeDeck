// 项目 Git 信息（后端 get_git_info 返回）的类型与展示用的判断逻辑。
// 分支、主分支、user.name 与 CLI 写入系统提示的 gitStatus 取法一致；gh 登录状态与 CLI 的检测逻辑一致。

export type GhAuthStatus = 'not_installed' | 'authenticated' | 'not_authenticated' | 'unknown';

/** 一个未提交的文件（git status --porcelain 的一行） */
export interface ChangedFile {
  /** 两位状态码：第一位是暂存区，第二位是工作区，如 " M"、"M "、"??"、"R " */
  status: string;
  /** 相对仓库根目录的路径；重命名时为新路径。未跟踪的整个目录以 / 结尾 */
  path: string;
  /** 重命名、复制前的路径 */
  orig_path: string | null;
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

/** 把两位状态码归成一类，用于标记颜色和说明文字 */
export function changeKind(status: string): ChangeKind {
  if (status === '??') return 'untracked';
  // 合并冲突：任一位是 U，或两边都新增 / 都删除
  if (status.includes('U') || status === 'AA' || status === 'DD') return 'conflict';
  if (status.includes('D')) return 'deleted';
  if (status.includes('R')) return 'renamed';
  if (status.includes('A') || status.includes('C')) return 'added';
  return 'modified';
}

/** 拆成文件名和所在目录（目录可能为空）；未跟踪目录保留结尾的 / 以便区分 */
export function splitChangedPath(path: string): { name: string; dir: string } {
  const isDir = path.endsWith('/');
  const trimmed = isDir ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf('/');
  return {
    name: (i < 0 ? trimmed : trimmed.slice(i + 1)) + (isDir ? '/' : ''),
    dir: i < 0 ? '' : trimmed.slice(0, i),
  };
}

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
  /** 未提交的文件明细，最多 300 条（总数看 changed_files） */
  changed_list: ChangedFile[];
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
