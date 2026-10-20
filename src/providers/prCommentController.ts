import * as vscode from 'vscode';
import { GitPullRequest, PullRequestComment, PullRequestThread } from '../api/types';
import { Services } from '../services';
import { reportError } from '../util/reportError';
import { GIT_SCHEME, GitFileQuery, parseGitFileUri } from './gitContentProvider';

const CONTROLLER_ID = 'azureDevOps.pullRequestComments';

function isResolved(status: PullRequestThread['status']): boolean {
  return status === 'fixed' || status === 'closed' || status === 'wontFix' || status === 'byDesign';
}

function statusLabel(status: PullRequestThread['status']): string {
  switch (status) {
    case 'fixed':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    case 'wontFix':
      return "Won't fix";
    case 'byDesign':
      return 'By design';
    case 'pending':
      return 'Pending';
    default:
      return 'Active';
  }
}

/** A pull request comment rendered in VS Code's native comment UI. */
class ReviewComment implements vscode.Comment {
  body: vscode.MarkdownString | string;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue: string;
  timestamp?: Date;
  label?: string;
  private savedBody: vscode.MarkdownString | string;

  constructor(
    readonly comment: PullRequestComment,
    readonly thread: ReviewThread,
    currentUserId: string,
  ) {
    this.body = new vscode.MarkdownString(comment.content ?? '');
    this.savedBody = this.body;
    this.author = {
      name: comment.author.displayName,
      iconPath: comment.author.imageUrl ? vscode.Uri.parse(comment.author.imageUrl) : undefined,
    };
    this.contextValue = comment.author.id === currentUserId ? 'own' : 'other';
    this.timestamp = comment.publishedDate ? new Date(comment.publishedDate) : undefined;
    this.label = comment.lastUpdatedDate && comment.lastUpdatedDate !== comment.publishedDate ? 'edited' : undefined;
  }

  startEdit(): void {
    this.savedBody = this.body;
    this.body = typeof this.body === 'string' ? this.body : this.body.value;
    this.mode = vscode.CommentMode.Editing;
  }

  cancelEdit(): void {
    this.body = this.savedBody;
    this.mode = vscode.CommentMode.Preview;
  }
}

interface ReviewThread {
  pr: GitPullRequest;
  threadId?: number;
  vscodeThread: vscode.CommentThread;
}

interface ReviewSession {
  pr: GitPullRequest;
  threads: PullRequestThread[];
  /** VS Code thread objects per document uri. */
  rendered: Map<string, vscode.CommentThread[]>;
}

/**
 * Shows pull request comment threads inline in diff editors and lets reviewers start
 * threads, reply, edit, delete and resolve without leaving the editor.
 */
