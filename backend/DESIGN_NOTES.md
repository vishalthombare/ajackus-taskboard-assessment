# Task comments and activity history

## Status and scope

Part 3a and the activity-write failure requirement are implemented. Migration `projects/0002_task_events` passed isolated PostgreSQL verification and was applied to the application database with approval on 2026-10-14. The running API on port 8000 has been smoke-tested.

Tasks will have chronological discussions showing author, body, and posting time. Project admins and members may post; viewers may read; outsiders and anonymous users may not access the thread. Posted comments cannot be edited or deleted, including by their authors or project admins.

## Business impact

- Discussions stay attached to the work, reducing lost context and repeated questions.
- Author identity, original wording, and posting time provide an engagement audit trail.
- Backend authorization prevents viewers from posting and prevents access across project boundaries.
- Audit retention affects deletion: deleting a parent task, project, or author must not silently remove its history.
- Requiring the audit write to succeed makes a change fail visibly when its history cannot be recorded; users can retry after the underlying failure is resolved.

## Database: one new table is enough

**Implemented choice: one append-only `task_events` table for both comments and task activity.** A comment is an event with type `comment_added`; automated activity uses other event types. The comment endpoint filters for comment events, so machine-generated activity does not appear as user discussion.

Part 3a alone could use a dedicated `task_comments` table. With the additional activity requirement, sharing the event table avoids creating a second table and avoids writing duplicate comment and comment-activity rows. It does require explicit event types and validation so comments and automated activity remain distinct.

Existing `tasks`, `projects`, `users`, and `memberships` tables are reused. The proposed deletion-blocking policy does not require adding soft-delete columns to them.

### `TaskEvent` model

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID primary key | Server-generated event identifier |
| `task_id` | Foreign key to `tasks`, protected from deletion | Associates the event with its task |
| `actor_id` | Foreign key to `users`, protected from deletion | Authenticated person responsible for the event |
| `actor_name` | String, maximum 200 characters | Author display name captured when posted |
| `event_type` | Validated string | Initially `comment_added`, `task_created`, or `task_updated` |
| `body` | Nullable string, maximum 5,000 characters | Required for comments; absent for automated activity |
| `changes` | JSON object, default `{}` | Server-generated activity details, such as previous/new status |
| `created_at` | Timezone-aware timestamp | Server-generated posting time, stored in UTC |

Task creation and actual updates are recorded as activity; no-op updates do not create an event or change the task timestamp. A project activity feed is not part of the currently supplied comments requirement.

### Constraints and indexes

- Require a supported `event_type`.
- For `comment_added`, require a non-empty body after trimming whitespace, with a 5,000-character limit.
- For automated activity, require `body` to be null and construct `changes` on the server.
- Never accept task identity, author identity, author name, posting time, or event type from the comment request body.
- Index `(task_id, event_type, created_at, id)` for comment retrieval.
- Index `(task_id, created_at, id)` for chronological activity retrieval.
- Order by `created_at ASC, id ASC`; the UUID supplies deterministic ordering when timestamps tie.

### Migration

Generated [projects/migrations/0002_task_events.py](projects/migrations/0002_task_events.py), creating the table, constraints, indexes, and PostgreSQL immutability trigger. Existing tasks and memberships need no backfill; historical events will not be fabricated. The migration must be applied before enabling the new endpoints.

## Append-only enforcement and retention

Expose comment listing and creation only. Do not provide comment edit/delete handlers or UI controls, even for admins.

Because this is an audit trail, also enforce immutability in PostgreSQL with a trigger rejecting updates, deletes, and truncation on `task_events`. This covers ORM bulk updates/deletes and accidental writes outside the comments endpoint. Test this protection on PostgreSQL; API tests alone do not prove database immutability.

**Implemented retention policy:** protected task and author references. Deleting a task with events returns HTTP 409 with an explanatory message; deleting a project containing such tasks is also blocked. Author deletion must likewise preserve the event and its attribution.

This changes current delete behavior. If task creation is recorded as an event, every newly created task will immediately have protected history and therefore cannot be hard-deleted. The development seed command now refuses to run if task events exist, avoiding accidental history loss; use a fresh development database for reseeding.

If deletion must remain available, use an archive/soft-delete design instead. That would add changes to existing task/project models, queries, and UI, increasing the scope beyond the proposed single-table design. Approval of the application migration enables the documented protected-deletion behavior.

