from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from django.core import signing
from rest_framework.test import APIClient

from projects.models import Membership, Project, Task, TaskEvent
from projects.services import record_event
from projects.views import ProjectActivityView
from users.models import User

pytestmark = pytest.mark.django_db


@pytest.fixture
def activity_project():
    people = {role: User.objects.create_user(email=f'{role}@activity.test', name=role.title(), password='password123')
              for role in ('admin', 'member', 'viewer', 'outsider')}
    project = Project.objects.create(name='Activity project', owner=people['admin'])
    for role in ('admin', 'member', 'viewer'):
        Membership.objects.create(project=project, user=people[role], role=role)
    other = Project.objects.create(name='Other project', owner=people['outsider'])
    Membership.objects.create(project=other, user=people['outsider'], role='admin')
    task = Task.objects.create(project=project, title='Task label', created_by=people['admin'])
    other_task = Task.objects.create(project=other, title='Private elsewhere', created_by=people['outsider'])
    return people, project, task, other, other_task


def client_for(user=None):
    client = APIClient()
    if user:
        client.force_authenticate(user=user)
    return client


@pytest.mark.parametrize('role, expected', [('admin', 200), ('member', 200), ('viewer', 200), ('outsider', 403)])
def test_activity_read_permissions_and_project_isolation(activity_project, role, expected):
    people, project, task, _, other_task = activity_project
    event = record_event(task, people['admin'], 'task_created')
    record_event(other_task, people['outsider'], 'comment_added', body='Must remain private')
    response = client_for(people[role]).get(f'/api/projects/{project.id}/activity')
    assert response.status_code == expected
    if expected == 200:
        assert [row['id'] for row in response.data['activity']] == [str(event.id)]
        assert response.data['nextCursor'] is None
    else:
        assert response.data == {'error': 'forbidden'}


def test_activity_requires_authentication_and_checks_access_before_cursor(activity_project):
    people, project, _, _, _ = activity_project
    path = f'/api/projects/{project.id}/activity'
    assert client_for().get(path).status_code == 401
    assert client_for(people['outsider']).get(path, {'cursor': 'bad'}).status_code == 403
    assert client_for(people['admin']).get(f'/api/projects/{uuid4()}/activity').status_code == 403


def test_empty_activity(activity_project):
    people, project, _, _, _ = activity_project
    response = client_for(people['viewer']).get(f'/api/projects/{project.id}/activity')
    assert response.data == {'activity': [], 'nextCursor': None}


def test_actual_task_and_comment_writes_appear_newest_first(activity_project):
    people, project, _, _, _ = activity_project
    writer = client_for(people['member'])
    created = writer.post(f'/api/projects/{project.id}/tasks', {'title': 'New work'}, format='json')
    assert created.status_code == 201
    task_id = created.data['task']['id']
    assert writer.patch(f'/api/tasks/{task_id}', {'status': 'done'}, format='json').status_code == 200
    assert writer.patch(f'/api/tasks/{task_id}', {'assigneeId': str(people['viewer'].id)}, format='json').status_code == 200
    assert writer.post(f'/api/tasks/{task_id}/comments', {'body': 'Ready for review'}, format='json').status_code == 201
    response = client_for(people['viewer']).get(f'/api/projects/{project.id}/activity')
    rows = response.data['activity']
    assert [row['eventType'] for row in rows] == ['comment_added', 'task_updated', 'task_updated', 'task_created']
    assert all(row['actor'] == {'id': str(people['member'].id), 'name': 'Member'} for row in rows)
    assert all(row['task'] == {'id': task_id, 'title': 'New work'} for row in rows)
    assert [row['createdAt'] for row in rows] == sorted((row['createdAt'] for row in rows), reverse=True)
    assert rows[0]['body'] == 'Ready for review'
    assert rows[1]['changes']['assigneeId'] == {
        'from': None, 'to': str(people['viewer'].id), 'fromName': None, 'toName': 'Viewer',
    }
    assert rows[2]['changes']['status'] == {'from': 'todo', 'to': 'done'}
    # A no-op must neither create history nor reorder the feed.
    count = TaskEvent.objects.count()
    assert writer.patch(f'/api/tasks/{task_id}', {'status': 'done'}, format='json').status_code == 200
    assert TaskEvent.objects.count() == count