export class PullRequestCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly sessions = new Map<number, ReviewSession>();
  private readonly threadInfo = new WeakMap<vscode.CommentThread, ReviewThread>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changedEmitter = new vscode.EventEmitter<number>();
  /** Fires with a pull request id after a comment was added or changed from the editor. */
  readonly onDidChangeThreads = this.changedEmitter.event;

  constructor(private readonly services: Services) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Azure DevOps Pull Request');
    this.controller.options = {
      prompt: 'Add a pull request comment (Markdown supported)',
      placeHolder: 'Leave a comment',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        const query = parseGitFileUri(document.uri);
        if (!query?.pullRequestId || !query.objectId) {
          return [];
        }
        return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
      },
    };
    this.disposables.push(
      this.controller,
      this.changedEmitter,
      vscode.workspace.onDidOpenTextDocument(doc => void this.renderDocument(doc.uri)),
      vscode.commands.registerCommand('azureDevOps.prComments.createThread', (reply: vscode.CommentReply) => this.createThread(reply)),
      vscode.commands.registerCommand('azureDevOps.prComments.reply', (reply: vscode.CommentReply) => this.reply(reply)),
      vscode.commands.registerCommand('azureDevOps.prComments.resolve', (thread: vscode.CommentThread) => this.setStatus(thread, 'fixed')),
      vscode.commands.registerCommand('azureDevOps.prComments.reactivate', (thread: vscode.CommentThread) =>
        this.setStatus(thread, 'active'),
      ),
      vscode.commands.registerCommand('azureDevOps.prComments.edit', (comment: ReviewComment) => this.startEdit(comment)),
      vscode.commands.registerCommand('azureDevOps.prComments.saveEdit', (comment: ReviewComment) => this.saveEdit(comment)),
      vscode.commands.registerCommand('azureDevOps.prComments.cancelEdit', (comment: ReviewComment) => this.cancelEdit(comment)),
      vscode.commands.registerCommand('azureDevOps.prComments.delete', (comment: ReviewComment) => this.deleteComment(comment)),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  /** Loads (or reloads) the threads of a pull request and re-renders open diff documents. */
  async load(pr: GitPullRequest, threads?: PullRequestThread[]): Promise<void> {
    const { api } = this.services.connections.require();
    const loaded = threads ?? (await api.git.getThreads(pr));
    const existing = this.sessions.get(pr.pullRequestId);
    existing?.rendered.forEach(list => list.forEach(t => t.dispose()));
    this.sessions.set(pr.pullRequestId, { pr, threads: loaded, rendered: new Map() });
    for (const document of vscode.workspace.textDocuments) {
      await this.renderDocument(document.uri);
    }
  }

  private async renderDocument(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== GIT_SCHEME) {
      return;
    }
    const query = parseGitFileUri(uri);
    if (!query?.pullRequestId) {
      return;
    }
    const session = this.sessions.get(query.pullRequestId);
    if (!session) {
      return;
    }
    const key = uri.toString();
    session.rendered.get(key)?.forEach(t => t.dispose());
    const rendered: vscode.CommentThread[] = [];
    for (const thread of session.threads) {
      const range = this.rangeFor(thread, query);
      if (range) {
        rendered.push(this.renderThread(session.pr, thread, uri, range));
      }
    }
    session.rendered.set(key, rendered);
  }

  private rangeFor(thread: PullRequestThread, query: GitFileQuery): vscode.Range | undefined {
    const context = thread.threadContext;
    if (!context?.filePath || thread.comments.every(c => c.commentType === 'system' || c.isDeleted)) {
      return undefined;
    }
    if (context.filePath.toLowerCase() !== query.path.toLowerCase()) {
      return undefined;
    }
    const start = query.side === 'left' ? context.leftFileStart : context.rightFileStart;
    const end = query.side === 'left' ? context.leftFileEnd : context.rightFileEnd;
    // Threads that only anchor to the other side are shown there.
    if (!start) {
      if (query.side === 'right' && !context.leftFileStart) {
        return new vscode.Range(0, 0, 0, 0); // file-level comment
      }
      return undefined;
    }
    const startLine = Math.max(0, start.line - 1);
    const endLine = Math.max(startLine, (end?.line ?? start.line) - 1);
    return new vscode.Range(startLine, 0, endLine, 0);
  }

  private renderThread(pr: GitPullRequest, thread: PullRequestThread, uri: vscode.Uri, range: vscode.Range): vscode.CommentThread {
    const userId = this.services.connections.connection?.user.id ?? '';
    const vscodeThread = this.controller.createCommentThread(uri, range, []);
    const info: ReviewThread = { pr, threadId: thread.id, vscodeThread };
    this.threadInfo.set(vscodeThread, info);
    vscodeThread.comments = thread.comments
      .filter(c => !c.isDeleted && c.commentType !== 'system')
      .map(c => new ReviewComment(c, info, userId));
    this.applyStatus(vscodeThread, thread.status);
    return vscodeThread;
  }

  private applyStatus(vscodeThread: vscode.CommentThread, status: PullRequestThread['status']): void {
    const resolved = isResolved(status);
    vscodeThread.label = statusLabel(status);
    vscodeThread.contextValue = resolved ? 'resolved' : 'active';
    vscodeThread.canReply = true;
    vscodeThread.collapsibleState = resolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    if ('state' in vscodeThread) {
      vscodeThread.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    }
  }

  private async canWrite(action: string): Promise<boolean> {
    return this.services.access.ensure('vso.code_write', action);
  }

  private async createThread(reply: vscode.CommentReply): Promise<void> {
    const vscodeThread = reply.thread;
    const query = parseGitFileUri(vscodeThread.uri);
    const session = query?.pullRequestId ? this.sessions.get(query.pullRequestId) : undefined;
    if (!query || !session || !reply.text.trim()) {
      return;
    }
    if (!(await this.canWrite('comment on pull requests'))) {
      return;
    }
    const range = vscodeThread.range ?? new vscode.Range(0, 0, 0, 0);
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const position = {
      start: { line: startLine, offset: 1 },
      end: { line: endLine, offset: 1 },
    };
    try {
      const { api } = this.services.connections.require();
      const created = await api.git.createThread(session.pr, reply.text, {
        threadContext: {
          filePath: query.path,
          leftFileStart: query.side === 'left' ? position.start : null,
          leftFileEnd: query.side === 'left' ? position.end : null,
          rightFileStart: query.side === 'left' ? null : position.start,
          rightFileEnd: query.side === 'left' ? null : position.end,
        },
        changeTrackingId: query.changeTrackingId,
        iterationId: query.iterationId,
      });
      const uri = vscodeThread.uri;
      vscodeThread.dispose();
      session.threads.push(created);
      await this.renderDocument(uri);
      this.changedEmitter.fire(session.pr.pullRequestId);
    } catch (error) {
      await reportError(error, 'add the comment', this.services.access);
    }
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    const info = this.threadInfo.get(reply.thread);
    if (!info?.threadId) {
      return this.createThread(reply);
    }
    if (!reply.text.trim() || !(await this.canWrite('reply to comments'))) {
      return;
    }
    try {
      const { api, user } = this.services.connections.require();
      const comment = await api.git.reply(info.pr, info.threadId, reply.text);
      reply.thread.comments = [...reply.thread.comments, new ReviewComment(comment, info, user.id)];
      this.updateCachedThread(info.pr.pullRequestId, info.threadId, t => t.comments.push(comment));
      this.changedEmitter.fire(info.pr.pullRequestId);
    } catch (error) {
      await reportError(error, 'reply', this.services.access);
    }
  }

  private async setStatus(vscodeThread: vscode.CommentThread, status: 'fixed' | 'active'): Promise<void> {
    const info = this.threadInfo.get(vscodeThread);
    if (!info?.threadId || !(await this.canWrite(status === 'fixed' ? 'resolve threads' : 'reactivate threads'))) {
      return;
    }
    try {
      const { api } = this.services.connections.require();
      await api.git.setThreadStatus(info.pr, info.threadId, status);
      this.applyStatus(vscodeThread, status);
      this.updateCachedThread(info.pr.pullRequestId, info.threadId, t => (t.status = status));
      this.changedEmitter.fire(info.pr.pullRequestId);
    } catch (error) {
      await reportError(error, 'update the thread', this.services.access);
    }
  }

  private startEdit(comment: ReviewComment): void {
    comment.startEdit();
    this.touch(comment);
  }

  private cancelEdit(comment: ReviewComment): void {
    comment.cancelEdit();
    this.touch(comment);
  }

  private async saveEdit(comment: ReviewComment): Promise<void> {
    const info = comment.thread;
    const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
    if (!info.threadId || !(await this.canWrite('edit comments'))) {
      return;
    }
    try {
      const { api } = this.services.connections.require();
      await api.git.editComment(info.pr, info.threadId, comment.comment.id, text);
      comment.body = new vscode.MarkdownString(text);
      comment.mode = vscode.CommentMode.Preview;
      comment.label = 'edited';
      this.touch(comment);
      this.updateCachedThread(info.pr.pullRequestId, info.threadId, t => {
        const cached = t.comments.find(c => c.id === comment.comment.id);
        if (cached) {
          cached.content = text;
        }
      });
      this.changedEmitter.fire(info.pr.pullRequestId);
    } catch (error) {
      await reportError(error, 'edit the comment', this.services.access);
    }
  }

  private async deleteComment(comment: ReviewComment): Promise<void> {
    const info = comment.thread;
    if (!info.threadId || !(await this.canWrite('delete comments'))) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
    if (confirm !== 'Delete') {
      return;
    }
    try {
      const { api } = this.services.connections.require();
      await api.git.deleteComment(info.pr, info.threadId, comment.comment.id);
      info.vscodeThread.comments = info.vscodeThread.comments.filter(c => c !== comment);
      if (!info.vscodeThread.comments.length) {
        info.vscodeThread.dispose();
      }
      this.updateCachedThread(info.pr.pullRequestId, info.threadId, t => {
        t.comments = t.comments.filter(c => c.id !== comment.comment.id);
      });
      this.changedEmitter.fire(info.pr.pullRequestId);
    } catch (error) {
      await reportError(error, 'delete the comment', this.services.access);
    }
  }

  /** Reassigning the comments array makes VS Code re-render the thread. */
  private touch(comment: ReviewComment): void {
    const thread = comment.thread.vscodeThread;
    thread.comments = [...thread.comments];
  }

  private updateCachedThread(prId: number, threadId: number, update: (thread: PullRequestThread) => void): void {
    const thread = this.sessions.get(prId)?.threads.find(t => t.id === threadId);
    if (thread) {
      update(thread);
    }
  }
}
