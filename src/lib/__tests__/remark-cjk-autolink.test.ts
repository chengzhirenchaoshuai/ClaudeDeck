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

  it('不含中文的网址和手写链接不变', () => {
    expect(html('see https://a.com/x?y=1 ok')).toBe('<p>see <a href="https://a.com/x?y=1">https://a.com/x?y=1</a> ok</p>');
    expect(html('[说明。文字](https://a.com)')).toBe('<p><a href="https://a.com">说明。文字</a></p>');
  });
});