def test_chronology_pagination_ties_and_new_events(activity_project, monkeypatch):
    people, project, task, other, _ = activity_project
    monkeypatch.setattr(ProjectActivityView, 'page_size', 2)
    fixed = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with patch('django.utils.timezone.now', return_value=fixed):
        for number in (1, 3, 2):
            TaskEvent.objects.create(id=UUID(int=number), task=task, actor=people['admin'], actor_name='Admin', event_type='task_created')
    client = client_for(people['admin'])
    first = client.get(f'/api/projects/{project.id}/activity')
    assert [row['id'] for row in first.data['activity']] == [str(UUID(int=3)), str(UUID(int=2))]
    cursor = first.data['nextCursor']
    with patch('django.utils.timezone.now', return_value=fixed + timedelta(seconds=1)):
        newest = record_event(task, people['member'], 'comment_added', body='New arrival')
    second = client.get(f'/api/projects/{project.id}/activity', {'cursor': cursor})
    assert [row['id'] for row in second.data['activity']] == [str(UUID(int=1))]
    assert second.data['nextCursor'] is None
    assert client.get(f'/api/projects/{project.id}/activity').data['activity'][0]['id'] == str(newest.id)
    Membership.objects.create(project=other, user=people['admin'], role='viewer')
    assert client.get(f'/api/projects/{other.id}/activity', {'cursor': cursor}).status_code == 400


@pytest.mark.parametrize('payload', [
    None, [], {}, {'time': 'not-a-time', 'id': str(uuid4())},
    {'time': '2026-01-01T00:00:00', 'id': str(uuid4())},
    {'time': '2026-01-01T00:00:00Z', 'id': 'bad'},
    {'time': 123, 'id': str(uuid4())}, {'time': '2026-01-01T00:00:00Z', 'id': 123},
])
def test_invalid_signed_cursors_rejected(activity_project, payload):
    people, project, _, _, _ = activity_project
    if isinstance(payload, dict):
        payload = {'project': str(project.id), **payload}
    cursor = signing.dumps(payload, salt=ProjectActivityView.cursor_salt)
    response = client_for(people['admin']).get(f'/api/projects/{project.id}/activity', {'cursor': cursor})
    assert response.status_code == 400


def test_tampered_cursor_rejected(activity_project):
    people, project, _, _, _ = activity_project
    assert client_for(people['admin']).get(f'/api/projects/{project.id}/activity', {'cursor': 'tampered'}).status_code == 400


def test_actor_snapshot_and_assignment_details_do_not_rewrite_history(activity_project):
    people, project, task, _, _ = activity_project
    changes = {'assigneeId': {'from': str(people['admin'].id), 'to': None}}
    event = record_event(task, people['admin'], 'task_updated', changes=changes)
    people['admin'].name = 'Renamed admin'
    people['admin'].save()
    row = client_for(people['viewer']).get(f'/api/projects/{project.id}/activity').data['activity'][0]
    assert row['actor']['name'] == 'Admin'
    assert row['changes']['assigneeId']['fromName'] == 'Renamed admin'
    assert row['changes']['assigneeId']['toName'] is None
    event.refresh_from_db()
    assert event.changes == changes


def test_missing_former_assignee_is_still_readable(activity_project):
    people, project, task, _, _ = activity_project
    record_event(task, people['admin'], 'task_updated', changes={'assigneeId': {'from': str(uuid4()), 'to': None}})
    row = client_for(people['viewer']).get(f'/api/projects/{project.id}/activity').data['activity'][0]
    assert row['changes']['assigneeId']['fromName'] == 'Former user'


def test_activity_query_count_is_bounded(activity_project, django_assert_num_queries):
    people, project, task, _, _ = activity_project
    for _ in range(10):
        record_event(task, people['admin'], 'task_updated', changes={'assigneeId': {
            'from': str(people['admin'].id), 'to': str(people['member'].id),
        }})
    with django_assert_num_queries(3):
        response = client_for(people['viewer']).get(f'/api/projects/{project.id}/activity')
        assert len(response.data['activity']) == 10


@pytest.mark.parametrize('method', ['post', 'put', 'patch', 'delete'])
def test_feed_is_read_only(activity_project, method):
    people, project, task, _, _ = activity_project
    record_event(task, people['admin'], 'task_created')
    response = getattr(client_for(people['admin']), method)(f'/api/projects/{project.id}/activity', {}, format='json')
    assert response.status_code == 405
    assert TaskEvent.objects.count() == 1
