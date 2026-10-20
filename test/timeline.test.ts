import { describe, expect, it } from 'vitest';
import { TimelineRecord } from '../src/api/types';
import { buildTimelineTree, timelineIsActive } from '../src/views/timeline';

const record = (id: string, type: string, name: string, parentId: string | null, order = 1, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({
  id,
  type,
  name,
  parentId,
  order,
  state: 'completed',
  result: 'succeeded',
  ...extra,
});

describe('buildTimelineTree', () => {
  it('shows Stage → Job → Task and hides Phase and checkpoint records', () => {
    const tree = buildTimelineTree([
      record('s2', 'Stage', 'Deploy', null, 2),
      record('s1', 'Stage', 'Build', null, 1),
      record('p1', 'Phase', 'Build', 's1'),
      record('j1', 'Job', 'Build job', 'p1'),
      record('t2', 'Task', 'Test', 'j1', 2),
      record('t1', 'Task', 'Restore', 'j1', 1),
      record('c1', 'Checkpoint', 'Checkpoint', 's2'),
      record('c2', 'Checkpoint.Approval', 'Approval', 'c1'),
    ]);
    expect(tree.map(n => n.record.name)).toEqual(['Build', 'Deploy']);
    expect(tree[0].children.map(n => n.record.name)).toEqual(['Build job']);
    expect(tree[0].children[0].children.map(n => n.record.name)).toEqual(['Restore', 'Test']);
    expect(tree[1].children).toEqual([]);
  });

  it('hoists the implicit default stage of single-stage pipelines', () => {
    const tree = buildTimelineTree([
      record('s', 'Stage', '__default', null),
      record('p', 'Phase', 'Job', 's'),
      record('j', 'Job', 'Job', 'p'),
    ]);
    expect(tree.map(n => n.record.type)).toEqual(['Job']);
  });

  it('detects running timelines', () => {
    expect(timelineIsActive([record('j', 'Job', 'Job', null, 1, { state: 'inProgress' })])).toBe(true);
    expect(timelineIsActive([record('j', 'Job', 'Job', null)])).toBe(false);
  });
});
