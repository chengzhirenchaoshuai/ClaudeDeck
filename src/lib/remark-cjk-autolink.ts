// remark 插件：修正 GFM 裸网址识别把紧跟的中文吞进链接的问题。
// GFM 只在空白处结束裸网址，“http://127.0.0.1:8199。它和你”会整段变成链接；
// 这里在第一个中文字符或全角标点处截断，后面的部分还原成普通文字。

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// 中日韩文字、全角标点、中文引号和省略号；网址里不会合法出现这些字符
const CJK_RE = /[‘-‟…　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

/** 裸网址识别出的链接：只有一段文字，且文字就是网址本身（www. 开头的会补上 http://） */
function autolinkText(node: MdNode): string | undefined {
  if (node.type !== 'link' || node.children?.length !== 1) return undefined;
  const child = node.children[0];
  if (child.type !== 'text' || !child.value) return undefined;
  const text = child.value;
  return node.url === text || node.url === `http://${text}` || node.url === `mailto:${text}` ? text : undefined;
}

export function splitCjkAutolinks(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const text = autolinkText(child);
    const cut = text ? text.search(CJK_RE) : -1;
    if (text && cut > 0) {
      const prefix = child.url!.slice(0, child.url!.length - text.length);
      child.url = prefix + text.slice(0, cut);
      child.children = [{ type: 'text', value: text.slice(0, cut) }];
      children.splice(i + 1, 0, { type: 'text', value: text.slice(cut) });
      i++;
    } else if (text && cut === 0) {
      // 整段都不是网址：还原成文字
      children[i] = { type: 'text', value: text };
    } else {
      splitCjkAutolinks(child);
    }
  }
}

export default function remarkCjkAutolink() {
  return (tree: MdNode) => splitCjkAutolinks(tree);
}
