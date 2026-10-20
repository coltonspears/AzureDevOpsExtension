# Azure DevOps for Cursor

Work with **Azure Boards, Repos and Pipelines** without leaving Cursor (or VS Code). Sign in with a
Personal Access Token (PAT); the extension **verifies which scopes the token actually grants**, shows
you what that unlocks, and marks anything that needs more access with a 🔒 everywhere in the UI.

> Community extension — not affiliated with or endorsed by Microsoft.

## Features

### 🔑 PAT sign-in with verified scopes
- Paste a PAT once; it's stored in your OS keychain through VS Code Secret Storage.
- Right after sign-in, the extension checks every scope it uses and opens the **PAT Access** page:
  which features work, which are locked, and which exact checkbox to enable on the Azure DevOps token page.
- The **Account & Access** view and the status bar show the same summary at all times
  (a status bar entry like `contoso/Web 🔒 2` means two features are locked).
- Access is also learned while you work: if a request is ever rejected for a missing scope, the UI updates
  and tells you how to fix it.
- Edited the scopes of your token in Azure DevOps? Run **Re-check PAT Scopes** — no need to paste it again.
- Multiple organizations (Azure DevOps Services and Azure DevOps Server) with **Switch Organization**.
- The organization and project are detected from your workspace's git remote.

### 📋 Work items
- **Assigned to Me**, **Current Iteration** (per team), **Created by Me**, **Recently Changed** and your
  **saved queries** (My Queries / Shared Queries, including tree queries).
- A full work item editor: title, state, assignee (people search), area/iteration, priority, effort,
  dates, tags, custom fields, rich-text description / repro steps / acceptance criteria, links
  (parent, children, related, pull requests, branches) and discussion. Images in descriptions load with your PAT.
  Saves are conflict-safe: you're warned instead of overwriting someone else's change.
- Quick actions from the tree: change state, assign to me / someone, comment, create child, copy link.
- **Create Work Item** (type → title → done) and **Create Work Item from Selection** (adds the code and its location).
- **Create Branch for Work Item** using a configurable name template (`feature/${id}-${title}`).
- **Copy as Markdown (AI Context)** — paste a work item, its description and recent comments into Cursor chat.
- **Search Work Items** by ID or title words.

### 🔀 Pull requests
- **Created by Me**, **Assigned to Me**, **All Active** and **Recently Completed**, with vote/conflict status icons.
- Expand a pull request to see its changed files; click one for a **side-by-side diff in the editor**.
- **Inline review comments in the diff**: start threads on any line, reply, edit, delete, resolve and reactivate.
- A review page with the description (Markdown), reviewers and votes, policy & status **checks**, linked
  work items, every comment thread, files and commits.
- Vote (approve, approve with suggestions, wait for author, reject, reset), **complete** with merge type /
  delete source branch / complete work items, **auto-complete**, publish or mark as draft, abandon, reactivate,
  edit title & description, add/remove reviewers, link work items.
- **Create Pull Request** from your current branch: repository, source/target branches, title and description
  generated from commits, reviewers, work items detected from `#123` / `AB#123` / branch names, draft and
  auto-complete. Offers to push an unpublished branch and warns if a PR already exists.
- **Check Out Pull Request Branch** into your local clone.

### 🚀 Pipelines & logs
- **Pending Approvals** (approve/reject inline), **Recent Runs**, **My Runs**, **All Pipelines** (by folder) and
  **Classic Releases**.
- Expand a run to see **Stage → Job → Task** with status, duration and error/warning counts.
- Click a step to open its **log in the editor**: syntax highlighted, `##[group]` sections foldable,
  timestamps optional, and **live-refreshing while the step runs**. Running pipelines refresh automatically.
- **Run Pipeline** (branch preset from your checkout, queue-time variables and runtime parameters),
  **Run Again**, **Cancel**, **Retry Failed Jobs**.

### 📦 Repos
- **Clone Repository**, **Open File in Azure Repos** and **Copy Azure Repos Link to Selection** (editor context menu).

## Getting started

1. Install the extension in Cursor: *Extensions* view → `…` → **Install from VSIX…** and pick
   `azure-devops-for-cursor-<version>.vsix` (or run `cursor --install-extension azure-devops-for-cursor-<version>.vsix`).
2. Open the **Azure DevOps** icon in the activity bar and choose **Sign In with PAT**.
3. Pick your organization (detected from your git remote, or type `contoso`, `https://dev.azure.com/contoso`,
   or an Azure DevOps Server collection URL) and paste a PAT. The 🔗 button in the token box opens the
   token page of that organization.
4. Review the **PAT Access** page that opens, then select a project if one wasn't detected.

## PAT scopes

Azure DevOps does not let a token read its own scopes, so the extension verifies each scope with one small,
harmless request. Read scopes use a cheap `GET`; write scopes are tested against targets that cannot exist
(work item `0`, build `0`, the all-zero GUID repository) or with `validateOnly=true`, so **checking never
changes anything in your organization**. A `401` means the scope is missing; anything that got past the scope
check (`2xx`, `400`, `404`, …) means it is granted.

