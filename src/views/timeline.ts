import { TimelineRecord } from '../api/types';

export interface TimelineTreeNode {
  record: TimelineRecord;
  children: TimelineTreeNode[];
}

/** Record types that add nesting without information; their children are shown in their place. */
function isHoisted(record: TimelineRecord): boolean {
  return record.type === 'Phase' || (record.type === 'Stage' && record.name === '__default');
}

/** Approval/check bookkeeping; pending approvals are listed separately. */
function isHidden(record: TimelineRecord): boolean {
  return record.type.startsWith('Checkpoint');
}

/**
 * Turns the flat build timeline into Stage → Job → Task, skipping Phase records and the
 * implicit default stage used by single-stage and classic pipelines.
 */
export function buildTimelineTree(records: TimelineRecord[]): TimelineTreeNode[] {
  const byParent = new Map<string, TimelineRecord[]>();
  const ids = new Set(records.map(r => r.id));
  for (const record of records) {
    const parent = record.parentId && ids.has(record.parentId) ? record.parentId : '';
    const siblings = byParent.get(parent) ?? [];
    siblings.push(record);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  }

  const expand = (parentId: string, depth: number): TimelineTreeNode[] => {
    if (depth > 10) {
      return [];
    }
    const result: TimelineTreeNode[] = [];
    for (const record of byParent.get(parentId) ?? []) {
      if (isHidden(record)) {
        continue;
      }
      if (isHoisted(record)) {
        result.push(...expand(record.id, depth + 1));
      } else {
        result.push({ record, children: expand(record.id, depth + 1) });
      }
    }
    return result;
  };
  return expand('', 0);
}

/** True while any part of the timeline is still running or waiting. */
export function timelineIsActive(records: TimelineRecord[]): boolean {
  return records.some(r => r.state === 'inProgress' || (r.state === 'pending' && r.type === 'Job'));
}
