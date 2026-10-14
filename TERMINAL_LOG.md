# Terminal log — taskboard assessment

Evidence date: **October 14, 2026**. Reviewed implementation: commit `24b6e17` (activity feed), following `28c5125` (Airtable export), `ad0dd51` (comments/audit history), and the four review fixes. Backend: **http://127.0.0.1:8000/**.

This is an ordered evidence log assembled from retained terminal/curl output and fresh verification, rather than an uninterrupted `script` recording. Original installation output was not retained; section 1 contains freshly captured setup verification. Section 2 explicitly replays the pre-fix commit in a temporary directory. Historical curl/export evidence is identified as such; later demos and final tests were captured while preparing this file. Credentials and JWTs are omitted, and JSON content is preserved. Node/npm command names below refer to the installed Node 22.14.0 runtime.

The sections follow the submission order: setup, initial tests, bug proof, fix proof, Part 3c export, Part 3a/3b demos, final tests. Other submission documents: [code review](backend/REVIEW.md), [design notes](backend/DESIGN_NOTES.md), [Airtable details](backend/AIRTABLE_EXPORT.md), [comments API](backend/COMMENTS_API.md), and [activity API](backend/ACTIVITY_API.md).

## 1. Setup output

Fresh verification of the installed environment, run from `backend/`. Django loads the existing `backend/.env`; its contents are not included. No dependencies were reinstalled or application migrations rerun for this log.

```bash
$ python --version
```
```text
Python 3.12.14
```
Captured: `2026-10-14T15:25:20.621140+00:00`. Exit status: `0`.

```bash
$ node --version
```
```text
v22.14.0
```
Captured: `2026-10-14T15:25:20.631519+00:00`. Exit status: `0`.

```bash
$ npm --version
```
```text
10.9.2
```
Captured: `2026-10-14T15:25:20.726015+00:00`. Exit status: `0`.

```bash
$ python -m pip check
```
```text
No broken requirements found.
WARNING: The directory '/Users/vishal/Library/Caches/pip' or its parent directory is not owned or is not writable by the current user. The cache has been disabled. Check the permissions and owner of that directory. If executing pip with sudo, you should use sudo's -H flag.
```
Captured: `2026-10-14T15:25:20.871469+00:00`. Exit status: `0`.

```bash
$ python manage.py check
```
```text
System check identified no issues (0 silenced).
```
Captured: `2026-10-14T15:25:21.141684+00:00`. Exit status: `0`.

```bash
$ python manage.py showmigrations projects  # plus read-only SELECT 1 connection check
```
```text
Database connection: SELECT 1 -> 1
projects
 [X] 0001_initial
 [X] 0002_task_events
```
Captured: `2026-10-14T15:28:08.997980+00:00`. Exit status: `0`.

## 2. Initial test run — pre-fix replay

The original initial test transcript was not retained. The pre-review **17-test backend suite** was replayed against commit `d32ec6c`, immediately before the SQL injection fix. The source was exported from Git into `/tmp/taskboard_terminal_baseline`; the working tree and running application were left unchanged.

Tests used an isolated, uniquely named PostgreSQL schema. The harness loaded the configured database connection, migrated only that temporary schema, ran pytest, and removed the schema afterward. This was not a migration of the application's schema. The same isolation harness was used for the final PostgreSQL audit tests in section 7.

Replay output:

```bash
$ python -c 'from dotenv import load_dotenv;load_dotenv('"'"'/Users/vishal/Documents/Projects/ajackus-taskboard-assessment/backend/.env'"'"');exec(compile(open('"'"'/tmp/taskboard_postgres_tests.py'"'"').read(),'"'"'/tmp/taskboard_postgres_tests.py'"'"','"'"'exec'"'"'))' -q --tb=short
```
```text
Running tests in an isolated PostgreSQL schema
.................                                                        [100%]
17 passed in 135.55s (0:02:15)
Isolated test schema removed
```
Captured: `2026-10-14T15:31:01.673823+00:00`. Exit status: `0`.

