# Frontend and backend code review

Reviewed the current frontend and backend together. Findings are ranked by business impact; the two critical backend security flaws come first, followed by frontend confidentiality and data-loss bugs.

**Backend URL:** `http://127.0.0.1:8000/`.

**Scope:** Part 1 review and Part 2 fix for issue #1. SQL injection is fixed; issues #2–#4 remain open.

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

[projects/tests.py:102–165](projects/tests.py#L102) adds 17 search cases covering targeted and broad SQL injection, apostrophes, case-insensitive title and description matches, literal `%`/`_`/backslash characters, project isolation, all membership roles, empty searches, anonymous requests, and outsiders. It also checks that search returns the same task fields as the regular task list.

Before the fix, both injection regression cases failed on PostgreSQL by exposing private tasks. After the fix, the complete backend suite passed on PostgreSQL in an isolated temporary schema; the schema was removed afterward. The same 34 tests also passed against in-memory SQLite.

Standard test command, using a PostgreSQL connection with permission to create a separate Django test database:

```bash
python -m pytest -q
```

## 2. Task updates have no project membership or role check

- **Area:** Backend, reachable from the frontend task editor
- **File and lines:** [projects/views.py:155–175](projects/views.py#L155), `TaskDetailView.patch`. The frontend renders editing controls in [../frontend/src/components/TaskDetail.tsx:14–52](../frontend/src/components/TaskDetail.tsx#L14) without receiving an editing permission.
- **Category:** Security
- **Severity:** Critical
- **Description:** PATCH loads any task by UUID and saves changes without checking whether the authenticated user belongs to its project or has an editing role. An outsider with a task UUID can change its title, description, status, or assignee and receive its details in response; a viewer can also edit tasks through the normal UI despite having a read-only role. This lets users corrupt another team's work and bypass project access controls.
- **Recommended fix:** Require membership in the task's project and an `admin` or `member` role before processing update fields, reusing the existing creation/deletion policy. Return 403 for outsiders and viewers, make viewer controls read-only in the UI, and test that denied requests leave every task field and the update timestamp unchanged while admins and members can still edit.
- **Verification:** Confirmed by a curl PATCH from the temporary outsider account: HTTP 200 and a database read both showed the private task title changed to `Changed by outsider`.

Use current fixture values as described above:

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X PATCH \
  "http://127.0.0.1:8000/api/tasks/$PRIVATE_TASK_ID" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Changed by outsider"}'
```

Observed response excerpt from the earlier temporary fixture (those IDs were subsequently removed):

```json
{
  "task": {
    "id": "63a31646-4d22-4f59-9509-9daecfc593e2",
    "project_id": "449a5a22-04ab-4dcb-8639-db616d347170",
    "title": "Changed by outsider"
  }
}
```

```text
HTTP 200
```

Expected: HTTP 403 with `{"error":"forbidden"}`, and unchanged persisted task data. Use disposable test tasks when repeating this write request.

## 3. Switching accounts retains the previous user's private project cache

- **Area:** Frontend
- **Files and lines:** [../frontend/src/components/Header.tsx:14–16](../frontend/src/components/Header.tsx#L14); [../frontend/src/lib/api-client.ts:22–29](../frontend/src/lib/api-client.ts#L22); [../frontend/src/main.tsx:8–14](../frontend/src/main.tsx#L8); [../frontend/src/pages/DashboardPage.tsx:24–26](../frontend/src/pages/DashboardPage.tsx#L24); [../frontend/src/pages/ProjectPage.tsx:25–27](../frontend/src/pages/ProjectPage.tsx#L25).
- **Category:** Security
- **Severity:** High
- **Description:** Logout removes localStorage credentials but leaves the application-wide React Query cache intact, while project query keys contain no user identity. When another account signs in in the same tab, its initial dashboard can render the previous user's cached private project names and descriptions before the new request finishes. Cached project details can similarly expose tasks and member emails if the same project URL is opened; backend permission checks do not remove data already retained in the browser.
- **Recommended fix:** Cancel outstanding queries and clear cached queries and mutations on logout and account changes, and scope private query keys by the authenticated user's ID. Add a frontend test that loads account A's private data, signs out and signs in as B, delays or rejects B's request, and asserts A's data is never rendered.
- **Verification:** Reproduced using the actual `setSession`/`clearSession` source and the installed TanStack query library in Node: after caching A's projects, signing out, and signing in as B, a new observer for `['projects']` immediately returned A's cached data. This was a library/state reproduction, not a browser screenshot test.

Actual output:

```text
Account B initial dashboard data: {"projects":[{"id":"private","name":"Account A private project"}]}
```

**UI check:** In the same tab, sign in as A and load private projects, sign out, then sign in as B without reloading the page. Throttle the dashboard request to observe the stale project cards; opening A's previously visited project URL can show its cached details while the request is pending or fails.

## 4. Saving an assigned task silently clears its assignee

- **Area:** Frontend/backend API contract
- **Files and lines:** [projects/serializers.py:8–25](projects/serializers.py#L8); [../frontend/src/types/index.ts:10–20](../frontend/src/types/index.ts#L10); [../frontend/src/components/TaskDetail.tsx:19](../frontend/src/components/TaskDetail.tsx#L19) and [lines 45–52](../frontend/src/components/TaskDetail.tsx#L45); [../frontend/src/lib/api-client.ts:38–46](../frontend/src/lib/api-client.ts#L38).
- **Category:** Data Integrity
- **Severity:** High
- **Description:** The backend serializes the assignment as `assignee_id`, but the frontend reads `task.assigneeId`; the API client returns the parsed JSON unchanged. Opening an assigned task therefore initializes its assignee selection to empty, and saving a title or description change also sends `assigneeId: null`, removing the existing assignment. This silently changes task ownership during an otherwise unrelated edit.
- **Recommended fix:** Define one consistent response contract: either expose camelCase fields from the backend or explicitly map response DTOs to frontend objects, including task and project IDs and timestamps. Add a task-editor test using a real backend-shaped response that edits only the title and asserts the original assignee is retained, plus a separate test for intentionally clearing an assignment.
- **Verification:** The curl task response contained a populated `assignee_id` and no `assigneeId`. Sending the save payload generated by the current UI with `assigneeId: null` returned HTTP 200; a direct database read confirmed the previously assigned task became unassigned.

**UI check:** Open an assigned task. The editor incorrectly shows `unassigned`; change only its title and save. Reopen the task and observe that the original assignee has been removed.

## Part 2 — Completed fix

Issue #1 is fixed with a parameterized, project-scoped ORM search. The before/after curl evidence and regression coverage are recorded above. Issues #2–#4 remain open and are outside this fix.
