// 把 tauri build 的产物收集到根目录 release/：MSI 安装包 + 免安装版 exe
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
if (msis.length === 0) {
  console.error(`未找到 ${version} 版本的 MSI：${msiDir}`);
  process.exit(1);
}
for (const f of msis) copyFileSync(join(msiDir, f), join(outDir, f));

// 程序本体即免安装版
const portable = `ClaudeDeck_${version}_x64_portable.exe`;
copyFileSync(join(target, "claudedeck.exe"), join(outDir, portable));

console.log(`已输出到 ${outDir}：\n  ${[...msis, portable].join("\n  ")}`);
