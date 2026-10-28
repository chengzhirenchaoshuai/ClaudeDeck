/**
 * 复制消息文本时带上文件链接：链接是按钮且不可选中，浏览器默认复制时会把它整个丢掉；
 * 链接上又只显示文件名，复制出来应当是消息里的原文（完整路径和行号）。
 * 文件链接用 data-copy-text 记下原文，复制时把选区里的链接换成原文再写入剪贴板。
 */

/** 把片段里带 data-copy-text 的元素换成其原文，返回是否有替换 */
export function replaceCopyChips(root: DocumentFragment | Element): boolean {
  const chips = root.querySelectorAll('[data-copy-text]');
  chips.forEach((chip) => {
    chip.replaceWith(chip.ownerDocument.createTextNode(chip.getAttribute('data-copy-text') ?? ''));
  });
  return chips.length > 0;
}

function onCopy(e: ClipboardEvent) {
  // 输入框（TipTap）等自己处理了复制的，不再覆盖
  if (e.defaultPrevented || !e.clipboardData) return;
  const target = e.target as Element | null;
  if (target?.closest?.('[contenteditable="true"], input, textarea')) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < sel.rangeCount; i++) frag.appendChild(sel.getRangeAt(i).cloneContents());
  if (!replaceCopyChips(frag)) return;

  // innerText 要在文档里排版后才能得到正确的换行，挂到屏幕外取完即移除
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap;';
  box.appendChild(frag);
  document.body.appendChild(box);
  const text = box.innerText;
  const html = box.innerHTML;
  box.remove();

  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', html);
  e.preventDefault();
}

/** 在应用启动时注册一次，返回注销函数 */
export function installChipCopy(): () => void {
  document.addEventListener('copy', onCopy);
  return () => document.removeEventListener('copy', onCopy);
}
