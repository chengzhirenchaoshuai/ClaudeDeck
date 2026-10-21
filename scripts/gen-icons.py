"""从 assets/icons/source/ 下的两个 SVG 生成应用、任务栏、托盘用的全部图标。

用法（在项目根目录）：python scripts/gen-icons.py

- icon.svg：48px 及以上使用的完整图形（带底板）
- icon-small.svg：32px 及以下与托盘使用的简化图形（无底板、线条加粗）

依赖：Pillow，以及系统自带的 Microsoft Edge（用无头模式把 SVG 渲染成 1024px 透明 PNG，再缩放）。
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icons" / "source"
ICONS = ROOT / "assets" / "icons"
PUBLIC = ROOT / "assets" / "public"
RENDER = 1024
# 32px 及以下改用小号图形
SMALL_MAX = 32
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
# ICO（exe 资源：桌面快捷方式、任务栏、资源管理器）所有尺寸都用无底板的小号图形；
# 改为 False 则 48px 及以上恢复带底板的完整图形
ICO_ALL_SMALL = True

EDGE_CANDIDATES = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]


def find_edge() -> Path:
    for p in EDGE_CANDIDATES:
        if p.exists():
            return p
    sys.exit("找不到 Microsoft Edge，无法渲染 SVG")


def render(edge: Path, svg: Path, tmp: Path) -> Image.Image:
    """用无头 Edge 把 SVG 渲染成 RENDER×RENDER 的透明 PNG。"""
    page = tmp / f"{svg.stem}.html"
    out = tmp / f"{svg.stem}.png"
    page.write_bytes(
        (
            '<!doctype html><meta charset="utf-8">'
            "<style>html,body{margin:0;background:transparent}"
            f"img{{display:block;width:{RENDER}px;height:{RENDER}px}}</style>"
            f'<img src="{svg.as_uri()}">'
        ).encode("utf-8")
    )
    subprocess.run(
        [
            str(edge), "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--allow-file-access-from-files", "--default-background-color=00000000",
            f"--window-size={RENDER},{RENDER}", f"--screenshot={out}", page.as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    img = Image.open(out).convert("RGBA")
    if img.size != (RENDER, RENDER):
        sys.exit(f"渲染尺寸不对：{img.size}")
    return img


def main() -> None:
    edge = find_edge()
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        big = render(edge, SRC / "icon.svg", tmp)
        small = render(edge, SRC / "icon-small.svg", tmp)

    def sized(n: int) -> Image.Image:
        return (small if n <= SMALL_MAX else big).resize((n, n), Image.LANCZOS)

    outputs = {
        ICONS / "32x32.png": 32,
        ICONS / "64x64.png": 64,
        ICONS / "128x128.png": 128,
        ICONS / "128x128@2x.png": 256,
        ICONS / "icon.png": 256,
        PUBLIC / "app-icon.png": 256,
    }
    for path, n in outputs.items():
        sized(n).save(path)
        print(f"{path.relative_to(ROOT)}  {n}px")

    # 托盘：64px 小号图形；前端会在其上叠加未读角标（useTaskbarBadge.ts）
    tray = small.resize((64, 64), Image.LANCZOS)
    for path in (ICONS / "tray.png", PUBLIC / "tray-icon.png"):
        tray.save(path)
        print(f"{path.relative_to(ROOT)}  64px（小号）")

    # ICO：每个尺寸单独缩放
    frames = [small.resize((n, n), Image.LANCZOS) if ICO_ALL_SMALL else sized(n) for n in ICO_SIZES]
    frames[-1].save(
        ICONS / "icon.ico",
        sizes=[(n, n) for n in ICO_SIZES],
        append_images=frames[:-1],
    )
    print(f"assets/icons/icon.ico  {ICO_SIZES}")

    # tauri-build 不会因 icon.ico 变化而重新嵌入 exe 资源，更新 build.rs 的时间戳强制下次构建重新生成
    (ROOT / "src-tauri" / "build.rs").touch()


if __name__ == "__main__":
    main()
