# ClaudeDeck

Claude Code CLI 的桌面图形界面（个人自用版）。

基于 [TOKENICODE](https://github.com/yiliqi78/TOKENICODE) 及其分支 [TOKENICODE DeepSeek Alpha](https://github.com/mistydew/tokenicode-deepseek-alpha) 修改，已独立维护，不再合并上游。

## 功能

- **对话**：多会话标签页并发运行，流式输出，思考过程与工具调用实时展示，`Ctrl+Tab` 快速切换最近两个会话
- **会话管理**：会话列表直接读取 CLI 的 `projects` 目录（支持 `CLAUDE_CONFIG_DIR`），按项目分组，自动同步 CLI 侧的变化；支持置顶、归档、搜索、导出 Markdown/JSON、自动生成标题
- **权限控制**：基于 SDK 控制协议的权限审批卡片，四种模式（code / ask / plan / bypass），运行中可切换模式与模型
- **回溯**：利用 CLI 检查点回退到任意轮次，可只恢复对话、只恢复代码或全部恢复
- **API 服务商**：多服务商配置，内置 Anthropic、DeepSeek、智谱 GLM、Kimi、MiniMax、通义千问、OpenRouter、小米 MiMo 等预设，支持导入导出
- **本地模型**：对接 Ollama，可列出和拉取本地模型
- **远程主机**：通过系统 ssh 在远程 Windows 主机上运行 claude，侧栏一键切换本地/远程
- **文件**：文件树浏览、变更标记、CodeMirror 编辑器、HTML/网页预览
- **扩展**：斜杠命令、命令面板（`Ctrl+K`）、Skills 管理与翻译、MCP 服务、插件管理
- **用量**：用量统计、5 小时 / 7 天限额显示、上下文占用与自动压缩阈值
- **桌面体验**：多主题与明暗模式、`Ctrl+滚轮` / `Ctrl+=/-/0` 缩放、任务栏未读角标、关闭时最小化到任务栏

## 安装

前置条件：Windows 10 及以上，已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（未安装时应用内向导可引导安装和登录）。

从 [Releases](https://github.com/chengzhirenchaoshuai/ClaudeDeck/releases) 下载：`.msi` 为安装版；`_portable.exe` 为免安装版，直接运行（需系统已有 WebView2，Windows 11 自带）。应用内自动更新已关闭，新版本需手动下载安装。

## 开发

需要 Node.js、pnpm 和 Rust 工具链。

```bash
pnpm install
pnpm dev:app        # 开发模式：前端热更新、后端自动重编译，可与正式版同时运行
pnpm release        # 打包，MSI 与免安装版 exe 输出到根目录 release/
```

### 发布

本地打包后上传到 GitHub Release（需要已登录的 [gh](https://cli.github.com)）：

```bash
scripts/bump-version.sh 1.1.1    # 同步修改 package.json / tauri.conf.json / Cargo.toml
# 更新 CHANGELOG.md 与 src/lib/changelog.ts
git commit -am "chore: 发布 v1.1.1"
git tag -a v1.1.1 -m "ClaudeDeck v1.1.1"
git push origin main v1.1.1
pnpm release                     # 生成 MSI 及签名、免安装版、latest.json，输出到 release/
gh release create v1.1.1 --verify-tag --title "ClaudeDeck v1.1.1" --notes "..." \
  release/ClaudeDeck_1.1.1_x64_en-US.msi \
  release/ClaudeDeck_1.1.1_x64_en-US.msi.sig \
  release/ClaudeDeck_1.1.1_x64_portable.exe \
  release/latest.json
```

**应用内更新**：程序启动 5 秒后（之后每 6 小时）读取 `releases/latest/download/latest.json`，有新版时顶栏出现更新按钮。MSI 安装版可在应用内下载并安装（安装时程序退出，装完自动重新打开）；免安装版只能打开发布页手动下载。开发模式不自动检查。

- 签名私钥默认读取 `~/.tauri/claudedeck.key`，密码读取同目录的 `claudedeck.key.password`；也可用环境变量 `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 指定（空密码的私钥签名会失败）；公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey`。**私钥或密码丢失后，已发布的版本将无法再收到更新**，务必把这两个文件另行备份。
- `latest.json` 的更新说明取自 `CHANGELOG.md` 中当前版本的条目；Release 必须标记为 Latest，否则检查不到。
- 是否为安装版：读注册表 `HKCU\Software\chengzhiren66\ClaudeDeck\InstallDir`，与当前 exe 所在目录比较（`commands/updater.rs`）。

### 架构说明

- **后端模块**：`src-tauri/src/lib.rs` 只留公共辅助（找 CLI、PATH、配置目录、JSON 截断）、托盘与 `run()`；命令按领域分在 `commands/`：`session_process`（启动会话/stdin/权限/控制请求）、`claude_process`（ProcessManager/StdinManager）、`sessions`（会话列表/搜索/导出/元数据/标题）、`files`、`providers`、`skills`、`cli_setup`（CLI 安装/更新/登录）、`cli_resolver`（CLI 查找/诊断/固定版本）、`toolchain`（Node/Git 部署）、`network`（代理与 HTTP 客户端）、`usage`、`git`、`local_models`、`preview`、`remote`（SSH 远程）、`updater`（应用更新环境）；`protocol.rs` 为 SDK 控制协议类型。
- **CLI 启动参数**：`--input-format/--output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode <mode> --permission-prompt-tool stdio --settings <JSON>`，可选 `--resume` / `--resume-session-at --fork-session` / `--model`。
- **环境注入**：`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（≥1M 上下文）、`CLAUDE_CODE_GIT_BASH_PATH`、服务商的 `ANTHROPIC_*` 及自定义变量。
- **回溯流程**：`useRewind.ts` → 终止进程 → `rewindFiles`（控制协议，失败时另起 CLI）→ 截断消息 → `--resume`。
- **数据目录**：`%APPDATA%\ClaudeDeck\` 下的 `config/`（配置）、`cache/`（缓存）、`tools/`（自动安装的 CLI/Git/Node）、`webview/`（WebView2 数据，debug 构建自动加 `-dev`），定义在 `src-tauri/src/app_paths.rs`。首次启动自动从 `~/.tokenicode` 和 `%LOCALAPPDATA%/<identifier>/EBWebView` 复制迁移。例外：会话名称留在 CLI 配置目录（远程客户端共享），附件放在 `<项目>/.tokenicode/tmp`。
- **会话目录**：`<CLI 配置目录>/projects/<编码路径>/`（`/a/b-c` → `-a-b-c`），CLI 配置目录优先取 `CLAUDE_CONFIG_DIR`，否则为 `~/.claude`。`decode_project_name()` 靠逐段匹配文件系统还原路径，连字符有歧义。
- **状态**：`src/stores/` 共 14 个 Zustand store（`updateStore` 为应用更新流程，不持久化）；`providerStore` 由后端写 `config/providers.json`。

### 排查入口

| 现象 | 位置 |
|------|------|
| 消息不显示/流卡住 | `useStreamProcessor.ts`、`hooks/stream/`（handlers、buffer）、`chatStore.ts`、`session_process.rs` 的 stdout 读取循环 |
| 发送无响应/恢复失败 | `InputBar.tsx`、`session-launch.ts`、`tauri-bridge.ts`、`session_process.rs` 的 `start_claude_session` |
| 权限弹窗 | `PermissionCard.tsx`、`protocol.rs`、`respond_permission` |
| 切标签丢状态 | `chatStore.ts`/`agentStore.ts` 的缓存方法 |
| 服务商/API | `providerStore.ts`、`api-provider.ts`、`test_provider_connection` |
| 找不到 CLI | `SetupWizard.tsx`、`CliTab.tsx`、`cli_resolver.rs` |
| 回溯 | `useRewind.ts`、`turns.ts`、`rewind-point.ts`、`RewindPanel.tsx` |
| 远程 | `remote.rs`、`src/lib/remote.ts`、`RemoteTab.tsx`、`EnvSwitcher.tsx` |
| 用量 | `usageStore.ts`、`rateLimitsStore.ts`、`src/lib/usage.ts` |

### 图标

源文件在 `assets/icons/source/`：`icon.svg`（48px 及以上，带底板）和 `icon-small.svg`（32px 及以下与托盘）。修改后运行 `python scripts/gen-icons.py`（需要 Pillow 和系统自带的 Edge），会重新生成 `assets/icons/` 下的 PNG、多尺寸 `icon.ico`、`tray.png`，以及 `assets/public/` 下的 `app-icon.png`（界面内图标，用无底板的小号图形）、`tray-icon.png`。目前 `icon.ico`（exe 图标，即桌面快捷方式和任务栏）所有尺寸都用 `icon-small.svg`，由脚本里的 `ICO_ALL_SMALL` 控制。窗口图标由 `src-tauri/src/app_icon.rs` 按 DPI 从 exe 资源里取对应尺寸的帧（Tauri 默认只用 ICO 第一帧 16px，任务栏会发糊）。

### 常见问题

- **移动或重命名项目目录后打包失败**（报找不到 `旧路径\src-tauri\target\...`）：`src-tauri/target` 的构建缓存记录了绝对路径，执行 `cd src-tauri && cargo clean` 后重新构建。

## 技术栈

Tauri 2 · React 19 · TypeScript · Tailwind CSS 4 · Zustand 5 · TipTap 3 · CodeMirror 6 · Vite 7 · Rust（tokio / reqwest / serde / notify）

## 许可证

[Apache License 2.0](LICENSE)。本项目为修改后的再分发版本，原作者署名与修改说明见 [NOTICE](NOTICE)。

## 致谢

- [TOKENICODE](https://github.com/yiliqi78/TOKENICODE)（TinyZ）—— 原始项目
- [TOKENICODE DeepSeek Alpha](https://github.com/mistydew/tokenicode-deepseek-alpha) —— 中间分支
- [Anthropic](https://anthropic.com) —— Claude Code CLI
- [Tauri](https://tauri.app) —— 桌面应用框架
