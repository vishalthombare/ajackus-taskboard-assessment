# Frontend and backend code review

Reviewed the current frontend and backend together. Findings are ranked by business impact; the two critical backend security flaws come first, followed by frontend confidentiality and data-loss bugs.

**Backend URL:** `http://127.0.0.1:8000/`.

**Scope:** The four reviewed issues are fixed. Issues #1–#3 are committed; issue #4 is fixed in the working tree and remains uncommitted pending approval.

## 1. SQL injection in task search exposes other projects' tasks

- **Area:** Backend
- **File and lines:** [projects/views.py:104–121](projects/views.py#L104), `TaskListCreateView.get`.
- **Category:** Security
- **Severity:** Critical
- **Status:** Fixed using a parameterized ORM query restricted to the requested project.
- **Description:** Before the fix, the search query parameter `q` was inserted directly into SQL, allowing a project member or viewer to change the query's meaning after the membership check. A user could search their own project and retrieve tasks belonging to a private project they could not access; additional database impact depended on the SQL accepted and the application's database privileges. This ranks first because attacker-controlled SQL compromised the database access boundary and task confidentiality across projects.
- **Recommended fix:** Replace the raw SQL with a project-scoped ORM queryset using `Q(title__icontains=q) | Q(description__icontains=q)`, and serialize results through `TaskSerializer`. Add PostgreSQL-backed tests for injection payloads, apostrophes, ordinary searches, and two-project isolation.
- **Verification:** Confirmed with curl against the running PostgreSQL-backed application on port 8000. The request was deliberately constrained to one temporary private task; no unrelated task data was requested.

### Before and after fix: identical curl request

The retained review fixture uses Meera (`meera@taskboard.dev`) as the attacker. Meera is an admin of search project `c4ba269e-141b-472d-a820-bc5f89a8880f` but has no membership in private project `c45e1503-8a87-45d5-8e20-6f9a1b293eb2`, which owns task `d6ec5d9a-132b-4560-a53c-a6a86eedf810`.

These are the current review fixture IDs, retained so the request can be repeated. Earlier temporary fixture IDs were deleted and should not be reused.

Set a current Meera token (no spaces around `=`):

```bash
OUTSIDER_TOKEN="paste_current_meera_token_here"
SEARCH_PROJECT_ID="c4ba269e-141b-472d-a820-bc5f89a8880f"
PRIVATE_TASK_ID="d6ec5d9a-132b-4560-a53c-a6a86eedf810"
```

**Before fix — command:**

```bash
curl -sS -G -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$SEARCH_PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  --data-urlencode "q=zznomatch') OR (id = '$PRIVATE_TASK_ID') -- "
```

**Before fix — actual response:**

```json
{
  "tasks": [
    {
      "id": "d6ec5d9a-132b-4560-a53c-a6a86eedf810",
      "project_id": "c45e1503-8a87-45d5-8e20-6f9a1b293eb2",
      "title": "SQL review private task",
      "description": null,
      "status": "todo",
      "assignee_id": null,
      "created_by_id": "ed062f69-9fa5-4d77-ab74-1bc60f81c011",
      "position": 0,
      "created_at": "2026-10-14T13:05:13.910309Z",
      "updated_at": "2026-10-14T13:05:13.910322Z"
    }
  ]
}
```

```text
HTTP 200
```

The returned task belongs to a different project, confirming that the injected OR condition bypassed the project filter.

**After fix — the same command:**

```bash
curl -sS -G -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$SEARCH_PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  --data-urlencode "q=zznomatch') OR (id = '$PRIVATE_TASK_ID') -- "
```

**After fix — actual response from port 8000:**

```text
{"tasks":[]}
HTTP 200
```

HTTP 200 is expected: the endpoint accepts the search as literal text, finds no matching task in Meera's project, and returns an empty list. The private task is not returned.

### Fix details

Replaced string-interpolated SQL with a project-scoped `Task` queryset filtered by `Q(title__icontains=q) | Q(description__icontains=q)`. Django passes search values as parameters and escapes LIKE wildcard characters, keeping input separate from SQL syntax. Both search and ordinary listing now use `TaskSerializer`, preserving nested assignee data; the existing search position ordering, ordinary list ordering, and membership checks remain in place.

### Regression tests

[projects/tests.py:161–224](projects/tests.py#L161) adds 17 search cases covering targeted and broad SQL injection, apostrophes, case-insensitive title and description matches, literal `%`/`_`/backslash characters, project isolation, all membership roles, empty searches, anonymous requests, and outsiders. It also checks that search returns the same task fields as the regular task list.

Before the fix, both injection regression cases failed on PostgreSQL by exposing private tasks. After the fix, the complete backend suite passed on PostgreSQL in an isolated temporary schema; the schema was removed afterward. The same 34 tests also passed against in-memory SQLite.

Standard test command, using a PostgreSQL connection with permission to create a separate Django test database:

```bash
python -m pytest -q
```

## 2. Task updates have no project membership or role check

- **Area:** Backend, reachable from the frontend task editor
- **File and lines:** [projects/views.py:155–181](projects/views.py#L155), `TaskDetailView.patch`.
- **Category:** Security
- **Severity:** Critical
- **Status:** Fixed with backend permission checks and read-only frontend controls.
- **Description:** Before the fix, PATCH loaded any task by UUID and saved changes without checking whether the authenticated user belonged to its project or had an editing role. An outsider with a task UUID could change its title, description, status, or assignee and receive its details; a viewer could also edit despite having a read-only role. This allowed users to corrupt another team's work and bypass project access controls.
- **Recommended fix:** Require membership in the task's project and an `admin` or `member` role before processing update fields, reusing the existing creation/deletion policy. Return 403 for outsiders and viewers and test that denied requests leave every task field and the update timestamp unchanged, while admins and members can still edit.
- **Implemented fix:** Added `_get_membership(request.user, task.project_id)` and `_can_edit_tasks(membership.role)` checks before reading or applying update fields. Outsiders receive `{"error":"forbidden"}`; viewers receive `{"error":"viewers cannot update tasks"}`; both return HTTP 403.

### Before and after fix: identical curl request

Use the same retained review task and a current Meera login token. Meera is an admin of the search project from issue #1 but has no membership in this task's private project.

```bash
OUTSIDER_TOKEN="paste_current_meera_token_here"
PRIVATE_TASK_ID="d6ec5d9a-132b-4560-a53c-a6a86eedf810"
```

**Before fix — command:**

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X PATCH \
  "http://127.0.0.1:8000/api/tasks/$PRIVATE_TASK_ID" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Changed by outsider"}'
```

**Before fix — actual response:**

```json
{
  "task": {
    "id": "d6ec5d9a-132b-4560-a53c-a6a86eedf810",
    "project_id": "c45e1503-8a87-45d5-8e20-6f9a1b293eb2",
    "title": "Changed by outsider",
    "description": null,
    "status": "todo",
    "assignee_id": null,
    "created_by_id": "ed062f69-9fa5-4d77-ab74-1bc60f81c011",
    "position": 0,
    "created_at": "2026-10-14T13:05:13.910309Z",
    "updated_at": "2026-10-14T13:16:42.993277Z",
    "assignee": null
  }
}
```

```text
HTTP 200
```

A database read confirmed that the task changed. The review task's original title and timestamp were then restored before verifying the fix.

**After fix — the same command:**

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X PATCH \
  "http://127.0.0.1:8000/api/tasks/$PRIVATE_TASK_ID" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Changed by outsider"}'
```

**After fix — actual response from port 8000:**

```text
{"error":"forbidden"}
HTTP 403
```

A database read confirmed that the task title and update timestamp remained unchanged.

### Regression tests

[projects/tests.py:102–158](projects/tests.py#L102) adds seven cases: outsiders (including admins of another project), viewers, members, admins, anonymous requests, missing tasks, and permission checks before processing malformed input. Denied requests must not reveal task details or change title, description, status, assignee, or update timestamp.

Before the fix, the role matrix produced **2 failed, 2 passed**: outsiders and viewers incorrectly received HTTP 200. After the fix, the complete backend suite passed **41 tests** using an isolated in-memory SQLite database; the live curl check above also verified the fix against the PostgreSQL-backed server.

The frontend task editor now resolves the signed-in user's role from the project memberships in [../frontend/src/components/TaskDetail.tsx:16](../frontend/src/components/TaskDetail.tsx#L16). Viewers and users without a matching membership receive a read-only editor with disabled title, description, status, assignee, Save, and Delete controls; admins and members retain editing and deletion. The Add button and new-task title/status fields on the project page are also disabled for viewers, with a submit guard preventing creation requests. The backend still enforces the permission boundary independently of these controls.

[../frontend/src/tests/TaskDetail.permissions.test.tsx](../frontend/src/tests/TaskDetail.permissions.test.tsx) adds seven cases covering viewer and missing-membership denial, matching the current user rather than another admin, and successful Save/Delete actions for both admins and members. All **16 frontend tests passed**. Source type checking passed with `tsc --noEmit --skipLibCheck`; the full TypeScript check is blocked by pre-existing dependency declaration errors, including missing Node/Jest types.

## 3. Switching accounts retains the previous user's private project cache

- **Area:** Frontend
- **Files and lines:** [../frontend/src/components/Header.tsx:14–16](../frontend/src/components/Header.tsx#L14); [../frontend/src/lib/api-client.ts:24–33](../frontend/src/lib/api-client.ts#L24); [../frontend/src/main.tsx:6–11](../frontend/src/main.tsx#L6); [../frontend/src/pages/DashboardPage.tsx:24–26](../frontend/src/pages/DashboardPage.tsx#L24); [../frontend/src/pages/ProjectPage.tsx:25–27](../frontend/src/pages/ProjectPage.tsx#L25).
- **Category:** Security
- **Severity:** High
- **Status:** Fixed in commit `dece380`.
- **Description (before fix):** Logout removes localStorage credentials but leaves the application-wide React Query cache intact, while project query keys contain no user identity. When another account signs in in the same tab, its initial dashboard can render the previous user's cached private project names and descriptions before the new request finishes. Cached project details can similarly expose tasks and member emails if the same project URL is opened; backend permission checks do not remove data already retained in the browser.
- **Recommended fix:** Cancel outstanding queries and clear cached queries and mutations on logout and account changes, and scope private query keys by the authenticated user's ID. Add a frontend test that loads account A's private data, signs out and signs in as B, delays or rejects B's request, and asserts A's data is never rendered.
- **Verification:** Reproduced using the actual `setSession`/`clearSession` source and the installed TanStack query library in Node: after caching A's projects, signing out, and signing in as B, a new observer for `['projects']` immediately returned A's cached data. This was a library/state reproduction, not a browser screenshot test.

Actual output:

```text
Account B initial dashboard data: {"projects":[{"id":"private","name":"Account A private project"}]}
```

**UI check:** In the same tab, sign in as A and load private projects, sign out, then sign in as B without reloading the page. Throttle the dashboard request to observe the stale project cards; opening A's previously visited project URL can show its cached details while the request is pending or fails.

### After fix

Both sign-in and logout now cancel pending queries and clear the shared query and mutation caches through [../frontend/src/lib/query-client.ts:5](../frontend/src/lib/query-client.ts#L5). Private query keys and mutation invalidation include the current user's ID, and fetch receives cancellation signals. Six cases in [../frontend/src/tests/SessionPrivacy.test.tsx](../frontend/src/tests/SessionPrivacy.test.tsx) verify cache cleanup, pending request cancellation, delayed/denied account B requests, and revisiting account A's private project URL without displaying its cached data.

Before the fix, account B's initial cache result contained account A's private project, as recorded above. After the fix, the routed React tests confirm account A's project, task, and member email are absent after switching accounts. These six regression cases remain part of the passing frontend suite.

**UI check after fix:** Repeat the same account switch without refreshing, with a slow network. Account B should see loading or a permission error without account A's cached private content.

## 4. Saving an assigned task silently clears its assignee

- **Area:** Frontend/backend API contract
- **Files and lines:** [projects/serializers.py:8–25](projects/serializers.py#L8); [../frontend/src/types/index.ts:10–20](../frontend/src/types/index.ts#L10); [../frontend/src/components/TaskDetail.tsx:24](../frontend/src/components/TaskDetail.tsx#L24) and [lines 47–55](../frontend/src/components/TaskDetail.tsx#L47). The fix maps responses in [../frontend/src/lib/task-api.ts:21–58](../frontend/src/lib/task-api.ts#L21) and connects project loading in [../frontend/src/pages/ProjectPage.tsx:27–34](../frontend/src/pages/ProjectPage.tsx#L27).
- **Category:** Data Integrity
- **Severity:** High
- **Status:** Fixed in the working tree; not committed.
- **Description:** Before the fix, the backend returned `assignee_id`, but the frontend read `task.assigneeId` from untransformed JSON. Opening an assigned task therefore initialized its assignee selection to empty, and saving a title or description edit sent `assigneeId: null`, removing the original assignment. This silently changed task ownership during an otherwise unrelated edit.
- **Recommended fix:** Explicitly map backend response DTOs to frontend objects, including nested task/project IDs and timestamps, and use those adapters for loading, creation, and updates. Add a task-editor regression test using real backend-shaped JSON that edits only the title and checks the assignee survives saving and reloading, plus tests for deliberate assignment changes.
- **Implemented fix:** Added typed response adapters for project detail, task creation, and task updates. They convert `assignee_id`, `project_id`, `created_by_id`, `owner_id`, `created_at`, and `updated_at` to the frontend's camelCase fields, including tasks nested in project responses; requests continue to send `assigneeId`. No backend response fields or existing API contracts were changed.

### Before fix

The seven new regression cases use a backend-shaped fetch fixture with an assigned task:

```json
{"id":"t1","project_id":"p1","assignee_id":"u2"}
```

With the original editor, the assignee selector was empty. A title-only edit generated this assignment value in the save payload:

```json
{"title":"Updated title","assigneeId":null}
```

The simulated backend persisted null. Reopening a task after an intentional reassignment also showed an empty selector. Running the tests before connecting the adapters produced:

```text
Tests: 3 failed | 4 passed (7)
```

The failing cases were existing-assignee initialization, preservation through a title-only save/reload, and displaying an intentional reassignment after reload. The earlier live curl reproduction also confirmed that sending the UI's null assignment payload cleared the persisted database assignment; the latest regression evidence above uses an isolated fetch fixture and does not modify application records.

### After fix

The editor receives `assigneeId: "u2"` from the mapped response. The same title-only action now saves the original assignment:

```json
{"title":"Updated title","assigneeId":"u2"}
```

After saving and refetching the project, the selector still shows the original assignee. Intentionally selecting `unassigned` still sends null, and intentionally selecting another member persists and displays that member after reload.

[../frontend/src/tests/TaskAssignment.test.tsx](../frontend/src/tests/TaskAssignment.test.tsx) covers these round trips through the real API client, project page, and task editor with mocked backend responses, plus project/task ID and timestamp mapping and null assignments in creation/update responses.

Actual result after the fix:

```text
TaskAssignment.test.tsx: 7 passed
Test Files: 5 passed
Tests: 29 passed
```

Application source type checking passed with `tsc --noEmit --skipLibCheck`. The full TypeScript check still has the pre-existing dependency declaration errors documented under issue #2.

**Manual UI check:** Sign in as an admin/member, open an assigned task, edit only its title, save, then reopen it. The original assignee should still be selected. Repeat with an intentional reassignment and with `unassigned` to confirm both changes persist.

## Part 2 — Completed fix
Issue #1 is fixed with a parameterized, project-scoped ORM search. The before/after curl evidence and regression coverage are recorded above. Issue #2 is also fixed, with backend permission enforcement, disabled viewer controls, regression tests, and its own before/after evidence above. Issue #3 is committed with cache isolation and privacy regression tests. Issue #4 is also fixed with explicit response mapping and assignment regression tests; it remains uncommitted pending approval.
