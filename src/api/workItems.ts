import { AzureDevOpsClient } from './client';
import {
  ClassificationNode,
  JsonPatchOperation,
  ListResponse,
  QueryHierarchyItem,
  TeamIteration,
  WiqlResult,
  WorkItem,
  WorkItemComment,
  WorkItemCommentList,
  WorkItemField,
  WorkItemStateColor,
  WorkItemType,
  WorkItemTypeCategory,
  WorkItemTypeField,
} from './types';
import { TtlCache } from '../util/cache';

const enc = encodeURIComponent;

/** Fields fetched for list views (trees, quick picks). */
export const LIST_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.AssignedTo',
  'System.TeamProject',
  'System.IterationPath',
  'System.Tags',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
];

export interface ClassificationTrees {
  areas: string[];
  iterations: string[];
}

export class WorkItemsApi {
  private readonly cache = new TtlCache(10 * 60_000);

  constructor(private readonly client: AzureDevOpsClient) {}

  /** Runs a WIQL query and returns matching ids in query order. */
  async queryIds(project: string, wiql: string, top: number, team?: string): Promise<number[]> {
    const scopePath = team ? `${enc(project)}/${enc(team)}` : enc(project);
    const result = await this.client.json<WiqlResult>({
      method: 'POST',
      path: `${scopePath}/_apis/wit/wiql`,
      query: { $top: top },
      body: { query: wiql },
      scope: 'vso.work',
    });
    return wiqlResultIds(result);
  }

  async runSavedQuery(project: string, queryId: string, top: number): Promise<number[]> {
    const result = await this.client.json<WiqlResult>({
      path: `${enc(project)}/_apis/wit/wiql/${enc(queryId)}`,
      query: { $top: top },
      scope: 'vso.work',
    });
    return wiqlResultIds(result);
  }

