# CLAUDE.md

ClaudeDeck：Claude Code CLI 的桌面 GUI（个人自用，fork 自 TOKENICODE，不再合并上游）。
Tauri 2 + React 19 + TypeScript + Tailwind CSS 4 + Zustand 5，pnpm。**只支持 Windows**，不要加回 macOS/Linux 分支。
模块划分、数据目录、排查入口、发布步骤见 README「开发」一节。

## 命令

```bash
pnpm dev:app                       # 开发版，可与正式版同时运行
pnpm release                       # 打包，MSI + 免安装版 exe 收集到 release/
pnpm build                         # tsc + vite build
pnpm vitest run                    # 测试在 src/**/__tests__/
cd src-tauri && cargo check && cargo clippy
scripts/bump-version.sh <版本号>    # 同步三处版本号
```

## 关键约束

- **IPC**：前端调后端一律经 `src/lib/tauri-bridge.ts`。后端命令按领域放在 `src-tauri/src/commands/`，新模块用 `use crate::*;`，条目用 `pub(crate)`。
- **CLI 进程**：首条消息由 `start_claude_session` 启动 CLI，之后的消息、权限响应（`can_use_tool`）、`set_permission_mode`/`set_model`/`interrupt`/`rewind_files` 都走 stdin 上的 SDK 控制协议，不新建进程。模式映射 `code/ask/plan/bypass` → `acceptEdits/default/plan/bypassPermissions`。
- **流解析**：`useStreamProcessor.ts` 按 stdinId 路由到标签页，分发给 `src/hooks/stream/handlers/`，前后台共用；依赖 InputBar ref、`agentStore` 或当前选中标签页的操作要用 `isForeground` 限定。消息类型见 `src/lib/stream-message.ts`：**实时 stream-json 用蛇形字段，磁盘 JSONL 用驼峰**，不要混用。
- **多标签页**：`chatStore` 的方法都带 `tabId`；`agentStore` 只存当前标签页，切换时 `saveToCache`/`restoreFromCache`；后台会话按 `sessionStore.stdinToTab` 路由。
- **状态持久化**：`settingsStore` 存 localStorage（version 16），改结构必须加迁移。
- **远程主机**：项目路径 `ssh://<主机别名>/<远端路径>`，经系统 ssh 在远端运行，不注入本机服务商配置。
- **窗口**：主窗口 `create: false`，新窗口也必须在后端用 `data_directory` 创建（数据目录见 `app_paths.rs`）。
- **Windows**：`.cmd`/`.bat` 经 `cmd /C` 启动，子进程加 CREATE_NO_WINDOW。
- 用户文案全部走 `src/lib/i18n.ts`（zh/en，默认 zh）。素材放 `assets/`。
- 残留的 `tokenicode` 命名（事件名、`tokenicode_session_names.json`、`.tokenicode/tmp`）用于兼容用户数据，不要改名。
- **换行符一律 LF**（`.bat/.cmd/.ps1` 除外）。Python 改文件用 `read_bytes()/write_bytes()` 或 `open(..., newline="")`；改完用 `git ls-files --eol | grep w/crlf` 自查。

## 调试开发版 UI

用户可能正用正式版 ClaudeDeck 作为当前 Claude Code 的界面：

1. **绝不杀正式版进程**（`target/release` 或安装目录下的 `claudedeck.exe`），只按 `target/debug` 路径或 PID 结束开发版。
2. 用 `pnpm dev:app` 启动（`tauri.dev.conf.json` 覆盖 identifier，避开单实例），无需改 `tauri.conf.json`。
3. 开发版与正式版共用 `config/`，测试时不要误改真实配置。
