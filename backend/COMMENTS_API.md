# Task comments verification

The backend runs at `http://127.0.0.1:8000/`. Migration `projects/0002_task_events` was applied with approval on 2026-10-14; comment endpoints and activity-backed task writes are available.

Use an existing task ID and current tokens from users in its actual project. Tokens for a project admin or member can post; a viewer token can only read. An outsider token must belong to a user with no membership in that task's project.

```bash
TASK_ID="paste_existing_task_uuid"
MEMBER_TOKEN="paste_project_admin_or_member_token"
VIEWER_TOKEN="paste_project_viewer_token"
OUTSIDER_TOKEN="paste_nonmember_token"
```

These are placeholders, not retained fixture credentials. Posted comments and their history cannot be removed afterward, including by deleting their parent task/project.

## Post a comment

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Ready for review."}'
```

Expected: HTTP 201, with `comment.id`, `comment.author`, `comment.body`, and server-generated `comment.createdAt`.

## Read the thread as a viewer

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $VIEWER_TOKEN"
```

Expected: HTTP 200 with `comments` ordered oldest first and `nextCursor` (null when there are no more pages). For another page, send the returned cursor using `-G --data-urlencode "cursor=$NEXT_CURSOR"`.

## Viewer cannot post

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"This must not be stored."}'
```

Expected: `{"error":"viewers cannot post comments"}` and HTTP 403, without a new record.

## Outsider cannot read

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN"
```

Expected: `{"error":"forbidden"}` and HTTP 403. No token returns HTTP 401.

## Comments cannot be edited or deleted

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X PATCH \
  "http://127.0.0.1:8000/api/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Rewrite history"}'
```

Expected: HTTP 405. DELETE and PUT on the collection also return 405; individual comment mutation URLs do not exist and return 404. PostgreSQL rejects direct UPDATE, DELETE, and TRUNCATE against the history table.

## Activity persistence

Task creation writes a `task_created` event, and actual task changes write `task_updated` with old/new values. Both the original task write and the event insert occur in one transaction. If the event write fails, the task creation/update rolls back and the endpoint returns HTTP 500 with a retry message.

A comment is itself a `comment_added` event, so there is no duplicate activity insert. The thread excludes automated activity events. Tasks/projects with any history return HTTP 409 when deletion is requested, preserving the audit trail.

## Automated verification

Backend tests are in `projects/test_comments.py`; UI tests are in `frontend/src/tests/TaskComments.test.tsx`. Tests cover role authorization, author spoofing, body validation, chronological cursor paging, append-only enforcement, deletion protection, transaction rollback, posting, retry drafts, pagination, and account cache isolation.

Database immutability tests require PostgreSQL. The examples above describe expected responses. Live checks after the application migration confirmed viewer GET 200, viewer POST 403, blank admin POST 400, PATCH 405, and anonymous GET 401; no new history was written during those checks. Successful posting and transactional rollback are additionally covered by the passing PostgreSQL test suite.