  /** Fetches work items in batches of 200, preserving the order of `ids`. */
  async getWorkItems(ids: number[], fields: string[] = LIST_FIELDS): Promise<WorkItem[]> {
    const byId = new Map<number, WorkItem>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const result = await this.client.json<ListResponse<WorkItem>>({
        method: 'POST',
        path: '_apis/wit/workitemsbatch',
        body: { ids: chunk, fields, errorPolicy: 'omit' },
        scope: 'vso.work',
      });
      for (const item of result.value) {
        if (item) {
          byId.set(item.id, item);
        }
      }
    }
    return ids.map(id => byId.get(id)).filter((item): item is WorkItem => item !== undefined);
  }

  getWorkItem(id: number): Promise<WorkItem> {
    return this.client.json<WorkItem>({
      path: `_apis/wit/workitems/${id}`,
      query: { $expand: 'all' },
      scope: 'vso.work',
    });
  }

  createWorkItem(project: string, type: string, operations: JsonPatchOperation[]): Promise<WorkItem> {
    return this.client.json<WorkItem>({
      method: 'POST',
      path: `${enc(project)}/_apis/wit/workitems/${enc(`$${type}`)}`,
      body: operations,
      contentType: 'application/json-patch+json',
      scope: 'vso.work_write',
    });
  }

  updateWorkItem(id: number, operations: JsonPatchOperation[]): Promise<WorkItem> {
    return this.client.json<WorkItem>({
      method: 'PATCH',
      path: `_apis/wit/workitems/${id}`,
      body: operations,
      contentType: 'application/json-patch+json',
      scope: 'vso.work_write',
    });
  }

  getTypes(project: string): Promise<WorkItemType[]> {
    return this.cache.get(`types:${project}`, async () => {
      const result = await this.client.json<ListResponse<WorkItemType>>({
        path: `${enc(project)}/_apis/wit/workitemtypes`,
        scope: 'vso.work',
      });
      return result.value;
    });
  }

  /** Work item types that users normally create (excludes hidden types like Code Review Request). */
  async getCreatableTypes(project: string): Promise<WorkItemType[]> {
    const [types, categories] = await Promise.all([
      this.getTypes(project),
      this.cache.get(`categories:${project}`, async () => {
        const result = await this.client.json<ListResponse<WorkItemTypeCategory>>({
          path: `${enc(project)}/_apis/wit/workitemtypecategories`,
          scope: 'vso.work',
        });
        return result.value;
      }),
    ]);
    const hidden = new Set(
      categories
        .filter(c => c.referenceName === 'Microsoft.HiddenCategory')
        .flatMap(c => c.workItemTypes.map(t => t.name)),
    );
    return types.filter(t => !t.isDisabled && !hidden.has(t.name));
  }

  getTypeStates(project: string, type: string): Promise<WorkItemStateColor[]> {
    return this.cache.get(`states:${project}:${type}`, async () => {
      const result = await this.client.json<ListResponse<WorkItemStateColor>>({
        path: `${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states`,
        scope: 'vso.work',
      });
      return result.value;
    });
  }

  getTypeFields(project: string, type: string): Promise<WorkItemTypeField[]> {
    return this.cache.get(`typeFields:${project}:${type}`, async () => {
      const result = await this.client.json<ListResponse<WorkItemTypeField>>({
        path: `${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/fields`,
        query: { $expand: 'allowedValues' },
        scope: 'vso.work',
      });
      return result.value;
    });
  }

  /** All field definitions in the organization (gives each field's data type). */
  getFieldDefinitions(): Promise<Map<string, WorkItemField>> {
    return this.cache.get('fields', async () => {
      const result = await this.client.json<ListResponse<WorkItemField>>({ path: '_apis/wit/fields', scope: 'vso.work' });
      return new Map(result.value.map(f => [f.referenceName, f]));
    });
  }

  async getComments(project: string, id: number): Promise<WorkItemComment[]> {
    const result = await this.client.json<WorkItemCommentList>({
      path: `${enc(project)}/_apis/wit/workItems/${id}/comments`,
      query: { $top: 200, order: 'desc' },
      preview: 3,
      scope: 'vso.work',
    });
    return result.comments;
  }

  addComment(project: string, id: number, html: string): Promise<WorkItemComment> {
    return this.client.json<WorkItemComment>({
      method: 'POST',
      path: `${enc(project)}/_apis/wit/workItems/${id}/comments`,
      body: { text: html },
      preview: 3,
      scope: 'vso.work_write',
    });
  }

  async getQueries(project: string): Promise<QueryHierarchyItem[]> {
    const result = await this.client.json<ListResponse<QueryHierarchyItem>>({
      path: `${enc(project)}/_apis/wit/queries`,
      query: { $depth: 2, $expand: 'minimal' },
      scope: 'vso.work',
    });
    return result.value;
  }

  getQuery(project: string, id: string): Promise<QueryHierarchyItem> {
    return this.client.json<QueryHierarchyItem>({
      path: `${enc(project)}/_apis/wit/queries/${enc(id)}`,
      query: { $depth: 2, $expand: 'minimal' },
      scope: 'vso.work',
    });
  }

  /** Area and iteration paths, formatted the way work item fields store them. */
  getClassificationPaths(project: string): Promise<ClassificationTrees> {
    return this.cache.get(`classification:${project}`, async () => {
      const result = await this.client.json<ListResponse<ClassificationNode>>({
        path: `${enc(project)}/_apis/wit/classificationnodes`,
        query: { $depth: 10 },
        scope: 'vso.work',
      });
      const areas: string[] = [];
      const iterations: string[] = [];
      for (const root of result.value) {
        const target = root.structureType === 'iteration' ? iterations : areas;
        flattenClassification(root, project, target);
      }
      return { areas, iterations };
    });
  }

  async getCurrentIteration(project: string, team?: string): Promise<TeamIteration | undefined> {
    const scopePath = team ? `${enc(project)}/${enc(team)}` : enc(project);
    const result = await this.client.json<ListResponse<TeamIteration>>({
      path: `${scopePath}/_apis/work/teamsettings/iterations`,
      query: { $timeframe: 'current' },
      scope: 'vso.work',
    });
    return result.value[0];
  }

  webUrl(project: string, id: number): string {
    return `${this.client.organization.url}/${enc(project)}/_workitems/edit/${id}`;
  }

  apiUrl(id: number): string {
    return `${this.client.organization.url}/_apis/wit/workItems/${id}`;
  }
}

function flattenClassification(node: ClassificationNode, path: string, into: string[]): void {
  into.push(path);
  for (const child of node.children ?? []) {
    flattenClassification(child, `${path}\\${child.name}`, into);
  }
}

/** Collects work item ids from flat and tree/one-hop query results, without duplicates. */
export function wiqlResultIds(result: WiqlResult): number[] {
  if (result.workItems) {
    return result.workItems.map(w => w.id);
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const relation of result.workItemRelations ?? []) {
    for (const end of [relation.source, relation.target]) {
      if (end && !seen.has(end.id)) {
        seen.add(end.id);
        ids.push(end.id);
      }
    }
  }
  return ids;
}
