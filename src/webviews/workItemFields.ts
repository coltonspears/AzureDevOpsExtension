/**
 * Pure logic that turns a work item plus its type metadata into an editable form model,
 * and turns form edits back into a JSON Patch document.
 */
import { JsonPatchOperation, WorkItem, WorkItemField, WorkItemRelation, WorkItemStateColor, WorkItemTypeField } from '../api/types';
import { FieldKind, FieldModel, RelationModel, RichFieldModel } from '../shared/messages';
import { identityName, identityUniqueName } from '../util/format';

/** Fields shown (when the type has them) in this order. */
export const CURATED_FIELDS = [
  'System.State',
  'System.Reason',
  'System.AssignedTo',
  'System.AreaPath',
  'System.IterationPath',
  'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Common.Severity',
  'Microsoft.VSTS.Common.ValueArea',
  'Microsoft.VSTS.Common.Activity',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Scheduling.Effort',
  'Microsoft.VSTS.Scheduling.Size',
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.CompletedWork',
  'Microsoft.VSTS.Common.BusinessValue',
  'Microsoft.VSTS.Common.TimeCriticality',
  'Microsoft.VSTS.Common.Risk',
  'Microsoft.VSTS.Scheduling.StartDate',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Microsoft.VSTS.Scheduling.DueDate',
  'Microsoft.VSTS.Build.FoundIn',
  'Microsoft.VSTS.Build.IntegrationBuild',
  'System.Tags',
];

export const RICH_FIELDS = [
  'Microsoft.VSTS.TCM.ReproSteps',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.SystemInfo',
];

/** Fields managed by Azure DevOps or shown elsewhere in the form. */
const EXCLUDED = new Set([
  'System.Title',
  'System.Id',
  'System.Rev',
  'System.WorkItemType',
  'System.TeamProject',
  'System.CreatedBy',
  'System.CreatedDate',
  'System.ChangedBy',
  'System.ChangedDate',
  'System.History',
  'System.BoardColumn',
  'System.BoardColumnDone',
  'System.BoardLane',
]);

export interface FormContext {
  typeFields: WorkItemTypeField[];
  definitions: Map<string, WorkItemField>;
  states: WorkItemStateColor[];
  areas: string[];
  iterations: string[];
}

export function fieldValueToString(value: unknown, kind: FieldKind): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (kind === 'identity') {
    const name = identityName(value);
    const unique = identityUniqueName(value);
    return unique && unique !== name ? `${name} <${unique}>` : name;
  }
  if (kind === 'date' && typeof value === 'string') {
    return localDate(value);
  }
  return String(value);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Date fields are stored as UTC timestamps. Like the Azure DevOps web UI, show the calendar
 * date in the local time zone and save the local midnight of the chosen date.
 */
export function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localMidnightIso(day: string): string {
  // Date-time strings without an offset are parsed as local time.
  return new Date(`${day}T00:00:00`).toISOString();
}

function kindFor(refName: string, definition: WorkItemField | undefined, typeField: WorkItemTypeField): FieldKind {
  if (refName === 'System.Reason' || definition?.readOnly) {
    return 'readonly';
  }
  if (refName === 'System.State' || refName === 'System.AreaPath' || refName === 'System.IterationPath') {
    return 'select';
  }
  if (refName === 'System.Tags') {
    return 'tags';
  }
  if (definition?.isIdentity || definition?.type === 'identity') {
    return 'identity';
  }
  if (typeField.allowedValues?.length || definition?.type === 'boolean') {
    return 'select';
  }
  switch (definition?.type) {
    case 'integer':
    case 'double':
      return 'number';
    case 'dateTime':
      return 'date';
    default:
      return 'text';
  }
}