| Feature | Scope on the token page |
| --- | --- |
| View & query work items | Work Items — **Read** |
| Create & edit work items, comments, links | Work Items — **Read & write** |
| View pull requests, diffs, threads, checks; browse & clone repos | Code — **Read** |
| Create, vote on, comment on and complete pull requests | Code — **Read & write** |
| View pipelines, runs, logs and approvals | Build — **Read** |
| Run, cancel, retry pipelines; approve stages | Build — **Read & execute** |
| View classic releases | Release — **Read** |
| Pick projects and teams from a list | Project and Team — **Read** |
| Search people (assignees, reviewers) | Identity — **Read** |

The access page also reports Graph, User Profile, Wiki, Test Management, Packaging, Variable Groups,
Agent Pools and Service Connections, so you can see the full shape of a token at a glance.
Project-level scopes (Build, Release, Wiki, …) are checked once a project is selected.

**Recommended scopes for a new token:** Work Items (Read & write), Code (Read & write),
Build (Read & execute), Release (Read), Project and Team (Read), Identity (Read). A *Full access* token
also works, and is reported as such.

### When access is missing
- Sidebar views whose data you can't read show a 🔒 message with **Edit PAT Scopes**, **Re-check Access**
  and **Use a Different PAT** buttons.
- Toolbar buttons turn into 🔒 versions (e.g. *Create Work Item (requires Work Items: Read & write)*); clicking
  explains exactly what to enable.
- Work item and pull request pages switch to read-only with a banner, and locked buttons show a dashed
  outline and the required scope in their tooltip.
- People search falls back to typing an email address when the Identity scope is missing.

### Security
- The PAT lives in the OS keychain (Secret Storage), is never logged, and is only sent to your organization's
  own hosts. Redirects to other hosts drop the `Authorization` header; authenticated image loading refuses
  URLs outside the organization.
- Content from Azure DevOps (descriptions, comments, Markdown) is sanitized before display, and webviews run
  with a strict Content Security Policy.

## Commands

All commands are in the Command Palette under **Azure DevOps:**. Highlights:

| Command | What it does |
| --- | --- |
| Sign In with Personal Access Token / Update / Sign Out | Manage the token for the current organization |
| Show PAT Access & Scopes / Re-check PAT Scopes | See and refresh what the token can do |
| Switch Organization / Select Project / Select Team | Change what the views show |
| Create Work Item / Create Work Item from Selection / Search Work Items / Open Work Item… | Boards |
| Create Pull Request / Open Pull Request… / Check Out Pull Request Branch | Repos |
| Run Pipeline… | Queue a run with branch, variables and parameters |
| Clone Repository… / Open File in Azure Repos / Copy Azure Repos Link to Selection | Repos |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `azureDevOps.workItems.hiddenStates` | `Closed, Done, Removed, Completed, Cut` | States hidden from the personal and sprint lists |
| `azureDevOps.workItems.maxResults` | `100` | Work items loaded per list (max 200) |
| `azureDevOps.workItems.assignNewToMe` | `true` | Assign new work items to yourself |
| `azureDevOps.workItems.createInCurrentIteration` | `false` | Put new work items in the team's current iteration |
| `azureDevOps.workItems.branchNameTemplate` | `feature/${id}-${title}` | Template for work item branches (`${id}`, `${title}`, `${type}`) |
| `azureDevOps.pullRequests.defaultMergeStrategy` | `squash` | Suggested merge type when completing |
| `azureDevOps.pullRequests.deleteSourceBranch` | `true` | Suggest deleting the source branch |
| `azureDevOps.pullRequests.transitionWorkItems` | `true` | Suggest completing linked work items |
| `azureDevOps.pipelines.refreshIntervalSeconds` | `15` | Auto-refresh for running pipelines (0 = off) |
| `azureDevOps.pipelines.showLogTimestamps` | `false` | Keep the timestamp on every log line |
| `azureDevOps.repos.cloneProtocol` | `https` | `https` or `ssh` for Clone Repository |
| `azureDevOps.server.apiVersion` | `7.0` | REST API version for Azure DevOps Server (`6.0` for Server 2020) |

## Azure DevOps Server

Enter the collection URL (for example `https://tfs.contoso.com/tfs/DefaultCollection`). Everything runs against
that host; set `azureDevOps.server.apiVersion` to match your server. User Profile and Graph scopes are cloud-only
and show as *not verified* on Server.

## Development

```bash
npm install
npm run build        # bundle extension + webviews into dist/
npm run check        # typecheck, lint and unit tests
npm run package      # build azure-devops-for-cursor-<version>.vsix
```

Press <kbd>F5</kbd> in Cursor/VS Code to launch an Extension Development Host (see `.vscode/launch.json`).

```
src/
  api/          REST client (PAT auth, 401 → missing scope vs. dead token), URL parsing, typed APIs
  auth/         scope catalog, non-destructive scope probes, access tracking, sign-in & connections
  views/        sidebar trees (account/access, work items, pull requests, pipelines)
  webviews/     panel hosts (access, work item, pull request, create pull request)
  webview-ui/   browser-side UI for the panels (DOM helpers, sanitizer, Markdown)
  providers/    PR diff content, inline PR comments, pipeline logs
  commands/     command implementations
test/           Vitest unit tests (API shapes, scope probing, sanitizer, activation wiring, …)
```

## Publishing

Cursor installs extensions from [Open VSX](https://open-vsx.org). To publish there:
`npx ovsx publish azure-devops-for-cursor-<version>.vsix -p <open-vsx-token>`.
The same VSIX works in VS Code (`code --install-extension …`) and can be published to the
Visual Studio Marketplace with `npx vsce publish`.
