from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from django.core.exceptions import ValidationError
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models.deletion import ProtectedError
from rest_framework.test import APIClient

from projects.models import Membership, Project, Task, TaskEvent
from projects.services import record_event
from projects.views import TaskCommentsView
from users.models import User

pytestmark = pytest.mark.django_db


@pytest.fixture
def thread():
    people = {role: User.objects.create_user(email=f'{role}@comments.test', name=role.title(), password='password123')
              for role in ('admin', 'member', 'viewer', 'outsider')}
    project = Project.objects.create(name='Private', owner=people['admin'])
    for role in ('admin', 'member', 'viewer'):
        Membership.objects.create(project=project, user=people[role], role=role)
    other = Project.objects.create(name='Other', owner=people['outsider'])
    Membership.objects.create(project=other, user=people['outsider'], role='admin')
    task = Task.objects.create(project=project, title='Original', created_by=people['admin'], assignee=people['admin'])
    return people, project, task


def client_for(user=None):
    client = APIClient()
    if user:
        client.force_authenticate(user=user)
    return client


def comment(task, actor, body='Discussion', **extra):
    return TaskEvent.objects.create(task=task, actor=actor, actor_name=actor.name,
                                    event_type='comment_added', body=body, **extra)


@pytest.mark.parametrize('role, expected', [('admin', 201), ('member', 201), ('viewer', 403), ('outsider', 403)])
def test_comment_post_permissions(thread, role, expected):
    people, _, task = thread
    response = client_for(people[role]).post(f'/api/tasks/{task.id}/comments', {'body': '  Hello  '}, format='json')
    assert response.status_code == expected
    assert TaskEvent.objects.count() == (1 if expected == 201 else 0)
    if expected == 201:
        assert response.data['comment']['body'] == 'Hello'
        assert response.data['comment']['author']['id'] == str(people[role].id)


@pytest.mark.parametrize('role, expected', [('admin', 200), ('member', 200), ('viewer', 200), ('outsider', 403)])
def test_comment_read_permissions(thread, role, expected):
    people, _, task = thread
    comment(task, people['admin'])
    response = client_for(people[role]).get(f'/api/tasks/{task.id}/comments')
    assert response.status_code == expected
    if expected == 200:
        assert response.data['comments'][0]['body'] == 'Discussion'
        assert response.data['nextCursor'] is None


@pytest.mark.parametrize('method', ['get', 'post'])
def test_anonymous_comments_denied(thread, method):
    _, _, task = thread
    response = getattr(client_for(), method)(f'/api/tasks/{task.id}/comments')
    assert response.status_code == 401


@pytest.mark.parametrize('body', ['', ' \n\t ', None, 123, [], {}, 'x' * 5001])
def test_invalid_comment_rejected(thread, body):
    people, _, task = thread
    response = client_for(people['member']).post(f'/api/tasks/{task.id}/comments', {'body': body}, format='json')
    assert response.status_code == 400
    assert not TaskEvent.objects.exists()


def test_server_controls_author_type_and_timestamp(thread):
    people, _, task = thread
    response = client_for(people['member']).post(f'/api/tasks/{task.id}/comments', {
        'body': 'Authentic', 'author': str(people['admin'].id), 'actor_id': str(people['admin'].id),
        'actor_name': 'Forged', 'createdAt': '2000-01-01T00:00:00Z', 'event_type': 'task_created',
        'task_id': str(uuid4()), 'changes': {'forged': True},
    }, format='json')
    assert response.status_code == 201
    event = TaskEvent.objects.get()
    assert event.actor_id == people['member'].id
    assert event.actor_name == people['member'].name
    assert event.task_id == task.id and event.event_type == 'comment_added' and event.changes == {}
    assert event.created_at.year != 2000
    people['member'].name = 'Renamed'
    people['member'].save()
    result = client_for(people['viewer']).get(f'/api/tasks/{task.id}/comments')
    assert result.data['comments'][0]['author']['name'] == 'Member'


def test_chronology_cursor_ties_and_task_isolation(thread, monkeypatch):
    people, project, task = thread
    monkeypatch.setattr(TaskCommentsView, 'page_size', 2)
    fixed = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with patch('django.utils.timezone.now', return_value=fixed):
        for number in (3, 1, 2):
            comment(task, people['admin'], str(number), id=UUID(int=number))
        other_task = Task.objects.create(project=project, title='Other', created_by=people['admin'])
        comment(other_task, people['admin'], 'Never included')
        record_event(task, people['admin'], 'task_updated', changes={'status': {'from': 'todo', 'to': 'done'}})
    client = client_for(people['viewer'])
    first = client.get(f'/api/tasks/{task.id}/comments')
    assert [row['body'] for row in first.data['comments']] == ['1', '2']
    cursor = first.data['nextCursor']
    second = client.get(f'/api/tasks/{task.id}/comments', {'cursor': cursor})
    assert [row['body'] for row in second.data['comments']] == ['3']
    assert second.data['nextCursor'] is None
    assert client.get(f'/api/tasks/{other_task.id}/comments', {'cursor': cursor}).status_code == 400
    assert client.get(f'/api/tasks/{task.id}/comments', {'cursor': 'tampered'}).status_code == 400


