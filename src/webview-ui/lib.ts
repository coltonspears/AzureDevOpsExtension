/* Tiny UI toolkit shared by the webview bundles (runs in the browser). */
import MarkdownIt from 'markdown-it';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post<T extends { type: string }>(message: T): void {
  vscode.postMessage(message);
}

export function onMessage<T extends { type: string }>(handler: (message: T) => void): void {
  window.addEventListener('message', event => handler(event.data as T));
}

// ---------------------------------------------------------------------------------------
// DOM building

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      element.className = String(value);
    } else if (key === 'value' && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      element.value = String(value);
    } else if (key === 'checked' && element instanceof HTMLInputElement) {
      element.checked = Boolean(value);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function icon(name: string, extra = ''): HTMLElement {
  return h('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function button(
  label: Child,
  onClick: () => void,
  options: { icon?: string; kind?: 'primary' | 'secondary' | 'link' | 'danger'; title?: string; disabled?: boolean; locked?: boolean } = {},
): HTMLElement {
  const kind = options.kind ?? 'secondary';
  return h(
    'button',
    {
      class: `btn btn-${kind}${options.locked ? ' locked' : ''}`,
      title: options.title,
      disabled: options.disabled,
      onclick: (e: Event) => {
        e.preventDefault();
        onClick();
      },
    },
    options.locked ? icon('lock') : options.icon ? icon(options.icon) : null,
    label,
  );
}

/**
 * A button for an action that needs a scope. When the PAT lacks it, the button shows a
 * lock, explains the missing scope in its tooltip, and asks the host to guide the user.
 */
export function gatedButton(
  label: string,
  access: 'granted' | 'denied' | 'unknown',
  scope: { id: string; label: string },
  action: string,
  onClick: () => void,
  options: { icon?: string; kind?: 'primary' | 'secondary' | 'link' | 'danger'; disabled?: boolean; title?: string } = {},
): HTMLElement {
  if (access === 'denied') {
    return button(label, () => post({ type: 'requestAccess', scope: scope.id, action }), {
      ...options,
      locked: true,
      disabled: false,
      title: `Requires the "${scope.label}" PAT scope — click for details`,
    });
  }
  return button(label, onClick, options);
}

// ---------------------------------------------------------------------------------------
// Rendering with focus & scroll preservation

export function mount(render: () => Node): () => void {
  const root = document.getElementById('app')!;
  return () => {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const key = active?.dataset?.key;
    const selection =
      active && 'selectionStart' in active && typeof active.selectionStart === 'number'
        ? [active.selectionStart, active.selectionEnd ?? active.selectionStart]
        : undefined;
    const scroll = window.scrollY;
    root.replaceChildren(render());
    if (key) {
      const next = root.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
      if (next) {
        next.focus();
        if (selection && typeof next.setSelectionRange === 'function') {
          try {
            next.setSelectionRange(selection[0], selection[1]);
          } catch {
            // Not a text input.
          }
        }
      }
    }
    window.scrollTo(0, scroll);
    resolveImages(root);
  };
}

// ---------------------------------------------------------------------------------------
// Busy indicator and toasts

export function installStatus(): void {
  const bar = h('div', { class: 'progress', hidden: true });
  const toast = h('div', { class: 'toast', hidden: true });
  document.body.prepend(bar);
  document.body.append(toast);
  let timer: number | undefined;
  onMessage<{ type: string; busy?: boolean; label?: string; kind?: string; message?: string; url?: string; dataUri?: string }>(m => {
    if (m.type === 'busy') {
      bar.hidden = !m.busy;
      bar.title = m.label ?? '';
      document.body.classList.toggle('busy', Boolean(m.busy));
    } else if (m.type === 'toast') {
      toast.textContent = m.message ?? '';
      toast.className = `toast toast-${m.kind}`;
      toast.hidden = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (toast.hidden = true), 4000);
    } else if (m.type === 'imageResolved' && m.url) {
      imageCache.set(m.url, m.dataUri ?? '');
      for (const img of pendingImages.get(m.url) ?? []) {
        if (m.dataUri) {
          img.src = m.dataUri;
        } else {
          img.classList.add('broken');
        }
      }
      pendingImages.delete(m.url);
    }
  });
  // Open links through the extension so they always go to the external browser.
  document.addEventListener('click', event => {
    const anchor = (event.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (anchor && /^https?:/i.test(anchor.href)) {
      event.preventDefault();
      post({ type: 'openUrl', url: anchor.href });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Images that need the PAT are requested from the extension and inlined as data URIs.

const imageCache = new Map<string, string>();
const pendingImages = new Map<string, HTMLImageElement[]>();
let organizationPrefixes: string[] = [];

/** Tells the toolkit which image URLs belong to the organization (and need the PAT). */
export function setOrganization(url: string, name: string): void {
  const lowerName = name.toLowerCase();
  organizationPrefixes = [
    `${url.toLowerCase()}/`,
    `https://dev.azure.com/${lowerName}/`,
    `https://${lowerName}.visualstudio.com/`,
  ];
}

function needsAuth(src: string): boolean {
  const lower = src.toLowerCase();
  return organizationPrefixes.some(prefix => lower.startsWith(prefix));
}

function resolveImages(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(img => {
    const src = img.dataset.src!;
    const cached = imageCache.get(src);
    if (cached !== undefined) {
      if (cached) {
        img.src = cached;
      } else {
        img.classList.add('broken');
      }
      return;
    }
    const pending = pendingImages.get(src);
    if (pending) {
      pending.push(img);
      return;
    }
    pendingImages.set(src, [img]);
    post({ type: 'resolveImage', url: src });
  });
}

// ---------------------------------------------------------------------------------------
// HTML sanitizing (content from Azure DevOps is untrusted)

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'link', 'meta', 'base', 'frame', 'frameset', 'template', 'noscript']);
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  '*': ['title', 'style', 'align', 'colspan', 'rowspan', 'color'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  code: ['class'],
  ol: ['start'],
};

function safeUrl(value: string, allowData: boolean): string | undefined {
  const trimmed = value.trim();
  if (/^(https?:|mailto:)/i.test(trimmed) || trimmed.startsWith('#')) {
    return trimmed;
  }
  if (allowData && /^data:image\/(png|gif|jpe?g|webp|bmp);/i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

function safeStyle(value: string): string | undefined {
  return /url\s*\(|expression\s*\(|javascript:|@import|position\s*:\s*fixed/i.test(value) ? undefined : value;
}

/** Returns sanitized HTML. Unknown tags are unwrapped; dangerous ones are dropped with their content. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const clean = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (DROPPED_TAGS.has(tag)) {
        element.remove();
        continue;
      }
      clean(element);
      if (!ALLOWED_TAGS.has(tag)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const allowed = new Set([...(ALLOWED_ATTRIBUTES['*'] ?? []), ...(ALLOWED_ATTRIBUTES[tag] ?? [])]);
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (!allowed.has(name)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (name === 'href' || name === 'src') {
          const url = safeUrl(attribute.value, name === 'src');
          if (url === undefined) {
            element.removeAttribute(attribute.name);
          }
        } else if (name === 'style') {
          const style = safeStyle(attribute.value);
          if (style === undefined) {
            element.removeAttribute(attribute.name);
          }
        }
      }
      if (tag === 'img') {
        const src = element.getAttribute('src');
        if (src && needsAuth(src)) {
          element.setAttribute('data-src', src);
          element.removeAttribute('src');
        }
      }
      if (tag === 'a') {
        element.setAttribute('rel', 'noreferrer noopener');
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

export function htmlContent(html: string, className = 'rich'): HTMLElement {
  const container = h('div', { class: className });
  container.innerHTML = sanitizeHtml(html);
  return container;
}

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });

export function renderMarkdown(text: string): string {
  return sanitizeHtml(markdown.render(text));
}

export function markdownContent(text: string, className = 'rich markdown'): HTMLElement {
  const container = h('div', { class: className });
  container.innerHTML = renderMarkdown(text);
  return container;
}

// ---------------------------------------------------------------------------------------
// Misc

export function avatar(name: string): HTMLElement {
  const initials = name
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('');
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return h('span', { class: 'avatar', style: `--hue:${Math.abs(hash) % 360}`, title: name }, initials || '?');
}

export function section(title: Child, ...children: Child[]): HTMLElement {
  return h('section', { class: 'section' }, h('h2', null, title), ...children);
}

export function emptyState(text: string): HTMLElement {
  return h('div', { class: 'empty' }, text);
}