The baseline working directory was `/tmp/taskboard_terminal_baseline/backend`. The source was obtained with `git archive d32ec6c backend` from the repository root and extracted into that temporary directory. For reproducibility, this is the actual isolated-schema harness used for the initial and final PostgreSQL attempts (temporary file `/tmp/taskboard_postgres_tests.py`):

```python
import os
import sys
import uuid
import copy
sys.path.insert(0, os.getcwd())
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'taskboard.settings')
from django.conf import settings
import psycopg2
from psycopg2 import sql
config = copy.deepcopy(settings.DATABASES['default'])
config['HOST'] = config['HOST'].replace('-pooler.', '.')
schema = 'review_test_' + uuid.uuid4().hex
admin = psycopg2.connect(dbname=config['NAME'], user=config['USER'], password=config['PASSWORD'], host=config['HOST'], port=config['PORT'], connect_timeout=15)
admin.autocommit = True
try:
    with admin.cursor() as cursor:
        cursor.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    config.setdefault('OPTIONS', {})['options'] = f'-c search_path={schema}'
    config['TEST'] = {'MIRROR': 'default'}
    settings.DATABASES = {'default': config}
    import django
    django.setup()
    from django.core.management import call_command
    call_command('migrate', verbosity=0)
    import pytest
    class IsolatedSchema:
        @pytest.fixture(scope='session')
        def django_db_setup(self):
            # Migrations already ran in our unique schema; never create/drop the application database.
            yield
    print('Running tests in an isolated PostgreSQL schema', flush=True)
    result = pytest.main(sys.argv[1:] or ['-q'], plugins=[IsolatedSchema()])
finally:
    from django.db import connections
    connections.close_all()
    with admin.cursor() as cursor:
        cursor.execute(sql.SQL('DROP SCHEMA IF EXISTS {} CASCADE').format(sql.Identifier(schema)))
    admin.close()
    print('Isolated test schema removed', flush=True)
sys.exit(result)
```
The baseline suite passing did not establish protection against SQL injection: it lacked the search regression cases added in `96a4bde`. The running-app curl below demonstrates the missed bug.

## 3. Bug curl proof — before SQL injection fix

**Retained actual output from the pre-fix running PostgreSQL application on port 8000**, also recorded in [REVIEW.md](backend/REVIEW.md). Meera belonged to the search project but had no membership in the private task's project. The exploit targeted only the dedicated review task.

```bash
OUTSIDER_TOKEN="paste_current_meera_token"
SEARCH_PROJECT_ID="c4ba269e-141b-472d-a820-bc5f89a8880f"
PRIVATE_TASK_ID="d6ec5d9a-132b-4560-a53c-a6a86eedf810"
```

```bash
curl -sS -G -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$SEARCH_PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  --data-urlencode "q=zznomatch') OR (id = '$PRIVATE_TASK_ID') -- "
```
```text
{"tasks":[{"id":"d6ec5d9a-132b-4560-a53c-a6a86eedf810","project_id":"c45e1503-8a87-45d5-8e20-6f9a1b293eb2","title":"SQL review private task","description":null,"status":"todo","assignee_id":null,"created_by_id":"ed062f69-9fa5-4d77-ab74-1bc60f81c011","position":0,"created_at":"2026-10-14T13:05:13.910309Z","updated_at":"2026-10-14T13:05:13.910322Z"}]}
HTTP 200
```

The request searched project `c4ba269e-141b-472d-a820-bc5f89a8880f` but returned a task from private project `c45e1503-8a87-45d5-8e20-6f9a1b293eb2`. The injected OR condition escaped the requested project's filter.

## 4. Fix curl proof — identical request after fix

Fix commit: **`96a4bde fix: prevent SQL injection in project task search`**. Search uses a project-scoped Django ORM query with bound values. The same curl command and fixture IDs were used after the fix:

```bash
curl -sS -G -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/$SEARCH_PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  --data-urlencode "q=zznomatch') OR (id = '$PRIVATE_TASK_ID') -- "
```
```text
{"tasks":[]}
HTTP 200
```

HTTP 200 with an empty list is correct: the injection payload is treated as literal search text. The private task is not returned.

