/**
 * 在 rehype-katex 渲染之前预处理公式文本。
 *
 * remark-math 6 生成的公式节点：行内为 code.language-math.math-inline，
 * 块级为 pre > code.language-math.math-display。
 *
 * 注意：旧版本按 className 含 'math' 匹配（remark-math 旧版的类名），在 remark-math 6 下从未匹配上，
 * 所以 katexFixText（./katex-fix）实际一直没有生效。其中“反斜杠 + 空格转换行”等规则会改动合法公式
 * （LaTeX 的 `\ ` 是控制空格），因此修正匹配条件后也没有启用它，这里只做行内分数的放大。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HastNode = any;

function walk(node: HastNode): void {
  if (!node || typeof node !== 'object') return;

  const className = node.properties?.className;
  if (
    node.type === 'element' &&
    Array.isArray(className) &&
    (className.includes('math-inline') || className.includes('math-display'))
  ) {
    // 行内公式的 \frac 默认是“文本样式”，分子分母很小、紧贴分数线，改为 \dfrac 按正常大小显示
    if (className.includes('math-inline') && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          child.value = child.value.replace(/\\frac(?![a-zA-Z])/g, '\\dfrac');
        }
      }
    }
    // 不再深入公式节点，交给 rehype-katex 处理
    return;
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walk(child);
    }
  }
}

export function rehypeKatexFix() {
  return (tree: HastNode) => {
    walk(tree);
  };
}
