/** Formatting helpers shared by the extension host and tests. */

export function relativeTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) {
    return '';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.round((now - then) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? 'ago' : 'from now';
  if (abs < 45) {
    return 'just now';
  }
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let unit = units[0];
  for (const candidate of units) {
    if (abs >= candidate[0]) {
      unit = candidate;
    }
  }
  const value = Math.max(1, Math.round(abs / unit[0]));
  return `${value} ${unit[1]}${value === 1 ? '' : 's'} ${suffix}`;
}

export function duration(start: string | undefined | null, end: string | undefined | null, now = Date.now()): string {
  if (!start) {
    return '';
  }
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return '';
  }
  let seconds = Math.max(0, Math.round((to - from) / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Identity fields come back as objects (newer APIs) or "Name <email>" strings (older ones). */
export function identityName(value: unknown): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.replace(/\s*<[^>]*>\s*$/, '');
  }
  if (typeof value === 'object' && 'displayName' in value) {
    return String((value as { displayName: unknown }).displayName ?? '');
  }
  return String(value);
}

export function identityUniqueName(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return /<([^>]*)>/.exec(value)?.[1];
  }
  if (value && typeof value === 'object' && 'uniqueName' in value) {
    return String((value as { uniqueName: unknown }).uniqueName ?? '') || undefined;
  }
  return undefined;
}

/** Converts HTML from work item fields into readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text (e.g. typed into a comment box) as minimal HTML for rich-text fields. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Escapes a value for use inside a single-quoted WIQL string literal. */
export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Builds a git branch name from a template like `feature/${id}-${title}`. */
export function branchNameFor(template: string, id: number, title: string, type: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  const typeSlug = type.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return template
    .replace(/\$\{id\}/g, String(id))
    .replace(/\$\{title\}/g, slug || 'work-item')
    .replace(/\$\{type\}/g, typeSlug)
    .replace(/\/{2,}/g, '/')
    .replace(/[~^:?*[\\\s]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/\.lock$/, '');
}

/** Finds work item ids referenced like "#123" or "AB#123" in branch names or commit messages. */
export function findWorkItemReferences(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(/(?:AB)?#(\d{1,9})\b/gi)) {
    ids.add(Number(match[1]));
  }
  // Branch names such as feature/1234-fix-login or users/me/1234_thing.
  for (const match of text.matchAll(/(?:^|\/)(\d{2,9})(?=[-_]|$)/g)) {
    ids.add(Number(match[1]));
  }
  return [...ids];
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const LOG_TIMESTAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/gm;

/** Removes the ISO timestamp Azure Pipelines puts at the start of every log line. */
export function stripLogTimestamps(log: string): string {
  return log.replace(LOG_TIMESTAMP, '');
}

/** Folding ranges for `##[group]` … `##[endgroup]` sections of a pipeline log (0-based lines). */
export function logGroupRanges(lines: string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const stack: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes('##[group]')) {
      stack.push(index);
    } else if (line.includes('##[endgroup]')) {
      const start = stack.pop();
      if (start !== undefined && index > start) {
        ranges.push({ start, end: index });
      }
    }
  });
  return ranges;
}

/** Parses "a=1; b=two" into a variables object. */
export function parseVariables(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of text.split(/[;\n]/)) {
    const index = part.indexOf('=');
    if (index > 0) {
      const key = part.slice(0, index).trim();
      if (key) {
        result[key] = part.slice(index + 1).trim();
      }
    }
  }
  return result;
}

/** Humanizes a branch name into a default PR title: "feature/123-fix-login" → "Fix login". */
export function titleFromBranch(branch: string): string {
  const leaf = branch.split('/').pop() ?? branch;
  const words = leaf
    .replace(/^\d+[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}