Fresh verification while preparing this log used the same payload and retained project/task IDs, with a current token:

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -G \
  "http://127.0.0.1:8000/api/projects/c4ba269e-141b-472d-a820-bc5f89a8880f/tasks" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" \
  --data-urlencode "q=zznomatch') OR (id = 'd6ec5d9a-132b-4560-a53c-a6a86eedf810') -- "
```
```text
{"tasks":[]}
HTTP 200
```

The original proof and fix proof are separate captures; the vulnerable implementation was not restored on the running application. Search/authorization regression tests are part of the final backend suite. The other three fixes and their evidence are in [REVIEW.md](backend/REVIEW.md).

## 5. Part 3c — real Airtable export and uniqueness

Implementation commit: **`28c5125 feat: add reliable bulk task export to Airtable`**. These are the two retained successful live responses from the implementation session, using the real Airtable API through the official `airtable` npm SDK. Runtime code does not use the test double.

**Airtable base link:** [Open the exported tasks](https://airtable.com/appdRDoM685PGnikc). Access requires permission to that base; this is not an anonymously published share. The user opened the integration and confirmed it works. No agent browser screenshot is claimed.

The exported project was **Q3 Launch**, containing 7 tasks at the time of verification.

```bash
PROJECT_ID="caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f"
MEMBER_TOKEN="paste_current_project_admin_or_member_token"
```

### Export run 1

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/export" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```
```json
{
  "total": 7,
  "exported": 7,
  "created": 7,
  "updated": 0,
  "failed": 0,
  "failures": [],
  "baseUrl": "https://airtable.com/appdRDoM685PGnikc"
}
```
```text
HTTP 200
```

### Export run 2

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  "http://127.0.0.1:8000/api/projects/$PROJECT_ID/export" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```
```json
{
  "total": 7,
  "exported": 7,
  "created": 0,
  "updated": 7,
  "failed": 0,
  "failures": [],
  "baseUrl": "https://airtable.com/appdRDoM685PGnikc"
}
```
```text
HTTP 200
```

The second run created **0** new records and updated the same **7** task records. Recorded verification summary from the implementation-session official-SDK read: **7 remote records, 7 unique Task IDs, and all 7 project task IDs present**. This summary comes from the earlier tool output; it is not presented as a newly captured read in this documentation run.


The helper tests in section 7 cover 1,000 tasks, repeat exports, batching, transient retries, permanent errors, isolated failed records, rate limits, quota failures, and deadlines. Backend tests enforce admin/member export authorization; frontend tests cover disabled viewer controls and partial results.

## 6. Part 3a and Part 3b demos

These are fresh curl captures from the running application. Tokens are replaced with shell variable names. The existing comments are real posted records; the checks below create or change no audit history. Successful admin/member posting and atomic rollback are additionally exercised in the final PostgreSQL suite.

```bash
PROJECT_ID="caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f"
TASK_ID="c7015acd-5bf2-497f-b164-c636e78c2545"
MEMBER_TOKEN="current_token_for_Meera_Iyer"
VIEWER_TOKEN="current_token_for_project_viewer"
OUTSIDER_TOKEN="current_token_for_a_user_outside_this_project"
```

### Part 3a — append-only task comments

#### Viewer reads author, body, and posting time in chronological order

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/c7015acd-5bf2-497f-b164-c636e78c2545/comments" \
  -H "Authorization: Bearer $VIEWER_TOKEN"
```
```text
{"comments":[{"id":"b25dafa9-8631-497e-8eee-9ca99064f64a","author":{"id":"434bd566-6281-44e6-933e-e001d7a544b5","name":"Meera Iyer"},"body":"Testing Comment","createdAt":"2026-10-14T14:10:40.765795Z"},{"id":"2ccad0e2-2464-4bc5-9b90-3ba8cc33099f","author":{"id":"cf0a1d07-14fa-4ca1-8dbc-6b2e845bd248","name":"Arjun Rao"},"body":"Testing Comment 2","createdAt":"2026-10-14T14:12:09.314844Z"}],"nextCursor":null}
HTTP 200
```

