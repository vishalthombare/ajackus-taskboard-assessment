# Code review

Findings are prioritized by business impact. Issue #1 is fixed in this submission; issues #2–#4 remain open. The descriptions record the original behavior.

## 1. Any authenticated user can modify another project's tasks

- **File:** [projects/views.py:165](projects/views.py#L165), particularly lines 167–182 (`TaskDetailView.patch`).
- **Category:** Security
- **Severity:** Critical
- **Status:** Fixed: PATCH now requires membership in the task's project with an `admin` or `member` role before processing changes.
- **Description:** PATCH retrieves a task by ID and saves changes without checking project membership or role. Any logged-in user who obtains a task UUID can change its title, description, status, or assignee and receive the task details in response; project viewers can also edit tasks despite their read-only role. This is ranked first because an ordinary API request can corrupt another team's work without requiring SQL exploitation.
- **Recommended fix:** Before inspecting update fields or saving, require membership in the task's project and an `admin` or `member` role, using the same policy as task creation and deletion. Return 403 for outsiders and viewers; test both cases for unchanged persisted data, and verify that admins and members can still edit.

### Observed curl reproduction

Reproduced against the unmodified endpoint on an isolated SQLite database and local Django server at `127.0.0.1:8011`. The fixture contains a private project owned by `review-owner@example.com`, task `22222222-2222-4222-8222-222222222222`, and a separate account `review-outsider@example.com` with **no membership** in that project. These are test accounts, not application credentials; substitute your own local fixture IDs and credentials to repeat against another server.

```bash
TOKEN=$(curl -sS http://127.0.0.1:8011/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"review-outsider@example.com","password":"review-password123"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -sS -w '\nHTTP %{http_code}\n' -X PATCH \
  http://127.0.0.1:8011/api/tasks/22222222-2222-4222-8222-222222222222 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Changed by outsider"}'
```

Actual response, formatted for readability:

```json
{
  "task": {
    "id": "22222222-2222-4222-8222-222222222222",
    "project_id": "11111111-1111-4111-8111-111111111111",
    "title": "Changed by outsider",
    "description": null,
    "status": "todo",
    "assignee_id": null,
    "created_by_id": "f5ca4782-5e17-4d05-9e74-170e2af0b2a7",
    "position": 0,
    "created_at": "2026-10-14T12:39:01.844775Z",
    "updated_at": "2026-10-14T12:39:42.883777Z",
    "assignee": null
  }
}
```

```text
HTTP 200
```

### Same curl after the fix

The same isolated fixture was reset to its original title, `Private task`, and the identical login and PATCH commands above were rerun against the fixed endpoint. Actual response:

```text
{"error":"forbidden"}
HTTP 403
```

A direct read of the isolated database confirmed the task title remained `Private task`. The temporary test server was stopped afterward; the application database was not modified.

### Regression tests

[projects/tests.py:69](projects/tests.py#L69) checks outsiders (including admins of another project), viewers, members, admins, anonymous requests, and missing tasks. Denied edits must leave title, description, status, assignee, and update timestamp unchanged; successful edits must persist the requested fields.

Before the fix, the role matrix produced **2 failed, 2 passed**: outsiders and viewers incorrectly received 200. After the fix, the complete backend suite produced **23 passed** using an isolated in-memory SQLite database; this verification did not exercise PostgreSQL-specific search behavior.

Reproduce the isolated test run from `backend/` with the installed project dependencies:

```bash
python - <<'PY'
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'taskboard.settings')
from django.conf import settings
settings.DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}
import pytest
raise SystemExit(pytest.main(['-q']))
PY
```

## 2. Task search allows SQL injection across project boundaries

- **File:** [projects/views.py:110](projects/views.py#L110), particularly lines 113–120 (`TaskListCreateView.get`).
- **Category:** Security
- **Severity:** Critical
- **Description:** The `q` query parameter is interpolated directly into SQL executed against PostgreSQL. A member of any project, including a viewer, can inject SQL that bypasses the project filter and reads tasks from other projects; a legitimate search containing an apostrophe can also fail with a server error. Further database impact depends on the application's database privileges.
- **Recommended fix:** Replace the raw search with a project-scoped ORM queryset using `Q(title__icontains=q) | Q(description__icontains=q)` and serialize results consistently with the normal list response. Add PostgreSQL-backed tests for injection payloads, apostrophes, and isolation between two projects.

**Verification:** Confirmed by inspecting the SQL construction; no injection request was executed against the user's database. For example, the input `') OR TRUE -- ` closes the search condition and comments out the remainder, allowing the resulting WHERE clause to match every task.

## 3. Task assignment accepts users outside the project

- **Files:** [projects/views.py:151](projects/views.py#L151), especially line 156 (creation), and [projects/views.py:186](projects/views.py#L186) (update).
- **Category:** Data Integrity
- **Severity:** High
- **Description:** Both task creation and update copy `assigneeId` directly into the foreign key without checking membership in the task's project. Even after issue #1 is fixed, an authorized editor can assign work to an outsider, and the task response exposes that user's name and email through the nested user serializer. Malformed or nonexistent IDs can additionally produce unhandled database or validation errors rather than a clear client response.
- **Recommended fix:** Validate input with a serializer that resolves the assignee only from the project's memberships and returns 400 for invalid, nonexistent, or out-of-project users. Keep null assignment supported; test creation and updates separately, including failed updates leaving the task unchanged.

**Verification:** Confirmed by inspecting both write paths and `TaskSerializer.assignee`; the user foreign key enforces existence, but does not enforce project membership.

## 4. Airtable export returns success without exporting anything

- **File:** [projects/views.py:240](projects/views.py#L240), especially lines 248–249 (`ExportView.post`).
- **Category:** Architecture
- **Severity:** High
- **Description:** The documented Airtable export endpoint only reads tasks and returns HTTP 200 with `exported: 0` and the local task data. It never calls Airtable or uses the configured credentials, so users invoking the advertised integration cannot transfer their work even when configuration is correct. A successful HTTP response masks the missing operation from clients that rely on status codes.
- **Recommended fix:** Implement the export through a dedicated Airtable service and report the actual exported record count, with explicit errors for missing configuration and upstream failures. Add tests using a mocked Airtable client that assert records are actually sent, the existing permission checks hold, and retries do not silently duplicate records.

**Verification:** Confirmed by inspecting the complete export handler against [the documented endpoint and Airtable configuration](../README.md#airtable-export-part-3c). No external export was attempted.
