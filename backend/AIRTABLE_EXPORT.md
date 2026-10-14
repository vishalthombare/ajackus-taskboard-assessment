# Airtable bulk export

## Implementation

`POST /api/projects/:projectId/export` exports the project's complete task list. Project admins and members can call it; viewers, outsiders, and anonymous callers cannot. The project detail page provides an Export to Airtable button, a running state, success/partial-failure counts, failed task details, and an Open Airtable link.

Django fetches the tasks with related assignee/creator data and invokes `integrations/airtable/cli.mjs` over stdin. That helper uses the official [`airtable` npm SDK](https://github.com/Airtable/airtable.js), pinned to version 0.12.2. Production never imports the test-only transport in `integrations/airtable/test/airtable-mock.mjs`.

No new database table or migration is needed. Exporting does not edit local tasks or their append-only activity history. The external export is not a database transaction: successful remote writes remain if another record fails, and retries use the same task IDs.

## Server setup

From the backend directory:

```bash
npm ci --prefix integrations/airtable
```

Set these in `backend/.env`, and restart Django after changing configuration:

```dotenv
AIRTABLE_API_KEY=your_personal_access_token
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE_NAME=Tasks
AIRTABLE_NODE_BINARY=/absolute/path/to/node
```

The token needs `data.records:read` and `data.records:write`, with access to the configured base. Node.js 20+ is required; the Docker image installs Node.js 22 and the helper dependencies. If Node is already on the backend process PATH, `AIRTABLE_NODE_BINARY` can be omitted.

Credentials are server-only. They are not included in frontend bundles, HTTP export responses, command-line arguments, or task payloads. The child process receives only its required Airtable configuration and selected runtime environment variables. `.dockerignore` excludes `.env` and local dependencies from the image build context.

## Airtable columns

| Task data | Default Airtable column | Recommended type |
|---|---|---|
| Stable task UUID | `Task ID` | Single line text |
| Title | `Name` | Single line text / primary field |
| Description | `Description` | Long text |
| Status | `Status` | Single line text or single select |
| Assignee display name | `Assignee Name` | Single line text |
| Project name | `Project` | Single line text |
| Project UUID | `Project ID` | Single line text |
| Creator display name | `Created By` | Single line text |

These eight columns are the complete export schema. Task timestamps and board positions are not required. The live integration uses the manually created columns in the configured `Tasks` table; schema permissions are not needed for normal exports.

Provision missing columns once with:

```bash
python manage.py setup_airtable
```

Setup additionally requires `schema.bases:read` and `schema.bases:write`. It creates only missing columns and retains existing ones. The `Task ID` column must be writable text so Airtable can merge records by it. Other existing column types must accept their exported values; the export uses Airtable typecasting for compatible values, including single-select statuses. Alternatively, create the columns manually and keep only the data scopes for normal exports.

To use different column names, set an optional JSON map, for example:

```dotenv
AIRTABLE_FIELD_MAP='{"title":"Title","assignee":"Assigned To"}'
```

Supported keys are `taskId`, `title`, `description`, `status`, `assignee`, `project`, `projectId`, and `createdBy`. Names must be distinct and non-empty. This is server configuration; callers cannot override it through the export request.

## Repeat exports and failures

- Use `performUpsert` with `Task ID` as the merge field: the first export creates records; subsequent exports update matching UUIDs, including changed titles and cleared descriptions/assignees. Records are not matched by title.
- Send up to ten records per request and pace calls to at most four requests/second per export, leaving room below Airtable's documented per-base limit. [Airtable API limits](https://support.airtable.com/articles/7735693959-managing-api-call-limits-in-airtable).
- Retry transient network failures, HTTP 408/429, and 5xx responses at most three times after the initial attempt, with exponential backoff and jitter. A 429 waits at least 30 seconds; monthly quota exhaustion is treated as permanent for this export.
- Do not retry an identical permanently rejected payload. Split a permanently rejected batch into smaller groups to locate an invalid record, retain successful records, and continue later batches. A rejected individual record is reported once without further retry.
- Stop issuing requests for global authorization, missing-table/field, invalid upsert configuration, or monthly quota errors. Report the affected tasks with a clear error rather than sending the same impossible request repeatedly.
- Bound the worker to a four-minute export budget and the process to 260 seconds. The result preserves completed counts when the budget is reached; a process timeout explicitly warns that some records may have reached Airtable and that a rerun safely upserts them.
- Reruns never delete Airtable rows. They update the current local tasks; removing a local task does not automatically remove a previously exported record. Concurrent callers share Airtable's base limits and may receive bounded rate-limit retries.

## Response

A successful or partially successful request returns HTTP 200:

```json
{
  "total": 7,
  "exported": 6,
  "created": 6,
  "updated": 0,
  "failed": 1,
  "failures": [
    {
      "taskId": "task-uuid",
      "title": "Rejected task",
      "code": "INVALID_VALUE_FOR_COLUMN",
      "message": "Airtable rejected this record. Check its field values and the table column types.",
      "retryable": false
    }
  ],
  "baseUrl": "https://airtable.com/app..."
}
```

Missing server configuration/runtime returns 503. A global upstream error before any success returns 502. Neither response includes the token or raw process stderr.

## Curl verification on port 8000

Use a current token for an admin/member and an existing project UUID from that user's `/api/projects` list:

```bash
TOKEN="paste_admin_or_member_token"
PROJECT_ID="paste_existing_project_uuid"
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/export" \
  -H "Authorization: Bearer $TOKEN"
```

Run the same command twice. Check that the second result reports updated records and that the table has one matching row per task UUID. Open the returned Airtable URL and inspect the task titles. A viewer token should receive 403 without any Airtable request.

## Tests

```bash
# Backend: standard Django test database permissions required
python -m pytest projects/test_airtable.py -q

# Node helper: test double, no real network calls
cd integrations/airtable
npm test

# Frontend, from frontend/
npm test
```

The helper tests cover 1,000 records, repeat upserts, changed/cleared fields, batching/pacing, network/503/429 retries, permanent failures, invalid-record isolation, global errors, quota exhaustion, partial results, and deadlines. Backend tests cover role enforcement, project isolation, field mapping, partial/global responses, empty projects, and sanitized process failures. UI tests cover disabled viewer actions, pending state, duplicate clicks, partial success, retryable errors, and the base link.

## Live verification status

Verified on October 14, 2026 against the running backend on port 8000 and the real configured Airtable base. All eight manually created columns passed an API check. The same export request ran twice for **Q3 Launch**, project `caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f`:

```bash
PROJECT_ID="caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f"
# TOKEN must belong to an admin/member of this project.
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/export" \
  -H "Authorization: Bearer $TOKEN"
```

First response:

```json
{"total":7,"exported":7,"created":7,"updated":0,"failed":0,"failures":[],"baseUrl":"https://airtable.com/appdRDoM685PGnikc"}
```

HTTP 200. Repeating the same curl command returned:

```json
{"total":7,"exported":7,"created":0,"updated":7,"failed":0,"failures":[],"baseUrl":"https://airtable.com/appdRDoM685PGnikc"}
```

HTTP 200. An independent read through the official SDK found **7 remote records with 7 unique Task IDs**, matching every task in this project. This verifies persisted records and repeat-export behavior. Open [the Airtable base](https://airtable.com/appdRDoM685PGnikc) to inspect the tasks; the connected-browser list is empty here, so visual inspection has not been performed by the agent.

Verification: 15 Node helper tests passed, 98 backend tests passed with 3 PostgreSQL-only history tests skipped on SQLite, 41 frontend tests passed, and application source type checking passed with dependency declaration checking skipped. After aligning the schema to the eight manually created columns, all 20 export backend tests and all 15 Node tests passed again. The user confirmed the integration works. The container build was not run because Docker is unavailable here.