#### Viewer cannot post

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST \
  "http://127.0.0.1:8000/api/tasks/c7015acd-5bf2-497f-b164-c636e78c2545/comments" \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"This must not be stored."}'
```
```text
{"error":"viewers cannot post comments"}
HTTP 403
```

#### Outsider cannot read

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/tasks/c7015acd-5bf2-497f-b164-c636e78c2545/comments" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN"
```
```text
{"error":"forbidden"}
HTTP 403
```

#### Posted comments cannot be edited

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X PATCH \
  "http://127.0.0.1:8000/api/tasks/c7015acd-5bf2-497f-b164-c636e78c2545/comments" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Rewrite history"}'
```
```text
{"detail":"Method \"PATCH\" not allowed."}
HTTP 405
```

#### Posted comments cannot be deleted

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X DELETE \
  "http://127.0.0.1:8000/api/tasks/c7015acd-5bf2-497f-b164-c636e78c2545/comments" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```
```text
{"detail":"Method \"DELETE\" not allowed."}
HTTP 405
```

The comments tests also assert successful admin/member POST responses (201), author/timestamp control, chronological pagination, and failed-draft retention. PostgreSQL tests verify direct UPDATE/DELETE/TRUNCATE rejection and rollback when an audit insert fails.

### Part 3b — project activity feed

The project page displays actor, action, task, and time, newest first. The existing demo project contains comment events; the automated end-to-end API case `test_actual_task_and_comment_writes_appear_newest_first` creates a task, changes its status and assignee, adds a comment, and verifies all four actions in the feed. UI integration tests verify refreshes after these writes.

#### Project member reads newest activity first

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f/activity" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```
```text
{"activity":[{"id":"2ccad0e2-2464-4bc5-9b90-3ba8cc33099f","actor":{"id":"cf0a1d07-14fa-4ca1-8dbc-6b2e845bd248","name":"Arjun Rao"},"task":{"id":"c7015acd-5bf2-497f-b164-c636e78c2545","title":"Prepare customer email blast"},"eventType":"comment_added","body":"Testing Comment 2","changes":{},"createdAt":"2026-10-14T14:12:09.314844Z"},{"id":"b25dafa9-8631-497e-8eee-9ca99064f64a","actor":{"id":"434bd566-6281-44e6-933e-e001d7a544b5","name":"Meera Iyer"},"task":{"id":"c7015acd-5bf2-497f-b164-c636e78c2545","title":"Prepare customer email blast"},"eventType":"comment_added","body":"Testing Comment","changes":{},"createdAt":"2026-10-14T14:10:40.765795Z"},{"id":"9f02fc2d-555d-4d05-9f40-ca17a87b8cac","actor":{"id":"434bd566-6281-44e6-933e-e001d7a544b5","name":"Meera Iyer"},"task":{"id":"edc5bb00-bd8b-45f0-a2ec-b1a0f0ed0847","title":"Draft press release"},"eventType":"comment_added","body":"testing","changes":{},"createdAt":"2026-10-14T14:10:18.122531Z"}],"nextCursor":null}
HTTP 200
```

#### Project viewer can read activity

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f/activity" \
  -H "Authorization: Bearer $VIEWER_TOKEN"
```
```text
{"activity":[{"id":"2ccad0e2-2464-4bc5-9b90-3ba8cc33099f","actor":{"id":"cf0a1d07-14fa-4ca1-8dbc-6b2e845bd248","name":"Arjun Rao"},"task":{"id":"c7015acd-5bf2-497f-b164-c636e78c2545","title":"Prepare customer email blast"},"eventType":"comment_added","body":"Testing Comment 2","changes":{},"createdAt":"2026-10-14T14:12:09.314844Z"},{"id":"b25dafa9-8631-497e-8eee-9ca99064f64a","actor":{"id":"434bd566-6281-44e6-933e-e001d7a544b5","name":"Meera Iyer"},"task":{"id":"c7015acd-5bf2-497f-b164-c636e78c2545","title":"Prepare customer email blast"},"eventType":"comment_added","body":"Testing Comment","changes":{},"createdAt":"2026-10-14T14:10:40.765795Z"},{"id":"9f02fc2d-555d-4d05-9f40-ca17a87b8cac","actor":{"id":"434bd566-6281-44e6-933e-e001d7a544b5","name":"Meera Iyer"},"task":{"id":"edc5bb00-bd8b-45f0-a2ec-b1a0f0ed0847","title":"Draft press release"},"eventType":"comment_added","body":"testing","changes":{},"createdAt":"2026-10-14T14:10:18.122531Z"}],"nextCursor":null}
HTTP 200
```

#### Admin of another project cannot read this feed

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f/activity" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN"
```
```text
{"error":"forbidden"}
HTTP 403
```