def test_missing_task_and_authorization_before_validation(thread):
    people, _, task = thread
    client = client_for(people['admin'])
    assert client.get(f'/api/tasks/{uuid4()}/comments').status_code == 404
    assert client.post(f'/api/tasks/{uuid4()}/comments', {'body': 'Hi'}, format='json').status_code == 404
    response = client_for(people['viewer']).post(f'/api/tasks/{task.id}/comments', {'body': None}, format='json')
    assert response.status_code == 403


@pytest.mark.parametrize('method', ['put', 'patch', 'delete'])
def test_comments_cannot_be_modified_through_http(thread, method):
    people, _, task = thread
    event = comment(task, people['admin'])
    client = client_for(people['admin'])
    response = getattr(client, method)(f'/api/tasks/{task.id}/comments', {'body': 'Rewrite'}, format='json')
    assert response.status_code == 405
    assert getattr(client, method)(f'/api/tasks/{task.id}/comments/{event.id}').status_code == 404
    event.refresh_from_db()
    assert event.body == 'Discussion'


@pytest.mark.parametrize('operation', ['save', 'delete', 'update', 'bulk_delete', 'bulk_update'])
def test_orm_history_is_immutable(thread, operation):
    people, _, task = thread
    event = comment(task, people['admin'])
    with pytest.raises(ValidationError):
        if operation == 'save':
            event.body = 'Rewrite'
            event.save()
        elif operation == 'delete':
            event.delete()
        elif operation == 'update':
            TaskEvent.objects.filter(id=event.id).update(body='Rewrite')
        elif operation == 'bulk_delete':
            TaskEvent.objects.filter(id=event.id).delete()
        else:
            event.body = 'Rewrite'
            TaskEvent.objects.bulk_update([event], ['body'])
    event.refresh_from_db()
    assert event.body == 'Discussion'


@pytest.mark.parametrize('statement', [
    "UPDATE task_events SET body = 'Rewrite'",
    'DELETE FROM task_events',
    'TRUNCATE task_events',
])
def test_postgresql_enforces_append_only(thread, statement):
    if connection.vendor != 'postgresql':
        pytest.skip('PostgreSQL trigger verification')
    people, _, task = thread
    event = comment(task, people['admin'])
    with pytest.raises(DatabaseError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(statement)
    event.refresh_from_db()
    assert event.body == 'Discussion'


def test_parent_deletion_preserves_history(thread):
    people, project, task = thread
    comment(task, people['member'])
    client = client_for(people['admin'])
    assert client.delete(f'/api/tasks/{task.id}').status_code == 409
    assert client.delete(f'/api/projects/{project.id}').status_code == 409
    with pytest.raises(ProtectedError):
        people['member'].delete()
    assert TaskEvent.objects.count() == 1 and Task.objects.filter(id=task.id).exists()


@pytest.mark.parametrize('operation', ['create', 'update', 'comment'])
def test_activity_failure_rolls_back_original_change(thread, operation):
    people, project, task = thread
    client = client_for(people['admin'])
    original_time = task.updated_at
    with patch('projects.services.record_event', side_effect=DatabaseError('activity write failed')):
        if operation == 'create':
            response = client.post(f'/api/projects/{project.id}/tasks', {'title': 'Should roll back'}, format='json')
        elif operation == 'update':
            response = client.patch(f'/api/tasks/{task.id}', {'title': 'Should roll back', 'status': 'done'}, format='json')
        else:
            response = client.post(f'/api/tasks/{task.id}/comments', {'body': 'Should roll back'}, format='json')
    assert response.status_code == 500
    task.refresh_from_db()
    assert task.title == 'Original' and task.status == 'todo' and task.updated_at == original_time
    assert Task.objects.count() == 1 and not TaskEvent.objects.exists()


def test_task_changes_record_actual_activity_atomically(thread):
    people, project, task = thread
    client = client_for(people['admin'])
    response = client.patch(f'/api/tasks/{task.id}', {
        'status': 'done', 'assigneeId': str(people['member'].id),
    }, format='json')
    assert response.status_code == 200
    event = TaskEvent.objects.get()
    assert event.event_type == 'task_updated'
    assert event.changes == {'status': {'from': 'todo', 'to': 'done'}, 'assigneeId': {
        'from': str(people['admin'].id), 'to': str(people['member'].id),
    }}
    unchanged_time = Task.objects.get(id=task.id).updated_at
    assert client.patch(f'/api/tasks/{task.id}', {'status': 'done'}, format='json').status_code == 200
    assert TaskEvent.objects.count() == 1 and Task.objects.get(id=task.id).updated_at == unchanged_time
    created = client.post(f'/api/projects/{project.id}/tasks', {'title': 'New'}, format='json')
    assert created.status_code == 201
    assert TaskEvent.objects.filter(task_id=created.data['task']['id'], event_type='task_created').count() == 1


@pytest.mark.parametrize('event_type, body', [('unknown', None), ('comment_added', None), ('comment_added', '  '), ('task_created', 'Unexpected')])
def test_database_rejects_invalid_event_shapes(thread, event_type, body):
    people, _, task = thread
    with pytest.raises(IntegrityError), transaction.atomic():
        TaskEvent.objects.create(task=task, actor=people['admin'], actor_name='Admin', event_type=event_type, body=body)
