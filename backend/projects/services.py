from uuid import UUID

from django.db import transaction
from rest_framework.exceptions import PermissionDenied

from .models import Membership, Project, Task, TaskEvent


def _require_editor(actor, project_id):
    membership = Membership.objects.select_for_update().filter(user=actor, project_id=project_id).first()
    if not membership or membership.role not in ('admin', 'member'):
        raise PermissionDenied('Only project admins and members can write.')


def record_event(task, actor, event_type, *, body=None, changes=None):
    return TaskEvent.objects.create(
        task=task, actor=actor, actor_name=actor.name, event_type=event_type,
        body=body, changes=changes or {},
    )


@transaction.atomic
def create_task(project_id, actor, **values):
    Project.objects.select_for_update().get(id=project_id)
    _require_editor(actor, project_id)
    last = Task.objects.filter(project_id=project_id, status=values['status']).order_by('-position').first()
    task = Task.objects.create(project_id=project_id, created_by=actor, position=last.position + 1 if last else 0, **values)
    record_event(task, actor, 'task_created', changes={
        'title': {'from': None, 'to': task.title},
        'status': {'from': None, 'to': task.status},
        'assigneeId': {'from': None, 'to': str(task.assignee_id) if task.assignee_id else None},
    })
    return task


@transaction.atomic
def update_task(task_id, actor, values):
    task = Task.objects.select_for_update().get(id=task_id)
    _require_editor(actor, task.project_id)
    changes = {}
    for field, value in values.items():
        value = Task._meta.get_field(field).to_python(value)
        previous = getattr(task, field)
        if previous != value:
            key = 'assigneeId' if field == 'assignee_id' else field
            changes[key] = {
                'from': str(previous) if isinstance(previous, UUID) else previous,
                'to': str(value) if isinstance(value, UUID) else value,
            }
            setattr(task, field, value)
    if changes:
        task.save()
        record_event(task, actor, 'task_updated', changes=changes)
    return task


@transaction.atomic
def add_comment(task_id, actor, body):
    task = Task.objects.select_for_update().get(id=task_id)
    _require_editor(actor, task.project_id)
    return record_event(task, actor, 'comment_added', body=body)
