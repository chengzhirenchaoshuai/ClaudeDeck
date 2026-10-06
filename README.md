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

从 [Releases](https://github.com/chengzhirenchaoshuai/ClaudeDeck/releases) 下载 `.exe` 或 `.msi` 安装包运行即可。应用内自动更新已关闭，新版本需手动下载安装。

## 开发

需要 Node.js、pnpm 和 Rust 工具链。

```bash
pnpm install
pnpm tauri dev      # 开发模式
pnpm tauri build    # 打包，产物在 src-tauri/target/release/bundle/
```

alpha 版（独立 identifier 与图标，可与正式版并存）：

```bash
EDITION=alpha pnpm tauri build --config src-tauri/tauri.alpha.conf.json
```

### 发布

本地打包后上传到 GitHub Release（需要已登录的 [gh](https://cli.github.com)）：

```bash
scripts/bump-version.sh 1.1.1    # 同步修改 package.json / tauri.conf.json / Cargo.toml
# 更新 CHANGELOG.md 与 src/lib/changelog.ts
git commit -am "chore: 发布 v1.1.1"
git tag -a v1.1.1 -m "ClaudeDeck v1.1.1"
git push origin main v1.1.1
pnpm tauri build
gh release create v1.1.1 --verify-tag --title "ClaudeDeck v1.1.1" --notes "..." \
  src-tauri/target/release/bundle/nsis/ClaudeDeck_1.1.1_x64-setup.exe \
  src-tauri/target/release/bundle/msi/ClaudeDeck_1.1.1_x64_en-US.msi
```

## 技术栈

Tauri 2 · React 19 · TypeScript · Tailwind CSS 4 · Zustand 5 · TipTap 3 · CodeMirror 6 · Vite 7 · Rust（tokio / reqwest / serde / notify）

## 许可证

[Apache License 2.0](LICENSE)。本项目为修改后的再分发版本，原作者署名与修改说明见 [NOTICE](NOTICE)。

## 致谢

- [TOKENICODE](https://github.com/yiliqi78/TOKENICODE)（TinyZ）—— 原始项目
- [TOKENICODE DeepSeek Alpha](https://github.com/mistydew/tokenicode-deepseek-alpha) —— 中间分支
- [Anthropic](https://anthropic.com) —— Claude Code CLI
- [Tauri](https://tauri.app) —— 桌面应用框架
