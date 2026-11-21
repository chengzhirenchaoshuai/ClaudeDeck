import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkAutolink from '../remark-cjk-autolink';

// 用真实的 remark-gfm 渲染成 HTML
function html(md: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkCjkAutolink] }, md));
}

describe('remarkCjkAutolink', () => {
  it('裸网址后紧跟中文句号和中文时截断', () => {
    expect(html('软件吧http://127.0.0.1:8199。它和你平时用的')).toBe(
      '<p>软件吧<a href="http://127.0.0.1:8199">http://127.0.0.1:8199</a>。它和你平时用的</p>',
    );
  });

  it('www 开头的裸网址同样截断', () => {
    expect(html('打开 www.example.com，然后')).toBe(
      '<p>打开 <a href="http://www.example.com">www.example.com</a>，然后</p>',
    );
  });

  it('加粗、斜体、删除线包着的网址后紧跟中文时，标记不进网址', () => {
    expect(html('地址：**http://192.168.66.80:9527**。打开')).toBe(
      '<p>地址：<strong><a href="http://192.168.66.80:9527">http://192.168.66.80:9527</a></strong>。打开</p>',
    );
    expect(html('**http://a.com**，逗号')).toBe('<p><strong><a href="http://a.com">http://a.com</a></strong>，逗号</p>');
    expect(html('看*http://a.com*。x')).toBe('<p>看<em><a href="http://a.com">http://a.com</a></em>。x</p>');
    expect(html('~~http://a.com~~。x')).toBe('<p><del><a href="http://a.com">http://a.com</a></del>。x</p>');
  });

  it('截断后网址末尾的英文标点不算进网址', () => {
    expect(html('见http://a.com/x.。然后')).toBe('<p>见<a href="http://a.com/x">http://a.com/x</a>.。然后</p>');
    // 只有结尾标记、前面没有配对的，标记留作文字
    expect(html('见http://a.com**。然后')).toBe('<p>见<a href="http://a.com">http://a.com</a>**。然后</p>');
  });

  it('不含中文的网址和手写链接不变', () => {
    expect(html('see https://a.com/x?y=1 ok')).toBe('<p>see <a href="https://a.com/x?y=1">https://a.com/x?y=1</a> ok</p>');
    expect(html('[说明。文字](https://a.com)')).toBe('<p><a href="https://a.com">说明。文字</a></p>');
  });
});
