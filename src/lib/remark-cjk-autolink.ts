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

// GFM 裸网址末尾不算进网址的标点；截断后要按同样规则再去一遍，
// 否则“**http://a.com**。”里的 ** 会留在网址末尾
const TRAILING_PUNCT_RE = /[?!.,:*_~]+$/;

// 截断后网址前后成对的强调标记：** 加粗、* 斜体、~~/~ 删除线
const EMPHASIS_MARKERS: Record<string, string> = { '**': 'strong', '*': 'emphasis', '~~': 'delete', '~': 'delete' };

/** 前一段文字末尾恰好是 marker（再往前不是同一种标记符）时返回去掉标记后的文字 */
function stripTrailingMarker(prev: MdNode | undefined, marker: string): string | undefined {
  if (prev?.type !== 'text' || !prev.value?.endsWith(marker)) return undefined;
  const rest = prev.value.slice(0, -marker.length);
  return rest.endsWith(marker[0]) ? undefined : rest;
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
      let urlText = text.slice(0, cut);
      let tail = text.slice(cut);
      const punct = urlText.match(TRAILING_PUNCT_RE)?.[0] ?? '';
      if (punct && punct.length < urlText.length) {
        urlText = urlText.slice(0, -punct.length);
        tail = punct + tail;
      }
      child.url = prefix + urlText;
      child.children = [{ type: 'text', value: urlText }];

      // 网址前后是成对的强调标记：去掉标记文字，把链接包进对应的强调节点
      const marker = Object.keys(EMPHASIS_MARKERS).find((m) => punct === m);
      const prevRest = marker ? stripTrailingMarker(children[i - 1], marker) : undefined;
      if (marker && prevRest !== undefined) {
        tail = tail.slice(marker.length);
        if (prevRest) children[i - 1].value = prevRest;
        else { children.splice(i - 1, 1); i--; }
        children[i] = { type: EMPHASIS_MARKERS[marker], children: [child] };
      }

      if (tail) {
        children.splice(i + 1, 0, { type: 'text', value: tail });
        i++;
      }
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