#### Anonymous caller cannot read activity

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "http://127.0.0.1:8000/api/projects/caf7be4d-f4e3-42c7-915b-bfcc1d6ab62f/activity"
```
```text
{"detail":"Authentication credentials were not provided."}
HTTP 401
```

The capture script checked chronological comment order, reverse chronological activity order, role responses, and the unchanged audit-event count. The existing UI was covered by component/project-page tests; no connected browser was available for agent visual inspection.

## 7. Final test run

Freshly captured against implementation commit `24b6e17`. The complete SQLite, Airtable helper, and frontend suites passed. The PostgreSQL feature run had one transient connection error during fixture setup; the original error and recovery run are included below.

### Backend — complete suite on in-memory SQLite

```bash
$ /Users/vishal/Documents/Projects/ajackus-taskboard-assessment/backend/.venv312/bin/python -c 'import os; os.environ.setdefault('"'"'DJANGO_SETTINGS_MODULE'"'"', '"'"'taskboard.settings'"'"'); from django.conf import settings; settings.DATABASES={'"'"'default'"'"': {'"'"'ENGINE'"'"':'"'"'django.db.backends.sqlite3'"'"','"'"'NAME'"'"':'"'"':memory:'"'"'}}; import pytest; raise SystemExit(pytest.main(['"'"'-q'"'"','"'"'--tb=short'"'"']))'
```
```text
..............................................................sss....... [ 57%]
.....................................................                    [100%]
122 passed, 3 skipped in 28.81s
```
Captured: `2026-10-14T15:27:07.360629+00:00`. Exit status: `0`.

The three skipped tests require PostgreSQL's append-only trigger and are exercised without skips in the PostgreSQL runs below.

### PostgreSQL — comments, audit rollback, append-only enforcement, and activity feed

The isolation harness ran migrations and tests only in a temporary schema. The initial attempt completed 63 tests successfully, including the activity feed and append-only checks, but a database connection timed out while preparing one invalid-comment fixture. The lost connection also interrupted automatic schema cleanup. The original output is retained here; this was a connection/setup error, rather than an assertion failure in application behavior.

```bash
$ python /tmp/taskboard_postgres_tests.py projects/test_comments.py projects/test_activity.py -q --tb=short
```
```text
Running tests in an isolated PostgreSQL schema
......................................E.........................         [100%]
==================================== ERRORS ====================================
_ ERROR at setup of test_database_rejects_invalid_event_shapes[comment_added-  ] _
.venv312/lib/python3.12/site-packages/django/db/backends/utils.py:105: in _execute
    return self.cursor.execute(sql, params)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
E   psycopg2.OperationalError: could not receive data from server: Operation timed out
E   SSL SYSCALL error: Operation timed out

The above exception was the direct cause of the following exception:
projects/test_comments.py:25: in thread
    Membership.objects.create(project=project, user=people[role], role=role)
