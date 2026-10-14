import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from projects.airtable import AirtableExportError, DEFAULT_FIELDS, export_project, field_mapping, run_helper
from projects.models import Membership, Project, Task
from users.models import User


@pytest.fixture
def project_data(db):
    owner = User.objects.create_user(email='export-owner@example.com', name='Owner', password='password123')
    user = User.objects.create_user(email='export-user@example.com', name='User', password='password123')
    project = Project.objects.create(name='Export project', owner=owner)
    Membership.objects.create(user=owner, project=project, role='admin')
    task = Task.objects.create(project=project, title='Export task', description='Details', created_by=owner, assignee=user)
    return owner, user, project, task


@pytest.mark.parametrize('role, expected', [('admin', 200), ('member', 200), ('viewer', 403), (None, 403)])
def test_export_authorization(project_data, role, expected):
    _, user, project, _ = project_data
    if role:
        Membership.objects.create(user=user, project=project, role=role)
    else:
        other = Project.objects.create(name='Other', owner=user)
        Membership.objects.create(user=user, project=other, role='admin')
    client = APIClient()
    client.force_authenticate(user=user)
    summary = {'total': 1, 'exported': 1, 'created': 1, 'updated': 0, 'failed': 0, 'failures': []}
    with patch('projects.views.export_project', return_value=summary) as export:
        response = client.post(f'/api/projects/{project.id}/export', {}, format='json')
    assert response.status_code == expected
    assert export.call_count == (1 if expected == 200 else 0)
    if expected == 200:
        assert response.data == summary


def test_anonymous_export_denied(project_data):
    _, _, project, _ = project_data
    with patch('projects.views.export_project') as export:
        assert APIClient().post(f'/api/projects/{project.id}/export').status_code == 401
        export.assert_not_called()


def test_export_fetches_only_current_project_and_maps_all_fields(project_data, monkeypatch):
    owner, _, project, task = project_data
    monkeypatch.delenv('AIRTABLE_FIELD_MAP', raising=False)
    other = Project.objects.create(name='Other', owner=owner)
    Task.objects.create(project=other, title='Must not export', created_by=owner)
    with patch('projects.airtable.run_helper', return_value={'exported': 1, 'failures': []}) as helper:
        export_project(project)
    payload = helper.call_args.args[0]
    assert payload['operation'] == 'export'
    assert len(payload['records']) == 1
    fields = payload['records'][0]['fields']
    assert fields['Task ID'] == str(task.id)
    assert fields['Project ID'] == str(project.id)
    assert fields['Name'] == 'Export task' and fields['Assignee Name'] == 'User'
    assert fields['Description'] == 'Details' and fields['Status'] == 'todo'
    assert fields['Created By'] == owner.name and fields['Project'] == project.name
    assert set(fields) == {
        'Task ID', 'Name', 'Description', 'Status', 'Assignee Name',
        'Project', 'Project ID', 'Created By',
    }
    task.assignee = None
    task.description = None
    task.save()
    with patch('projects.airtable.run_helper', return_value={'exported': 1, 'failures': []}) as helper:
        export_project(project)
    fields = helper.call_args.args[0]['records'][0]['fields']
    assert fields['Assignee Name'] == '' and fields['Description'] == ''


def test_empty_export_requires_no_external_request(project_data):
    owner, _, _, _ = project_data
    empty = Project.objects.create(name='Empty', owner=owner)
    with patch('projects.airtable.run_helper') as helper:
        result = export_project(empty)
    helper.assert_not_called()
    assert result == {'total': 0, 'exported': 0, 'created': 0, 'updated': 0, 'failed': 0, 'failures': []}


@pytest.mark.parametrize('result, status', [
    ({'total': 2, 'exported': 1, 'created': 1, 'updated': 0, 'failed': 1, 'failures': [{'taskId': 'bad', 'code': 'INVALID_VALUE'}]}, 200),
    ({'total': 2, 'exported': 0, 'failed': 2, 'failures': [], 'error': 'Airtable denied access.'}, 502),
])
def test_partial_and_global_upstream_results(project_data, result, status):
    owner, _, project, _ = project_data
    client = APIClient()
    client.force_authenticate(user=owner)
    with patch('projects.views.export_project', return_value=result):
        response = client.post(f'/api/projects/{project.id}/export')
    assert response.status_code == status
    assert response.data == result


def test_configuration_failure_is_actionable_without_leaking_credentials(project_data):
    owner, _, project, _ = project_data
    client = APIClient()
    client.force_authenticate(user=owner)
    with patch('projects.views.export_project', side_effect=AirtableExportError('Configure Airtable credentials.')):
        response = client.post(f'/api/projects/{project.id}/export')
    assert response.status_code == 503
    assert response.data == {'error': 'Configure Airtable credentials.'}


@pytest.mark.parametrize('config', ['[]', '{"unknown":"Field"}', '{"title":"Task ID"}', '{"title":""}', 'invalid'])
def test_invalid_field_mapping_rejected(monkeypatch, config):
    monkeypatch.setenv('AIRTABLE_FIELD_MAP', config)
    with pytest.raises(AirtableExportError):
        field_mapping()


def test_custom_column_mapping(monkeypatch):
    monkeypatch.setenv('AIRTABLE_FIELD_MAP', '{"title":"Title"}')
    assert field_mapping() == {**DEFAULT_FIELDS, 'title': 'Title'}


@pytest.fixture
def helper_config(monkeypatch):
    monkeypatch.setenv('AIRTABLE_API_KEY', 'pat-test-only')
    monkeypatch.setenv('AIRTABLE_BASE_ID', 'appTest')
    monkeypatch.setenv('AIRTABLE_TABLE_NAME', 'Tasks')
    monkeypatch.setenv('AIRTABLE_NODE_BINARY', sys.executable)
    monkeypatch.setenv('POSTGRES_PASSWORD', 'must-not-reach-worker')
    monkeypatch.setattr(Path, 'is_dir', lambda _path: True)


def test_bridge_uses_stdin_and_limits_child_environment(helper_config):
    with patch('projects.airtable.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"exported":1}')) as run:
        assert run_helper({'records': []}) == {'exported': 1}
    args, kwargs = run.call_args
    assert 'pat-test-only' not in str(args)
    assert json.loads(kwargs['input']) == {'records': []}
    assert kwargs['env']['AIRTABLE_API_KEY'] == 'pat-test-only'
    assert 'POSTGRES_PASSWORD' not in kwargs['env']
    assert kwargs['timeout'] == 260


@pytest.mark.parametrize('failure', [subprocess.TimeoutExpired('node', 260), OSError('sensitive details')])
def test_helper_process_failures_are_sanitized(helper_config, failure):
    with patch('projects.airtable.subprocess.run', side_effect=failure):
        with pytest.raises(AirtableExportError) as error:
            run_helper({'records': []})
    assert 'sensitive details' not in str(error.value)


def test_invalid_helper_output_is_sanitized(helper_config):
    with patch('projects.airtable.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout='SECRET malformed output')):
        with pytest.raises(AirtableExportError) as error:
            run_helper({'records': []})
    assert 'SECRET' not in str(error.value)