export function buildFieldModels(item: WorkItem, context: FormContext): { fields: FieldModel[]; rich: RichFieldModel[] } {
  const byRef = new Map(context.typeFields.map(f => [f.referenceName, f]));
  const chosen: string[] = CURATED_FIELDS.filter(ref => byRef.has(ref));
  for (const field of context.typeFields) {
    const ref = field.referenceName;
    if (chosen.includes(ref) || EXCLUDED.has(ref) || RICH_FIELDS.includes(ref)) {
      continue;
    }
    const definition = context.definitions.get(ref);
    const isCustom = ref.startsWith('Custom.');
    if ((field.alwaysRequired || isCustom) && definition?.type !== 'html' && !definition?.readOnly) {
      chosen.push(ref);
    }
  }

  const fields = chosen.map((ref): FieldModel => {
    const typeField = byRef.get(ref)!;
    const definition = context.definitions.get(ref);
    const kind = kindFor(ref, definition, typeField);
    let options: string[] | undefined;
    if (ref === 'System.State') {
      options = context.states.map(s => s.name);
    } else if (ref === 'System.AreaPath') {
      options = context.areas;
    } else if (ref === 'System.IterationPath') {
      options = context.iterations;
    } else if (definition?.type === 'boolean') {
      options = ['True', 'False'];
    } else if (typeField.allowedValues?.length) {
      options = typeField.allowedValues;
    }
    const value = fieldValueToString(item.fields[ref], kind);
    if (options && value && !options.includes(value)) {
      options = [value, ...options];
    }
    return {
      refName: ref,
      name: typeField.name || definition?.name || ref,
      kind,
      value,
      options,
      required: typeField.alwaysRequired,
      help: typeField.helpText,
    };
  });

  const richRefs = [
    ...RICH_FIELDS.filter(ref => byRef.has(ref)),
    ...context.typeFields
      .filter(f => f.referenceName.startsWith('Custom.') && context.definitions.get(f.referenceName)?.type === 'html')
      .map(f => f.referenceName),
  ];
  const rich = richRefs.map(ref => ({
    refName: ref,
    name: byRef.get(ref)?.name ?? ref,
    html: String(item.fields[ref] ?? ''),
  }));
  return { fields, rich };
}

/**
 * Converts form edits into JSON Patch operations. A `test` on the revision makes the save
 * fail instead of overwriting someone else's concurrent change.
 */
export function buildPatch(
  item: WorkItem,
  changes: Record<string, string>,
  definitions: Map<string, WorkItemField>,
): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [{ op: 'test', path: '/rev', value: item.rev }];
  for (const [ref, raw] of Object.entries(changes)) {
    const type = definitions.get(ref)?.type;
    const path = `/fields/${ref}`;
    const hadValue = item.fields[ref] !== undefined && item.fields[ref] !== null && item.fields[ref] !== '';
    if (raw === '') {
      if (hadValue) {
        operations.push(type === 'string' || type === 'html' || type === 'plainText' || !type ? { op: 'add', path, value: '' } : { op: 'remove', path });
      }
      continue;
    }
    let value: unknown = raw;
    if (type === 'integer') {
      value = Number.parseInt(raw, 10);
    } else if (type === 'double') {
      value = Number.parseFloat(raw);
    } else if (type === 'boolean') {
      value = raw.toLowerCase() === 'true';
    } else if (type === 'dateTime' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      value = localMidnightIso(raw);
    }
    if (typeof value === 'number' && Number.isNaN(value)) {
      throw new Error(`"${raw}" is not a valid number for ${definitions.get(ref)?.name ?? ref}`);
    }
    operations.push({ op: 'add', path, value });
  }
  return operations;
}

const LINK_KINDS: Record<string, RelationModel['kind']> = {
  'System.LinkTypes.Hierarchy-Reverse': 'parent',
  'System.LinkTypes.Hierarchy-Forward': 'child',
  'System.LinkTypes.Related': 'related',
};

export const RELATION_TYPES = {
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  related: 'System.LinkTypes.Related',
} as const;

/** Classifies a work item's relations into links the form can show and act on. */
export function describeRelations(relations: WorkItemRelation[] | undefined): RelationModel[] {
  return (relations ?? []).map((relation, index): RelationModel => {
    const workItemId = /\/workItems\/(\d+)$/i.exec(relation.url)?.[1];
    const name = relation.attributes?.name ?? relation.rel;
    if (workItemId) {
      return {
        index,
        kind: LINK_KINDS[relation.rel] ?? 'other',
        label: name,
        workItemId: Number(workItemId),
      };
    }
    if (relation.rel === 'ArtifactLink') {
      const decoded = decodeURIComponent(relation.url);
      const pr = /vstfs:\/\/\/Git\/PullRequestId\/[^/]+\/[^/]+\/(\d+)/i.exec(decoded);
      if (pr) {
        return { index, kind: 'pullRequest', label: 'Pull Request', pullRequestId: Number(pr[1]), title: `Pull request !${pr[1]}` };
      }
      const branch = /vstfs:\/\/\/Git\/Ref\/[^/]+\/[^/]+\/GB(.+)$/i.exec(decoded);
      if (branch) {
        return { index, kind: 'branch', label: 'Branch', title: branch[1] };
      }
      const commit = /vstfs:\/\/\/Git\/Commit\/[^/]+\/[^/]+\/([0-9a-f]{7,40})/i.exec(decoded);
      if (commit) {
        return { index, kind: 'commit', label: name, title: commit[1].slice(0, 8) };
      }
      return { index, kind: 'other', label: name, title: decoded };
    }
    if (relation.rel === 'Hyperlink') {
      return { index, kind: 'hyperlink', label: 'Hyperlink', url: relation.url, title: relation.attributes?.comment || relation.url };
    }
    return { index, kind: 'other', label: name, title: relation.url };
  });
}
