// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';

type Lib = typeof import('../src/webview-ui/lib');
let lib: Lib;

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage() {},
    getState() {},
    setState() {},
  });
  lib = await import('../src/webview-ui/lib');
});

describe('sanitizeHtml', () => {
  it('drops scripts, event handlers and dangerous URLs', () => {
    const html = lib.sanitizeHtml(
      '<p onclick="steal()">Hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)"><object data="https://e.com/x.swf"></object><form action="https://e.com"><input name="p"></form>',
    );
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|object|form/i);
    expect(html).toContain('<p>Hi</p>');
  });

  it('keeps formatting and safe links', () => {
    const html = lib.sanitizeHtml('<b>bold</b> <a href="https://dev.azure.com">link</a> <code class="language-ts">x</code>');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('href="https://dev.azure.com"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('class="language-ts"');
  });

  it('unwraps unknown tags but keeps their text', () => {
    expect(lib.sanitizeHtml('<custom-el>text</custom-el>')).toBe('text');
  });

  it('removes styles that can load resources', () => {
    expect(lib.sanitizeHtml('<span style="background:url(https://e.com/t.png)">x</span>')).toBe('<span>x</span>');
    expect(lib.sanitizeHtml('<span style="color:red">x</span>')).toBe('<span style="color:red">x</span>');
  });

  it('defers organization images so they can be loaded with the PAT', () => {
    lib.setOrganization('https://dev.azure.com/contoso', 'contoso');
    const html = lib.sanitizeHtml('<img src="https://dev.azure.com/contoso/_apis/wit/attachments/1"><img src="https://cdn.example.com/a.png">');
    expect(html).toContain('data-src="https://dev.azure.com/contoso/_apis/wit/attachments/1"');
    expect(html).toContain('src="https://cdn.example.com/a.png"');
  });

  it('renders markdown safely', () => {
    const html = lib.renderMarkdown('**hi** <img src=x onerror=alert(1)>\n\n```\ncode\n```');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toContain('<pre>');
    expect(html).not.toContain('onerror');
  });
});
