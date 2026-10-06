#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 同步修改三处版本号：
#   - package.json
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
#
# 用法：
#   scripts/bump-version.sh 1.1.0
#
# 只依赖 Node.js，Windows（Git Bash）与 macOS 均可运行。
# ============================================================

if [ $# -ne 1 ]; then
  echo "用法：$0 <新版本号>"
  echo "示例：$0 1.1.0"
  exit 1
fi

NEW_VERSION="$1"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "错误：版本号必须是 x.y.z 格式（例如 1.1.0）"
  exit 1
fi

cd "$PROJECT_DIR"
node - "$NEW_VERSION" <<'NODE'
const fs = require('fs');
const v = process.argv[2];

// JSON 文件：保持 2 空格缩进与末尾换行
for (const p of ['package.json', 'src-tauri/tauri.conf.json']) {
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (p === 'package.json') console.log(`版本号：${d.version} → ${v}`);
  d.version = v;
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`  ${p} ✓`);
}

// Cargo.toml：只替换 [package] 段里的第一处 version
const cargo = 'src-tauri/Cargo.toml';
const text = fs.readFileSync(cargo, 'utf8');
const next = text.replace(/^version = "[^"]*"/m, `version = "${v}"`);
if (next === text) throw new Error('Cargo.toml 中未找到 version 字段');
fs.writeFileSync(cargo, next);
console.log(`  ${cargo} ✓`);
NODE

echo ""
echo "完成。别忘了更新 CHANGELOG.md 和 src/lib/changelog.ts。"
