// 把 tauri build 的产物收集到根目录 release/：MSI 安装包及签名、免安装版 exe、更新清单 latest.json
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

// 程序本体即免安装版
const portable = `ClaudeDeck_${version}_x64_portable.exe`;
copyFileSync(join(target, "claudedeck.exe"), join(outDir, portable));

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

// 更新清单：应用内更新从 releases/latest/download/latest.json 读取
const manifest = {
  version,
  notes: changelogNotes(),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(msiDir, sig), "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${msi}`,
    },
  },
};
writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`已输出到 ${outDir}：\n  ${[msi, sig, portable, "latest.json"].join("\n  ")}`);