## Authorization

| Caller | Read thread | Post comment | Edit/delete posted comment |
|---|---|---|---|
| Project admin | Yes | Yes | No |
| Project member | Yes | Yes | No |
| Project viewer | Yes | No | No |
| Authenticated outsider | No | No | No |
| Anonymous caller | No | No | No |

Resolve the task, then check membership in that task's actual project. Being an admin in another project does not grant access. Reuse the existing authenticated-user handling and project role policy; derive the actor from `request.user`.

Check authorization before validating or saving the comment. Viewers and outsiders receive HTTP 403, anonymous requests receive HTTP 401, and missing task IDs receive HTTP 404. Unsupported mutation methods receive HTTP 405 on the comments collection; no individual comment mutation route is exposed.

## API design

### GET `/api/tasks/:taskId/comments`

Return only `comment_added` events for the authorized task, oldest first. Each item contains `id`, `author` (user ID and captured display name), `body`, and `createdAt`.

Use pages of 50 comments with a stable chronological cursor so long threads do not require loading the full audit history. Return a next-page cursor when more comments exist. Fetch author data without one extra query per comment.

### POST `/api/tasks/:taskId/comments`

Request:

```json
{"body":"The implementation is ready for review."}
```

On success, return HTTP 201 and the created comment. Reject missing, blank, non-string, or oversized bodies with HTTP 400. Additional client-supplied author or timestamp fields must not influence the stored record.

Render comments as plain text in React. Preserve line breaks and display posting times in the reader's local timezone; the stored timestamp remains UTC.

## Transaction decision: activity failure rolls back the change

The original change and its required activity event will be written in the same database transaction; if the activity insert fails, the original change rolls back. The team treats history as an audit trail, so a successful business change without its corresponding record would undermine that guarantee. Atomic writes make the failure visible and leave the database consistent for a subsequent retry.

### Implementation approach

- Put task writes and their required event inserts in one service operation wrapped with `transaction.atomic()`.
- For task creation, insert the task, its required related records, and the `task_created` event before committing.
- For task updates, capture permitted old/new values, update the task, and append `task_updated` within the transaction; record only actual changes.
- For a comment, the `comment_added` event is itself the discussion and activity record: one insert provides both, without a duplicate log row.
- Do not swallow an activity persistence error and return success. Let the transaction roll back and return an appropriate server error without exposing internal database details.
- Send the HTTP success response only after the transaction completes. Any future notifications should run after commit so they do not announce a rolled-back change.
- A failed comment submission must remain available in the UI for retry. Retrying a failed database transaction must not leave a partially saved comment or task update.

This policy applies to database-backed activity. External analytics or notification systems are outside this feature's transaction boundary.

## Frontend changes

Add a `TaskComments` component inside the existing task popup. It displays chronological comments, author names, local posting times, loading/error/empty states, and loading of additional pages.

Admins and members receive a text area and Post button. Viewers receive the thread with a clear read-only state and no enabled posting control. Disable submission while posting, preserve the draft on failure, and clear it only after success.

Fetch comments separately from project detail so opening a board does not load every task's discussion. Use a user-scoped cache key such as `['comments', userId, taskId]`, forward abort signals, and reuse the existing session cache cleanup. After posting, refresh the relevant thread so it reflects the authoritative server order.

Define a consistent comment response type and use an explicit API adapter if the wire format differs from frontend naming, avoiding the earlier assignee field mismatch.

## Tests and verification

Backend coverage:

- Admin/member posting succeeds; viewer posting fails without creating a row.
- All project roles can read; outsiders, admins of other projects, and anonymous users cannot access the thread.
- Client-supplied author/time/task fields cannot impersonate another user or change the target task.
- Chronological ordering and pagination work, including tied timestamps and separation of two tasks' threads.
- Blank, malformed, and oversized comments fail validation.
- Posted comments cannot be edited/deleted through HTTP or PostgreSQL updates/deletes, including ORM bulk operations.
- Protected parent deletion returns a clear error and leaves the audit history intact, under the implemented retention policy.
- Force an activity insert failure and assert the task's original values/timestamp are unchanged; for creation, assert no task or related partial record remains.
- Force a comment insert failure and assert no comment is stored and no success response is returned.

Frontend coverage:

- Render author, body, and posting time in chronological order.
- Admin/member submission succeeds; viewers cannot submit.
- Successful posting updates the thread; failure retains the draft and displays an error.
- No edit/delete comment controls exist.
- Account switching does not expose another user's cached thread.

Use PostgreSQL for database trigger/transaction verification and React tests for the thread UI. Add curl examples targeting the running backend at `http://127.0.0.1:8000/` for permitted posting, viewer denial, outsider denial, and rejected comment mutation methods. Runnable curl examples and expected results are in [COMMENTS_API.md](COMMENTS_API.md). The running API was verified after the approved application migration; live results are listed below.

## Estimated change scope

| Area | Files | Estimated count |
|---|---|---:|
| Backend | Models, migration, serializers, views, routes, service, new comment tests, seed guard | 8 |
| Frontend | Comment types/API/component, task popup integration, new comment tests, two existing test fixtures | 7 |
| Documentation | `COMMENTS_API.md` examples and this design document | 2 |
| **Total** | **One new database table and one migration** | **17 files** |

The estimate assumes the proposed protected-deletion policy and task creation/update activity scope. Soft deletion, additional activity types, a project-wide feed, or notifications would expand it.

## Verification completed

- PostgreSQL: **81 backend tests passed**, including UPDATE/DELETE/TRUNCATE rejection, parent deletion protection, pagination ties, permissions, and activity-failure rollback. Test migrations ran inside a unique temporary schema, which was removed afterward.
- SQLite: **78 passed, 3 skipped**; the skipped cases specifically exercise the PostgreSQL trigger.
- Frontend: **35 tests passed**, including comment posting, viewer read-only access, failed-draft retention, paging/deduplication, and account cache isolation.
- Application source type checking passed with `tsc --noEmit --skipLibCheck`; the pre-existing dependency declaration errors still affect the full type check.
- Django system checks passed, and a migration dry run reported no missing model changes.
- Application migration `projects/0002_task_events` applied successfully with approval. Live checks on port 8000 confirmed viewer reads (200), denied viewer posting (403), blank-comment validation (400), rejected edit methods (405), and denied anonymous access (401), without creating or modifying history.

## Application migration completed

The application migration creates **one table**, its indexes/check constraint, a trigger function, and the append-only trigger. It does not backfill old events or remove existing task data. The existing task index keeps its original name; no unrelated index rename is included.

The following approved command completed successfully:

```bash
python manage.py migrate projects 0002_task_events
```

The migration makes activity-backed task writes and the new comments API available. Task/project deletion with recorded history will return 409.

## Part 3c — Airtable export

The synchronous export is implemented with the official `airtable` npm SDK in a server-side Node helper called by Django. It does not use `pyairtable` or the test double for production calls and does not require a database migration. The helper receives project task data over stdin; Airtable credentials stay in the server environment.

Records are upserted by the stable task UUID, in batches of ten. Bounded retries cover transient network errors, rate limiting, and server failures; identical permanent failures are not retried. A rejected batch is split to isolate bad records, so successful records and later batches are retained. Global authentication/schema/quota errors stop further impossible requests and return a clear error.

The project page enables export only for admins/members, shows pending and partial-result states, and links to the Airtable base. The API independently enforces project membership and role. Updating an export does not edit the local task or activity history; external successful writes are retained across partial failures, with repeat upserts providing safe recovery.

The export schema uses the eight manually created columns: Task ID, Name, Description, Status, Assignee Name, Project, Project ID, and Created By. Task timestamps and board positions are not required. Configuration comes from `backend/.env`; setup does not copy an example file or overwrite credentials.

See [AIRTABLE_EXPORT.md](AIRTABLE_EXPORT.md) for columns, token scopes, setup, retry/deadline choices, Docker support, tests, and the exact live curl responses. On October 14, 2026, the real Q3 Launch export returned HTTP 200 with 7 created records and no failures. Repeating the same request returned HTTP 200 with 7 updated records and zero new records. An independent SDK read confirmed 7 records with 7 unique Task IDs, matching every project task. No connected browser is available for visual inspection; the API and project UI provide the base link.

Verification: 15 Node export tests passed (including 1,000 tasks and repeats), 98 backend tests passed with 3 PostgreSQL-only history tests skipped on SQLite, 41 frontend tests passed, and source type checking passed. After the eight-column adjustment, the 20 backend export tests and 15 Node helper tests passed again. The user confirmed the integration works. Docker cannot be built in this environment because the Docker CLI is unavailable.
