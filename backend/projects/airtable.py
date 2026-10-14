import json
import os
from pathlib import Path
import shutil
import subprocess

from django.conf import settings


DEFAULT_FIELDS = {
    'taskId': 'Task ID', 'title': 'Name', 'description': 'Description', 'status': 'Status',
    'assignee': 'Assignee Name', 'project': 'Project', 'projectId': 'Project ID',
    'createdBy': 'Created By',
}


class AirtableExportError(Exception):
    pass


def field_mapping():
    try:
        overrides = json.loads(os.environ.get('AIRTABLE_FIELD_MAP', '{}'))
        if not isinstance(overrides, dict) or not set(overrides).issubset(DEFAULT_FIELDS):
            raise ValueError
        fields = {**DEFAULT_FIELDS, **overrides}
        if any(not isinstance(name, str) or not name.strip() for name in fields.values()):
            raise ValueError
        if len(set(fields.values())) != len(fields):
            raise ValueError
        return fields
    except (ValueError, TypeError):
        raise AirtableExportError('AIRTABLE_FIELD_MAP must contain unique, non-empty column names.') from None


def run_helper(payload):
    token = os.environ.get('AIRTABLE_API_KEY')
    base_id = os.environ.get('AIRTABLE_BASE_ID')
    table_name = os.environ.get('AIRTABLE_TABLE_NAME')
    if not all((token, base_id, table_name)):
        raise AirtableExportError('Configure AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and AIRTABLE_TABLE_NAME on the server.')
    node = os.environ.get('AIRTABLE_NODE_BINARY') or shutil.which('node')
    if not node or not Path(node).is_file():
        raise AirtableExportError('Configure AIRTABLE_NODE_BINARY with the server Node.js executable.')
    helper = settings.BASE_DIR / 'integrations' / 'airtable' / 'cli.mjs'
    if not (helper.parent / 'node_modules' / 'airtable').is_dir():
        raise AirtableExportError('Install the export helper dependencies with npm ci in backend/integrations/airtable.')
    environment = {key: os.environ[key] for key in ('PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'NO_PROXY') if key in os.environ}
    environment.update(AIRTABLE_API_KEY=token, AIRTABLE_BASE_ID=base_id, AIRTABLE_TABLE_NAME=table_name)
    try:
        process = subprocess.run(
            [node, str(helper)], input=json.dumps(payload), capture_output=True, text=True,
            env=environment, cwd=helper.parent, timeout=260, check=False,
        )
    except subprocess.TimeoutExpired:
        raise AirtableExportError('Export timed out. Some tasks may have reached Airtable; exporting again safely updates them.') from None
    except OSError:
        raise AirtableExportError('The server could not start the Airtable export helper.') from None
    try:
        result = json.loads(process.stdout)
    except (ValueError, TypeError):
        raise AirtableExportError('The Airtable export helper failed. Check the server installation.') from None
    if process.returncode or not isinstance(result, dict):
        error = result.get('error') if isinstance(result, dict) else None
        message = error.get('message') if isinstance(error, dict) else None
        raise AirtableExportError(message or 'Airtable export failed. Check the server configuration.')
    return result


def export_project(project):
    fields = field_mapping()
    tasks = project.tasks.select_related('assignee', 'created_by').order_by('created_at', 'id')
    records = []
    for task in tasks:
        values = {
            'taskId': str(task.id), 'title': task.title, 'description': task.description or '',
            'status': task.status, 'assignee': task.assignee.name if task.assignee else '',
            'project': project.name, 'projectId': str(project.id), 'createdBy': task.created_by.name,
        }
        records.append({'fields': {fields[key]: value for key, value in values.items()}})
    if not records:
        return {'total': 0, 'exported': 0, 'created': 0, 'updated': 0, 'failed': 0, 'failures': []}
    result = run_helper({'operation': 'export', 'fields': fields, 'records': records})
    titles = {item['fields'][fields['taskId']]: item['fields'][fields['title']] for item in records}
    for failure in result.get('failures', []):
        failure['title'] = titles.get(failure['taskId'], failure['taskId'])
    return result
