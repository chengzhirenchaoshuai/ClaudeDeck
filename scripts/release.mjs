// 打包发布版：注入更新签名私钥后执行 tauri build，再收集产物到 release/
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = { ...process.env };

// tauri build 只认 TAURI_SIGNING_PRIVATE_KEY（私钥内容），不认 _PATH；
// 未提供时从 TAURI_SIGNING_PRIVATE_KEY_PATH 或默认的 ~/.tauri/claudedeck.key 读取，
// 密码默认取同目录的 <私钥文件名>.password（空密码的私钥签名会报密码错误，所以必须设密码）
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), ".tauri", "claudedeck.key");
  if (!existsSync(keyPath)) {
    console.error(`未找到更新签名私钥：${keyPath}\n可设置 TAURI_SIGNING_PRIVATE_KEY_PATH 指定其他位置`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  if (!env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    const pwPath = `${keyPath}.password`;
    if (!existsSync(pwPath)) {
      console.error(`未找到私钥密码文件：${pwPath}\n可设置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 直接提供密码`);
      process.exit(1);
    }
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(pwPath, "utf8").trim();
  }
}

// pnpm 在 Windows 上是 .cmd，需经 shell 启动；命令写成整串，参数都是常量
const run = (command) => {
  const r = spawnSync(command, { cwd: root, env, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("pnpm tauri build");
run("node scripts/collect-release.mjs");
