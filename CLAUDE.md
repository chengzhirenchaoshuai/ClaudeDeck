# CLAUDE.md

ClaudeDeck：Claude Code CLI 的桌面 GUI（个人自用，fork 自 TOKENICODE，不再合并上游）。
技术栈：Tauri 2 + React 19 + TypeScript 5.8 + Tailwind CSS 4 + Zustand 5，pnpm，只支持 Windows（macOS/Linux 代码已移除，不要再加回非 Windows 分支）。

## 命令

```bash
pnpm install
pnpm dev:app                             # 开发版（前端热更新、Rust 自动重编译；可与正式版同时运行）
pnpm tauri build                         # 构建
EDITION=alpha pnpm tauri build --config src-tauri/tauri.alpha.conf.json   # alpha 版
pnpm build                               # tsc + vite build
pnpm vitest run                          # 测试在 src/**/__tests__/
cd src-tauri && cargo check && cargo clippy
scripts/bump-version.sh <版本号>          # 同步改 package.json / tauri.conf.json / Cargo.toml
```

## 架构要点

- **IPC**：前端调用后端一律经 `src/lib/tauri-bridge.ts`；后端到前端用事件 `claude:stream|stderr|exit|permission_request:{stdinId}`、`fs:change`、`setup:*`。
- **后端**：`src-tauri/src/lib.rs` 只留公共辅助（找 CLI、PATH、配置目录、JSON 截断）、托盘与 `run()`（命令列表见 `generate_handler!`）；命令按领域分在 `commands/`：`session_process`（启动会话/stdin/权限/控制请求）、`claude_process`（ProcessManager/StdinManager）、`sessions`（会话列表/搜索/导出/元数据/标题）、`files`、`providers`、`skills`、`cli_setup`（CLI 安装/更新/登录）、`cli_resolver`（CLI 查找/诊断/固定版本）、`toolchain`（Node/Git 部署）、`network`（代理与 HTTP 客户端）、`usage`、`git`、`local_models`、`preview`、`remote`（SSH 远程）；`protocol.rs` 为 SDK 控制协议类型。新模块以 `use crate::*;` 继承根模块导入，条目用 `pub(crate)`。
- **CLI 进程**：首条消息由 `start_claude_session` 启动 CLI（`--input-format/--output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode <mode> --permission-prompt-tool stdio --settings <JSON>`，可选 `--resume` / `--resume-session-at --fork-session` / `--model`）；后续消息经 StdinManager 写 stdin，不新建进程。
- **SDK 控制协议**：权限请求（`can_use_tool`）由 Rust 拦截后发给前端 `PermissionCard`，响应经 stdin 回写；运行时 `set_permission_mode`、`set_model`、`interrupt`、`rewind_files` 同样走 stdin。bypass 模式也走此协议，只是 CLI 自动批准工具权限。
- **模式映射**：`code/ask/plan/bypass` → `acceptEdits/default/plan/bypassPermissions`（`mapSessionModeToPermissionMode()`）。
- **环境注入**：`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（≥1M 上下文）、`CLAUDE_CODE_GIT_BASH_PATH`、服务商的 `ANTHROPIC_*` 及自定义变量。
- **远程主机**：项目路径用 `ssh://<主机别名>/<远端路径>`，由后端识别并经系统 ssh 在远端运行 claude，不注入本机服务商配置。
- **多标签页**：`chatStore` 按 `tabs: Map<tabId, TabSession>` 保存所有标签页，所有方法都带 `tabId`；切换时调用 `restoreFromCache`（判断是否需要从磁盘重新加载）。`agentStore` 只保存当前标签页的代理树，切换时用 `saveToCache`/`restoreFromCache` 存取。后台会话按 `sessionStore.stdinToTab` 路由。
- **回溯**：`useRewind.ts` → 终止进程 → `rewindFiles`（控制协议，失败时另起 CLI）→ 截断消息 → `--resume`。
- **流解析**：`useStreamProcessor.ts` 的 `handleStreamMessage` 逐行解析 NDJSON，按 stdinId 路由到所属标签页，前台、后台共用一套逻辑；依赖 InputBar 的 ref、`agentStore`（只存当前标签页）或当前选中标签页的动作用 `isForeground` 限定在前台。 消息类型见 `src/lib/stream-message.ts`（依据 Agent SDK 的 `SDKMessage`）：**实时 stream-json 用蛇形字段（如 `compact_metadata.pre_tokens`），磁盘会话 JSONL 用驼峰（`compactMetadata.preTokens`）**，两者不要混用。各会话的流监听器经 `src/lib/stream-listeners.ts` 登记/释放。
- **状态**：`src/stores/` 共 13 个 Zustand store。`settingsStore` 持久化到 localStorage（version 16，改结构必须加迁移）；`providerStore` 由后端写 `config/providers.json`。
- **数据目录**：统一在 `%APPDATA%/ClaudeDeck/`（`src-tauri/src/app_paths.rs`）：`config/` 配置、`cache/` 缓存、`tools/` 自动安装的 CLI/Git/Node、`webview/` WebView2 数据（alpha 为 `webview-alpha`，debug 构建自动加 `-dev`）。主窗口在配置里 `create: false`，由 `setup` 指定数据目录创建；新窗口也必须在后端用 `data_directory` 创建。首次启动自动从 `~/.tokenicode` 和 `%LOCALAPPDATA%/<identifier>/EBWebView` 复制迁移。例外：会话名称留在 CLI 配置目录（远程客户端共享），附件在 `<项目>/.tokenicode/tmp`。
- **会话目录**：`<CLI 配置目录>/projects/<编码路径>/`（`/a/b-c` → `-a-b-c`）；`decode_project_name()` 靠逐段匹配文件系统还原，连字符有歧义。CLI 配置目录优先取 `CLAUDE_CONFIG_DIR`，否则为 `~/.claude`。
- **双版本**：`EDITION` 环境变量注入 `__APP_EDITION__`/`__APP_NAME__`（`vite.config.ts`、`src/lib/edition.ts`）；alpha 有独立 identifier 和图标。
- **发布**：只维护 Windows 版，本地 `pnpm tauri build`（只出 MSI），连同 `target/release/claudedeck.exe`（免安装版）用 `gh release create` 上传到 `chengzhirenchaoshuai/ClaudeDeck`（步骤见 README），无 CI。

