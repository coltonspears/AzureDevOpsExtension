/* Minimal stand-in for the `vscode` module so activation can run under Vitest. */
type Listener<T> = (value: T) => unknown;

const disposable = () => ({ dispose() {} });

/** Returns a callable proxy for APIs the tests do not care about. */
function anything(): unknown {
  const fn = function () {
    return anything();
  };
  return new Proxy(fn, {
    get: (_target, prop) => (prop === 'then' ? undefined : prop === 'dispose' ? () => undefined : anything()),
    apply: () => anything(),
    construct: () => anything() as object,
  });
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
  };
  fire(value: T) {
    this.listeners.forEach(l => l(value));
  }
  dispose() {
    this.listeners = [];
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class TreeItem {
  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}
export class MarkdownString {
  value = '';
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(text: string) {
    this.value += text;
    return this;
  }
}
export class Range {
  constructor(...args: number[]) {
    void args;
  }
}
export class FoldingRange {
  constructor(...args: number[]) {
    void args;
  }
}

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
  file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
  joinPath: (...parts: { toString(): string }[]) => ({ toString: () => parts.map(String).join('/') }),
  from: (parts: Record<string, string>) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
};

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ViewColumn = { Active: -1 };
export const CommentMode = { Editing: 0, Preview: 1 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
export const CommentThreadState = { Unresolved: 0, Resolved: 1 };
export const FoldingRangeKind = { Region: 3 };
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };

export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
export const contexts = new Map<string, unknown>();
export const treeViews: string[] = [];

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    if (registeredCommands.has(id)) {
      throw new Error(`Command ${id} registered twice`);
    }
    registeredCommands.set(id, handler);
    return disposable();
  },
  async executeCommand(id: string, ...args: unknown[]) {
    if (id === 'setContext') {
      contexts.set(String(args[0]), args[1]);
    }
    return undefined;
  },
};

export const window = {
  createTreeView(id: string) {
    treeViews.push(id);
    return { visible: true, description: '', onDidChangeVisibility: () => disposable(), dispose() {} };
  },
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  createOutputChannel: () => ({ info() {}, warn() {}, error() {}, show() {}, dispose() {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  setStatusBarMessage: () => disposable(),
  activeTextEditor: undefined,
};

export const workspace = {
  getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  onDidChangeConfiguration: () => disposable(),
  onDidCloseTextDocument: () => disposable(),
  onDidOpenTextDocument: () => disposable(),
  registerTextDocumentContentProvider: () => disposable(),
  textDocuments: [],
};

export const languages = { registerFoldingRangeProvider: () => disposable() };
export const extensions = { getExtension: () => undefined };
export const comments = {
  createCommentController: () => ({ dispose() {}, createCommentThread: () => anything() }),
};
export const env = { openExternal: async () => true, clipboard: { writeText: async () => undefined } };
