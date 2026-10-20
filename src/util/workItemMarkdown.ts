import { WorkItem } from '../api/types';
import { htmlToText, identityName } from './format';

/** Builds a Markdown summary of a work item, handy as context for an AI chat. */
export function workItemMarkdown(item: WorkItem, webUrl: string, comments: { author: string; text: string }[] = []): string {
  const f = item.fields;
  const lines = [`# ${f['System.WorkItemType']} ${item.id}: ${f['System.Title']}`, ''];
  const meta: [string, unknown][] = [
    ['State', f['System.State']],
    ['Assigned to', identityName(f['System.AssignedTo']) || 'Unassigned'],
    ['Area', f['System.AreaPath']],
    ['Iteration', f['System.IterationPath']],
    ['Priority', f['Microsoft.VSTS.Common.Priority']],
    ['Tags', f['System.Tags']],
    ['Link', webUrl],
  ];
  for (const [label, value] of meta) {
    if (value !== undefined && value !== null && value !== '') {
      lines.push(`- **${label}:** ${value}`);
    }
  }
  const sections: [string, string][] = [
    ['Description', 'System.Description'],
    ['Repro Steps', 'Microsoft.VSTS.TCM.ReproSteps'],
    ['Acceptance Criteria', 'Microsoft.VSTS.Common.AcceptanceCriteria'],
    ['System Info', 'Microsoft.VSTS.TCM.SystemInfo'],
  ];
  for (const [title, ref] of sections) {
    const html = f[ref];
    if (typeof html === 'string' && html.trim()) {
      lines.push('', `## ${title}`, '', htmlToText(html));
    }
  }
  if (comments.length) {
    lines.push('', '## Recent comments', '');
    for (const comment of comments) {
      lines.push(`- **${comment.author}:** ${comment.text.replace(/\n+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}