## 约定

- 素材统一放在 `assets/`：`icons/`（应用图标 + 托盘图标）、`icons-alpha/`、`public/`（Vite publicDir）。
- 面向用户的文案全部走 `src/lib/i18n.ts`（zh/en，默认 zh）。
- 代码中残留的 `tokenicode` 命名（事件名、`tokenicode_session_names.json`、项目内 `.tokenicode/tmp`）是为兼容已有用户数据，不要改名。
- Windows：`.cmd`/`.bat` 需经 `cmd /C` 启动，子进程要加 CREATE_NO_WINDOW。
- **换行符一律 LF**（`.gitattributes` 强制，`.bat/.cmd/.ps1` 除外）。用脚本改文件时不要引入 CRLF：Python 用 `read_bytes()/write_bytes()` 或 `open(..., newline="")`，不要用默认文本模式的 `write_text()`/`open("w")`（Windows 下会把 `\n` 写成 `\r\n`）；改完用 `git ls-files --eol | grep w/crlf` 自查，应无输出。

## 排查入口

| 现象 | 位置 |
|------|------|
| 消息不显示/流卡住 | `useStreamProcessor.ts`、`chatStore.ts`、`session_process.rs` 的 stdout 读取循环 |
| 发送无响应/恢复失败 | `InputBar.tsx`、`tauri-bridge.ts`、`session_process.rs` 的 `start_claude_session` |
| 权限弹窗 | `PermissionCard.tsx`、`protocol.rs`、`respond_permission` |
| 切标签丢状态 | `chatStore.ts`/`agentStore.ts` 的缓存方法 |
| 服务商/API | `providerStore.ts`、`api-provider.ts`、`test_provider_connection` |
| 找不到 CLI | `SetupWizard.tsx`、`CliTab.tsx`、`cli_resolver.rs` |
| 回溯 | `useRewind.ts`、`turns.ts`、`rewind-point.ts`、`RewindPanel.tsx` |
| 远程 | `remote.rs`、`src/lib/remote.ts`、`RemoteTab.tsx`、`EnvSwitcher.tsx` |
| 用量 | `usageStore.ts`、`rateLimitsStore.ts`、`src/lib/usage.ts` |

## 调试开发版 UI（重要）

用户可能正用正式版 ClaudeDeck 作为当前 Claude Code 的界面：

1. **绝不杀用户的正式版进程**（`target/release` 或安装目录下的 `claudedeck.exe`）；清理时只按 `target/debug` 路径或 PID 结束开发版。
2. 用 `pnpm dev:app` 启动：通过 `src-tauri/tauri.dev.conf.json` 覆盖 identifier（`...claudedeck-dev`），避开单实例插件；debug 构建自动使用 `webview-dev`，窗口标题带 “Dev”。无需修改 `tauri.conf.json`。
3. 开发版与正式版共用 `config/`，测试时注意不要误改真实配置。
