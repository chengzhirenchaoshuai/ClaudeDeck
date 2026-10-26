// 把 tauri build 的产物收集到根目录 release/：MSI 安装包及签名、免安装版 exe 及签名、更新清单 latest.json
// 免安装版签名需要 TAURI_SIGNING_PRIVATE_KEY 等环境变量，请通过 pnpm release（scripts/release.mjs）运行
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "chengzhirenchaoshuai/ClaudeDeck";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "src-tauri", "target", "release");
const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });

// 只取当前版本的 MSI，避免把旧版本一起拷走
const msiDir = join(target, "bundle", "msi");
const msis = existsSync(msiDir)
  ? readdirSync(msiDir).filter((f) => f.endsWith(".msi") && f.includes(`_${version}_`))
  : [];
if (msis.length !== 1) {
  console.error(`应恰好有一个 ${version} 版本的 MSI，实际找到 ${msis.length} 个：${msiDir}`);
  process.exit(1);
}
const msi = msis[0];
const sig = `${msi}.sig`;
if (!existsSync(join(msiDir, sig))) {
  console.error(`未找到更新签名文件：${join(msiDir, sig)}（打包时是否注入了签名私钥？）`);
  process.exit(1);
}
copyFileSync(join(msiDir, msi), join(outDir, msi));
copyFileSync(join(msiDir, sig), join(outDir, sig));

// 程序本体即免安装版，用同一把私钥签名，供免安装版自更新校验
const portable = `ClaudeDeck_${version}_x64_portable.exe`;
copyFileSync(join(target, "claudedeck.exe"), join(outDir, portable));
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error("缺少 TAURI_SIGNING_PRIVATE_KEY，无法给免安装版签名；请用 pnpm release 打包");
  process.exit(1);
}
const signed = spawnSync(`pnpm tauri signer sign "${join(outDir, portable)}"`, {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  shell: true,
});
const portableSig = `${portable}.sig`;
if (signed.status !== 0 || !existsSync(join(outDir, portableSig))) {
  console.error("免安装版签名失败");
  process.exit(1);
}

// 从 CHANGELOG.md 取当前版本的条目作为更新说明
function changelogNotes() {
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf(`## [${version}]`);
  if (start < 0) {
    console.warn(`CHANGELOG.md 中没有 ${version} 的条目，更新说明留空`);
    return "";
  }
  const body = text.slice(text.indexOf("\n", start) + 1);
  const end = body.search(/^## \[/m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

// 更新清单：应用内更新从 releases/latest/download/latest.json 读取。
// windows-x86_64 供 MSI 安装版的更新插件使用；windows-x86_64-portable 是自定义条目，供免安装版替换 exe
const releaseUrl = (file) => `https://github.com/${REPO}/releases/download/v${version}/${file}`;
const manifest = {
  version,
  notes: changelogNotes(),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(msiDir, sig), "utf8").trim(),
      url: releaseUrl(msi),
    },
    "windows-x86_64-portable": {
      signature: readFileSync(join(outDir, portableSig), "utf8").trim(),
      url: releaseUrl(portable),
    },
  },
};
writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`已输出到 ${outDir}：\n  ${[msi, sig, portable, portableSig, "latest.json"].join("\n  ")}`);
