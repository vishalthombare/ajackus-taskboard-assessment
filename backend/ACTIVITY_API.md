# Project activity feed

`GET /api/projects/:projectId/activity` returns recent activity for one project, newest first. Project admins, members, and viewers can read it. Authenticated outsiders receive 403, including admins of another project; anonymous callers receive 401. The endpoint is read-only.

The project detail page shows the actor, action, task, and local posting time, with status/assignee changes and comment text. It refreshes after successful task creation, task updates, and comments. Readers can use **Refresh activity** and **Load older activity**; the query also refreshes on window focus under the existing React Query defaults.

## Storage and audit behavior

The feed reuses the existing append-only `task_events` table and its transaction-backed writers. No database migration, new table, or backfill is needed. Task creation, actual task field changes (including status and assignee), and posted comments already generate an event atomically with the original change. No-op updates do not generate activity.

An audit write failure rolls back the task/comment change, preserving the policy in [DESIGN_NOTES.md](DESIGN_NOTES.md). The feed does not create synthetic history for tasks that predate the audit feature. Task events and comments remain append-only and cannot be changed through the feed API.

Actor names are captured at write time. Recorded field values and assignee UUIDs remain unchanged; task titles used as labels and assignee display names are resolved from current records. A missing former assignee displays as “Former user,” while null assignments display as “Unassigned.” Reading the feed never rewrites stored audit JSON.

## Ordering, pagination, and isolation

- Scope every query through `task.project_id` after checking the caller's project membership.
- Order by `created_at DESC, id DESC`; use the UUID to break timestamp ties deterministically.
- Return at most 50 events, plus a signed `nextCursor` when older events exist.
- Bind each cursor to the project and use a separate signing salt from comment cursors. Invalid, tampered, or cross-project cursors return 400 after authorization.
- Use keyset pagination so new events arriving after the first page do not shift or duplicate older pages.
- Load task labels in the event query and assignee names once per page, avoiding a query per event. An assignment-bearing page uses three queries: membership, events with tasks, and assignee names.
- Scope frontend caches by both user and project, forward cancellation signals, and use the existing session cache cleanup. Preserve API order across pages, including timestamps with precision beyond JavaScript milliseconds.

## Response example

The following is an illustrative response:

```json
{
  "activity": [
    {
      "id": "event-uuid",
      "actor": { "id": "user-uuid", "name": "Meera Iyer" },
      "task": { "id": "task-uuid", "title": "Prepare release" },
      "eventType": "task_updated",
      "body": null,
      "changes": {
        "status": { "from": "todo", "to": "done" },
        "assigneeId": {
          "from": null,
          "to": "assignee-uuid",
          "fromName": null,
          "toName": "Rohan"
        }
      },
      "createdAt": "2026-10-14T15:00:00Z"
    }
  ],
  "nextCursor": null
}
```

`eventType` is `task_created`, `task_updated`, or `comment_added`. A single task update can contain several changed fields. Comment events include their text in `body`.

## Curl checks on port 8000

Use a real project UUID from `/api/projects` and a token for one of its project members:

```bash
PROJECT_ID="paste_project_uuid"
TOKEN="paste_project_member_token"
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/activity" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: HTTP 200, an `activity` array ordered newest first, and `nextCursor` (null on the last page). A viewer's token also returns 200.

For an older page, copy the `nextCursor` value from the response:

```bash
CURSOR="paste_next_cursor"
curl -sS -G -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/activity" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "cursor=$CURSOR"
```

With a token for a user who is not in this project:

```bash
OUTSIDER_TOKEN="paste_outsider_token"
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/activity" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN"
```

Expected: `{"error":"forbidden"}` and HTTP 403. Without an Authorization header, expect HTTP 401. Authenticated POST, PUT, PATCH, and DELETE requests receive HTTP 405.

## Verification

Backend tests cover real task/comment writes appearing in the feed, all project roles, outsiders and anonymous access, project isolation, newest-first ordering, tied timestamps, keyset pagination with new arrivals, cursor validation, immutable snapshots, assignment/unassignment labels, missing former assignees, read-only methods, and bounded query count. Existing tests continue to verify activity-failure rollback and append-only history enforcement.

Frontend tests cover all four actions, times, safe plain-text comments, empty/error states, pagination and retry, project/account isolation, viewer reads, and automatic refresh after creation, status/assignee edits, and comments.

```bash
# Backend
python -m pytest projects/test_activity.py -q

# Frontend, from frontend/
npm test
```

Verification results and live API checks are recorded in [DESIGN_NOTES.md](DESIGN_NOTES.md).

On October 14, 2026, live curl checks against Q3 Launch (`caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f`) returned:

| Check | Result |
|---|---|
| Authorized project member | HTTP 200; three existing comment events, newest first |
| Project viewer | HTTP 200 |
| Admin of another project, with no membership here | HTTP 403 |
| No token | HTTP 401 |
| Authenticated PATCH attempt | HTTP 405 |

The returned event IDs were independently checked against this project's database rows. These read-only checks created no activity. All 24 activity backend tests passed on PostgreSQL in an isolated temporary schema; the full SQLite suite passed 122 tests with 3 PostgreSQL-only skips, and all 53 frontend tests passed.
