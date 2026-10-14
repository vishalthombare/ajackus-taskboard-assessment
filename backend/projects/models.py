import uuid
from django.db import models
from django.conf import settings
from django.core.exceptions import ValidationError


class Project(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, null=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='owned_projects')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'projects'


class Membership(models.Model):
    ROLE_CHOICES = [('admin', 'Admin'), ('member', 'Member'), ('viewer', 'Viewer')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='memberships')
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='memberships')
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default='member')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'memberships'
        unique_together = ('user', 'project')


class Task(models.Model):
    STATUS_CHOICES = [
        ('todo', 'To Do'),
        ('in_progress', 'In Progress'),
        ('review', 'Review'),
        ('done', 'Done'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='tasks')
    title = models.CharField(max_length=500)
    description = models.TextField(blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='todo')
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='assigned_tasks',
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='created_tasks',
    )
    position = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'tasks'
        indexes = [models.Index(fields=['project', 'status'], name='tasks_project_status_idx')]


class TaskEventQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ValidationError('Task history is append-only.')

    def delete(self):
        raise ValidationError('Task history is append-only.')

    def bulk_update(self, objs, fields, batch_size=None):
        raise ValidationError('Task history is append-only.')


class TaskEvent(models.Model):
    EVENT_TYPES = [('comment_added', 'Comment'), ('task_created', 'Task created'), ('task_updated', 'Task updated')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='events')
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='task_events')
    actor_name = models.CharField(max_length=200)
    event_type = models.CharField(max_length=32, choices=EVENT_TYPES)
    body = models.CharField(max_length=5000, null=True, blank=True)
    changes = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = TaskEventQuerySet.as_manager()

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError('Task history is append-only.')
        kwargs['force_insert'] = True
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError('Task history is append-only.')

    class Meta:
        db_table = 'task_events'
        ordering = ['created_at', 'id']
        indexes = [
            models.Index(fields=['task', 'event_type', 'created_at', 'id'], name='task_comments_order_idx'),
            models.Index(fields=['task', 'created_at', 'id'], name='task_events_order_idx'),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(event_type='comment_added', body__isnull=False, body__regex=r'\S')
                    | models.Q(event_type__in=['task_created', 'task_updated'], body__isnull=True)
                ),
                name='task_event_body_type_valid',
            ),
        ]