.venv312/lib/python3.12/site-packages/django/db/models/manager.py:87: in manager_method
    return getattr(self.get_queryset(), name)(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
.venv312/lib/python3.12/site-packages/django/db/models/query.py:665: in create
    obj.save(force_insert=True, using=self.db)
.venv312/lib/python3.12/site-packages/django/db/models/base.py:902: in save
    self.save_base(
.venv312/lib/python3.12/site-packages/django/db/models/base.py:1008: in save_base
    updated = self._save_table(
.venv312/lib/python3.12/site-packages/django/db/models/base.py:1169: in _save_table
    results = self._do_insert(
.venv312/lib/python3.12/site-packages/django/db/models/base.py:1210: in _do_insert
    return manager._insert(
.venv312/lib/python3.12/site-packages/django/db/models/manager.py:87: in manager_method
    return getattr(self.get_queryset(), name)(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
.venv312/lib/python3.12/site-packages/django/db/models/query.py:1873: in _insert
    return query.get_compiler(using=using).execute_sql(returning_fields)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
.venv312/lib/python3.12/site-packages/django/db/models/sql/compiler.py:1882: in execute_sql
    cursor.execute(sql, params)
.venv312/lib/python3.12/site-packages/django/db/backends/utils.py:79: in execute
    return self._execute_with_wrappers(
.venv312/lib/python3.12/site-packages/django/db/backends/utils.py:92: in _execute_with_wrappers
    return executor(sql, params, many, context)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
.venv312/lib/python3.12/site-packages/django/db/backends/utils.py:100: in _execute
    with self.db.wrap_database_errors:
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
.venv312/lib/python3.12/site-packages/django/db/utils.py:91: in __exit__
    raise dj_exc_value.with_traceback(traceback) from exc_value
.venv312/lib/python3.12/site-packages/django/db/backends/utils.py:105: in _execute
    return self.cursor.execute(sql, params)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
E   django.db.utils.OperationalError: could not receive data from server: Operation timed out
E   SSL SYSCALL error: Operation timed out
=========================== short test summary info ============================
ERROR projects/test_comments.py::test_database_rejects_invalid_event_shapes[comment_added-  ]
63 passed, 1 error in 596.69s (0:09:56)
Traceback (most recent call last):
  File "/tmp/taskboard_postgres_tests.py", line 37, in <module>
    cursor.execute(sql.SQL('DROP SCHEMA IF EXISTS {} CASCADE').format(sql.Identifier(schema)))
psycopg2.OperationalError: server closed the connection unexpectedly
	This probably means the server terminated abnormally
	before or while processing the request.
server closed the connection unexpectedly
	This probably means the server terminated abnormally
	before or while processing the request.
```
Captured: `2026-10-14T15:41:00.987023+00:00`. Exit status: `1`.

The leftover schema from this exact run was identified by its unique name and migration timestamp, then removed through a fresh connection. Application tables and data were unchanged. The recovery harness adds connection keepalives and reconnects before cleanup. It reran the failed validation group together with PostgreSQL UPDATE/DELETE/TRUNCATE enforcement and audit-failure rollback checks:

```bash
$ python /tmp/taskboard_terminal_retry_tests.py projects/test_comments.py -k "database_rejects_invalid_event_shapes or postgresql_enforces_append_only or activity_failure_rolls_back_original_change" -q --tb=short
```
```text
Running tests in an isolated PostgreSQL schema
..........                                                               [100%]
10 passed, 30 deselected in 135.59s (0:02:15)
Isolated test schema removed
```
Captured: `2026-10-14T15:57:54.891107+00:00`. Exit status: `0`.

The recovery covers the previously interrupted case. All 64 selected comments/activity tests therefore completed successfully across the initial run and targeted retry; this is not represented as a single clean 64-test run. Both the error and the successful recovery are retained for accuracy.

### Airtable helper — official SDK transport mocked only in unit tests

```bash
$ node --test integrations/airtable/test/*.test.mjs
```
```text
TAP version 13
# Subtest: exports 1,000 tasks in batches of ten with pacing
ok 1 - exports 1,000 tasks in batches of ten with pacing
  ---
  duration_ms: 2.004875
  ...
# Subtest: rerunning upserts existing tasks and persists changed/cleared values without duplicates
ok 2 - rerunning upserts existing tasks and persists changed/cleared values without duplicates
  ---
  duration_ms: 0.138584
  ...
# Subtest: retries 503 with exponential backoff
ok 3 - retries 503 with exponential backoff
  ---
  duration_ms: 0.609459
  ...
# Subtest: waits at least 30 seconds after rate limiting
ok 4 - waits at least 30 seconds after rate limiting
  ---
  duration_ms: 0.070042
  ...
# Subtest: retries transient network failures
ok 5 - retries transient network failures
  ---
  duration_ms: 0.335958
  ...
# Subtest: does not retry a permanent single-record error
ok 6 - does not retry a permanent single-record error
  ---
  duration_ms: 0.075959
  ...
# Subtest: isolates a bad record from a rejected batch and continues with all other batches
ok 7 - isolates a bad record from a rejected batch and continues with all other batches
  ---
  duration_ms: 0.312542
  ...
# Subtest: does not retry or split global HTTP 401 errors
ok 8 - does not retry or split global HTTP 401 errors
  ---
  duration_ms: 0.114625
  ...
# Subtest: does not retry or split global HTTP 403 errors
ok 9 - does not retry or split global HTTP 403 errors
  ---
  duration_ms: 0.232833
  ...
# Subtest: does not retry or split global HTTP 404 errors
ok 10 - does not retry or split global HTTP 404 errors
  ---
  duration_ms: 0.261708
  ...
# Subtest: does not retry monthly billing quota errors
ok 11 - does not retry monthly billing quota errors
  ---
  duration_ms: 0.098
  ...
# Subtest: exhausted transient failures do not prevent a later batch from succeeding
ok 12 - exhausted transient failures do not prevent a later batch from succeeding
  ---
  duration_ms: 0.0805
  ...
# Subtest: deadline returns successes and marks unattempted records without hanging
ok 13 - deadline returns successes and marks unattempted records without hanging
  ---
  duration_ms: 0.052
  ...
# Subtest: incomplete upstream response is not reported as success
ok 14 - incomplete upstream response is not reported as success
  ---
  duration_ms: 0.036667
  ...
# Subtest: empty project makes no upstream requests
ok 15 - empty project makes no upstream requests
  ---
  duration_ms: 0.023291
  ...
1..15
# tests 15
# suites 0
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40.675375
```
Captured: `2026-10-14T15:26:38.340663+00:00`. Exit status: `0`.

### Frontend — complete suite (from `frontend/`)

```bash
$ npm test -- --run
```
```text

 RUN  v2.1.9 /Users/vishal/Documents/Projects/ajackus-taskboard-assessment/frontend

 ✓ src/tests/schemas.test.ts (6 tests) 2ms
 ✓ src/tests/TaskCard.test.tsx (3 tests) 54ms
 ✓ src/tests/ProjectExport.test.tsx (6 tests) 130ms
 ✓ src/tests/TaskComments.test.tsx (6 tests) 181ms
 ✓ src/tests/TaskDetail.permissions.test.tsx (7 tests) 184ms
 ✓ src/tests/SessionPrivacy.test.tsx (6 tests) 177ms
 ✓ src/tests/TaskAssignment.test.tsx (7 tests) 305ms
 ✓ src/tests/ActivityFeed.test.tsx (12 tests) 320ms

 Test Files  8 passed (8)
      Tests  53 passed (53)
   Start at  20:58:12
   Duration  1.26s (transform 320ms, setup 491ms, collect 1.43s, tests 1.35s, environment 2.66s, prepare 483ms)

The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.
stderr | src/tests/SessionPrivacy.test.tsx > private data across sessions > never renders A's dashboard while B's request is pending
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

stderr | src/tests/TaskAssignment.test.tsx > task assignments with real backend response fields > initializes the editor with the existing assignee
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

stderr | src/tests/ActivityFeed.test.tsx > activity refresh after project actions > refreshes after task creation
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.
```
Captured: `2026-10-14T15:28:23.768770+00:00`. Exit status: `0`.

### Application source type check (from `frontend/`)

```bash
$ npx tsc --noEmit --skipLibCheck
```
```text
(no output)
```
Captured: `2026-10-14T15:28:22.015941+00:00`. Exit status: `0`.

`--skipLibCheck` excludes dependency declaration checking. The repository's pre-existing full-TypeScript dependency errors are documented in [REVIEW.md](backend/REVIEW.md); no clean full dependency type check or Docker image build is claimed.
