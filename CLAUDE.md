# CLAUDE.md

ClaudeDeck：Claude Code CLI 的桌面 GUI（个人自用，fork 自 TOKENICODE，不再合并上游）。
技术栈：Tauri 2 + React 19 + TypeScript 5.8 + Tailwind CSS 4 + Zustand 5，pnpm，主要用于 Windows（也支持 macOS）。

## 命令

```bash
pnpm install
pnpm tauri dev                           # 开发（beforeDevCommand: npm run dev，Vite 端口 1420）
pnpm tauri build                         # 构建
EDITION=alpha pnpm tauri build --config src-tauri/tauri.alpha.conf.json   # alpha 版
pnpm build                               # tsc + vite build
pnpm vitest run                          # 测试在 src/**/__tests__/
cd src-tauri && cargo check && cargo clippy
scripts/bump-version.sh <版本号>          # 同步改 package.json / tauri.conf.json / Cargo.toml
```

## 架构要点

- **IPC**：前端调用后端一律经 `src/lib/tauri-bridge.ts`；后端到前端用事件 `claude:stream|stderr|exit|permission_request:{stdinId}`、`fs:change`、`setup:*`。
- **后端**：命令几乎都在 `src-tauri/src/lib.rs`（约 9000 行，列表见 `generate_handler!`）；`commands/claude_process.rs`（ProcessManager/StdinManager）、`commands/cli_resolver.rs`（CLI 查找/诊断/固定版本）、`commands/remote.rs`（SSH 远程）、`protocol.rs`（SDK 控制协议类型）。
- **CLI 进程**：首条消息由 `start_claude_session` 启动 CLI（`--input-format/--output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode <mode> --permission-prompt-tool stdio --settings <JSON>`，可选 `--resume` / `--resume-session-at --fork-session` / `--model`）；后续消息经 StdinManager 写 stdin，不新建进程。
- **SDK 控制协议**：权限请求（`can_use_tool`）由 Rust 拦截后发给前端 `PermissionCard`，响应经 stdin 回写；运行时 `set_permission_mode`、`set_model`、`interrupt`、`rewind_files` 同样走 stdin。bypass 模式也走此协议，只是 CLI 自动批准工具权限。
- **模式映射**：`code/ask/plan/bypass` → `acceptEdits/default/plan/bypassPermissions`（`mapSessionModeToPermissionMode()`）。
- **环境注入**：`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（≥1M 上下文）、`CLAUDE_CODE_GIT_BASH_PATH`、服务商的 `ANTHROPIC_*` 及自定义变量。
- **远程主机**：项目路径用 `ssh://<主机别名>/<远端路径>`，由后端识别并经系统 ssh 在远端运行 claude，不注入本机服务商配置。
- **多标签页**：`chatStore`/`agentStore` 用 `saveToCache`/`restoreFromCache` 切换；后台会话按 `sessionStore.stdinToTab` 路由，经 `*InCache()` 写缓存。
- **回溯**：`useRewind.ts` → 终止进程 → `rewindFiles`（控制协议，失败时另起 CLI）→ 截断消息 → `--resume`。
- **流解析**：`useStreamProcessor.ts` 逐行解析 NDJSON（前台 + 后台标签页）。
- **状态**：`src/stores/` 共 13 个 Zustand store。`settingsStore` 持久化到 localStorage（version 16，改结构必须加迁移）；`providerStore` 由后端写 `~/.tokenicode/providers.json`。
- **会话目录**：`<CLI 配置目录>/projects/<编码路径>/`（`/a/b-c` → `-a-b-c`）；`decode_project_name()` 靠逐段匹配文件系统还原，连字符有歧义。CLI 配置目录优先取 `CLAUDE_CONFIG_DIR`，否则为 `~/.claude`。
- **双版本**：`EDITION` 环境变量注入 `__APP_EDITION__`/`__APP_NAME__`（`vite.config.ts`、`src/lib/edition.ts`）；alpha 有独立 identifier 和图标，CI 中带 `-alpha` 的 tag 会构建 alpha 版。

## 约定

- 素材统一放在 `assets/`：`icons/`（应用图标 + 托盘图标）、`icons-alpha/`、`public/`（Vite publicDir）。
- 面向用户的文案全部走 `src/lib/i18n.ts`（zh/en，默认 zh）。
- 代码中残留的 `tokenicode` 命名（`~/.tokenicode` 目录、事件名、`tokenicode_session_names.json`）是为兼容已有用户数据，不要改名。
- 标题栏为 Overlay + hiddenTitle，macOS 下要避开红绿灯区域。
- Windows：`.cmd`/`.bat` 需经 `cmd /C` 启动，子进程要加 CREATE_NO_WINDOW。

## 排查入口

| 现象 | 位置 |
|------|------|
| 消息不显示/流卡住 | `useStreamProcessor.ts`、`chatStore.ts`、`lib.rs` 的 stdout 读取循环 |
| 发送无响应/恢复失败 | `InputBar.tsx`、`tauri-bridge.ts`、`lib.rs` 的 `start_claude_session` |
| 权限弹窗 | `PermissionCard.tsx`、`protocol.rs`、`respond_permission` |
| 切标签丢状态 | `chatStore.ts`/`agentStore.ts` 的缓存方法 |
| 服务商/API | `providerStore.ts`、`api-provider.ts`、`test_provider_connection` |
| 找不到 CLI | `SetupWizard.tsx`、`CliTab.tsx`、`cli_resolver.rs` |
| 回溯 | `useRewind.ts`、`turns.ts`、`rewind-point.ts`、`RewindPanel.tsx` |
| 远程 | `remote.rs`、`src/lib/remote.ts`、`RemoteTab.tsx`、`EnvSwitcher.tsx` |
| 用量 | `usageStore.ts`、`rateLimitsStore.ts`、`src/lib/usage.ts` |

## 调试开发版 UI（重要）

用户可能正用旧版 ClaudeDeck 作为当前 Claude Code 的界面：

1. **绝不杀用户的主 UI 进程**（通常是最早启动的 `claudedeck.exe`，用 `Get-Process claudedeck | Select Id,StartTime` 查看）。
2. 启动前把 `src-tauri/tauri.conf.json` 的 identifier 临时改为 `com.chengzhiren66.claudedeck-dev`，否则 WebView2 数据目录冲突，窗口无法渲染。**提交前必须改回。**
3. 分开启动：后台运行 `npm run dev`，再运行 `./src-tauri/target/debug/claudedeck.exe`（不用 `pnpm tauri dev`，它会随窗口关闭退出）。
4. 只清理开发版：`Get-Process claudedeck | Where-Object { $_.Id -ne <主UI PID> } | Stop-Process -Force`。
