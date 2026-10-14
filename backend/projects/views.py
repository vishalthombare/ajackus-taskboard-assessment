from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from uuid import UUID
from django.core import signing
from django.db import DatabaseError
from django.db.models import Q
from django.db.models.deletion import ProtectedError
from django.utils.dateparse import parse_datetime
from django.utils.timezone import is_aware
from users.serializers import UserSerializer
from .models import Project, Membership, Task, TaskEvent
from .serializers import ProjectDetailSerializer, TaskSerializer, CommentCreateSerializer, CommentSerializer
from . import services


def _get_membership(user, project_id):
    try:
        return Membership.objects.get(user=user, project_id=project_id)
    except Membership.DoesNotExist:
        return None


def _can_edit_tasks(role):
    return role in ('admin', 'member')


class ProjectListCreateView(APIView):
    def get(self, request):
        memberships = (
            Membership.objects
            .filter(user=request.user)
            .select_related('project__owner')
            .prefetch_related('project__tasks')
            .order_by('-project__created_at')
        )
        projects = []
        for m in memberships:
            p = m.project
            projects.append({
                'id': str(p.id),
                'name': p.name,
                'description': p.description,
                'role': m.role,
                'owner': UserSerializer(p.owner).data,
                'taskCount': p.tasks.count(),
                'createdAt': p.created_at.isoformat(),
            })
        return Response({'projects': projects})

    def post(self, request):
        name = (request.data.get('name') or '').strip()
        description = request.data.get('description') or None
        if not name or len(name) > 120:
            return Response({'error': 'invalid input'}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects.create(name=name, description=description, owner=request.user)
        Membership.objects.create(user=request.user, project=project, role='admin')
        return Response(
            {'project': {'id': str(project.id), 'name': project.name}},
            status=status.HTTP_201_CREATED,
        )


class ProjectDetailView(APIView):
    def get(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        try:
            project = (
                Project.objects
                .prefetch_related('memberships__user', 'tasks__assignee', 'tasks__created_by')
                .select_related('owner')
                .get(id=project_id)
            )
        except Project.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response({'project': ProjectDetailSerializer(project).data})

    def patch(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if membership.role != 'admin':
            return Response({'error': 'only admins can update projects'}, status=status.HTTP_403_FORBIDDEN)
        try:
            project = Project.objects.get(id=project_id)
        except Project.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        if 'name' in request.data:
            project.name = request.data['name'].strip()
        if 'description' in request.data:
            project.description = request.data['description'] or None
        project.save()
        return Response({'project': {'id': str(project.id), 'name': project.name}})

    def delete(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if membership.role != 'admin':
            return Response({'error': 'only admins can delete projects'}, status=status.HTTP_403_FORBIDDEN)
        try:
            project = Project.objects.get(id=project_id)
        except Project.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        try:
            project.delete()
        except ProtectedError:
            return Response({'error': 'Projects with task history cannot be deleted.'}, status=status.HTTP_409_CONFLICT)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TaskListCreateView(APIView):
    def get(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)

        tasks = (
            Task.objects
            .filter(project_id=project_id)
            .select_related('assignee')
            .order_by('status', 'position')
        )
        q = request.query_params.get('q')
        if q:
            tasks = tasks.filter(
                Q(title__icontains=q) | Q(description__icontains=q)
            ).order_by('position')
        return Response({'tasks': TaskSerializer(tasks, many=True).data})

    def post(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if not _can_edit_tasks(membership.role):
            return Response({'error': 'viewers cannot create tasks'}, status=status.HTTP_403_FORBIDDEN)

        title = (request.data.get('title') or '').strip()
        if not title:
            return Response({'error': 'title is required'}, status=status.HTTP_400_BAD_REQUEST)

        task_status = request.data.get('status', 'todo')
        if task_status not in ('todo', 'in_progress', 'review', 'done'):
            return Response({'error': 'invalid status'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            task = services.create_task(
                project_id, request.user, title=title,
                description=request.data.get('description') or None, status=task_status,
                assignee_id=request.data.get('assigneeId') or None,
            )
        except Project.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        except DatabaseError:
            return Response({'error': 'Task and activity could not be saved. Please retry.'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        task_data = TaskSerializer(Task.objects.select_related('assignee').get(id=task.id)).data
        return Response({'task': task_data}, status=status.HTTP_201_CREATED)


class TaskDetailView(APIView):
    def patch(self, request, task_id):
        try:
            task = Task.objects.get(id=task_id)
        except Task.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

        membership = _get_membership(request.user, task.project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if not _can_edit_tasks(membership.role):
            return Response({'error': 'viewers cannot update tasks'}, status=status.HTTP_403_FORBIDDEN)

        updates = {}
        if 'title' in request.data:
            updates['title'] = request.data['title'].strip()
        if 'description' in request.data:
            updates['description'] = request.data['description'] or None
        if 'status' in request.data:
            new_status = request.data['status']
            if new_status not in ('todo', 'in_progress', 'review', 'done'):
                return Response({'error': 'invalid status'}, status=status.HTTP_400_BAD_REQUEST)
            updates['status'] = new_status
        if 'assigneeId' in request.data:
            updates['assignee_id'] = request.data['assigneeId'] or None
        try:
            services.update_task(task.id, request.user, updates)
        except Task.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        except DatabaseError:
            return Response({'error': 'Task and activity could not be saved. Please retry.'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        task_data = TaskSerializer(Task.objects.select_related('assignee').get(id=task_id)).data
        return Response({'task': task_data})

    def delete(self, request, task_id):
        try:
            task = Task.objects.select_related('project').get(id=task_id)
        except Task.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

        membership = _get_membership(request.user, str(task.project_id))
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if not _can_edit_tasks(membership.role):
            return Response({'error': 'viewers cannot delete tasks'}, status=status.HTTP_403_FORBIDDEN)

        try:
            task.delete()
        except ProtectedError:
            return Response({'error': 'Tasks with history cannot be deleted.'}, status=status.HTTP_409_CONFLICT)
        return Response({'ok': True})


class TaskCommentsView(APIView):
    page_size = 50
    cursor_salt = 'task-comments-v1'

    def _get_task(self, request, task_id):
        try:
            task = Task.objects.get(id=task_id)
        except Task.DoesNotExist:
            return None, Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        if not _get_membership(request.user, task.project_id):
            return None, Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        return task, None

    def get(self, request, task_id):
        task, error = self._get_task(request, task_id)
        if error is not None:
            return error
        comments = TaskEvent.objects.filter(task=task, event_type='comment_added')
        cursor = request.query_params.get('cursor')
        if cursor:
            try:
                value = signing.loads(cursor, salt=self.cursor_salt)
                timestamp = parse_datetime(value['time'])
                event_id = UUID(value['id'])
                if value['task'] != str(task.id) or timestamp is None or not is_aware(timestamp):
                    raise ValueError('invalid cursor')
            except (signing.BadSignature, ValueError, TypeError, KeyError):
                return Response({'error': 'invalid cursor'}, status=status.HTTP_400_BAD_REQUEST)
            comments = comments.filter(Q(created_at__gt=timestamp) | Q(created_at=timestamp, id__gt=event_id))
        page = list(comments.order_by('created_at', 'id')[:self.page_size + 1])
        next_cursor = None
        if len(page) > self.page_size:
            page = page[:self.page_size]
            last = page[-1]
            next_cursor = signing.dumps({'task': str(task.id), 'time': last.created_at.isoformat(), 'id': str(last.id)}, salt=self.cursor_salt)
        return Response({'comments': CommentSerializer(page, many=True).data, 'nextCursor': next_cursor})

    def post(self, request, task_id):
        task, error = self._get_task(request, task_id)
        if error is not None:
            return error
        membership = _get_membership(request.user, task.project_id)
        if not membership or not _can_edit_tasks(membership.role):
            return Response({'error': 'viewers cannot post comments'}, status=status.HTTP_403_FORBIDDEN)
        serializer = CommentCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'invalid comment', 'details': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        try:
            comment = services.add_comment(task.id, request.user, serializer.validated_data['body'])
        except Task.DoesNotExist:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        except DatabaseError:
            return Response({'error': 'Comment could not be saved. Please retry.'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return Response({'comment': CommentSerializer(comment).data}, status=status.HTTP_201_CREATED)


class MemberAddView(APIView):
    def post(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if membership.role != 'admin':
            return Response({'error': 'only admins can add members'}, status=status.HTTP_403_FORBIDDEN)

        email = (request.data.get('email') or '').strip()
        role = request.data.get('role', 'member')
        if role not in ('admin', 'member', 'viewer'):
            return Response({'error': 'invalid role'}, status=status.HTTP_400_BAD_REQUEST)

        from users.models import User as UserModel
        try:
            user = UserModel.objects.get(email=email)
        except UserModel.DoesNotExist:
            return Response({'error': 'user not found'}, status=status.HTTP_404_NOT_FOUND)

        membership_obj, created = Membership.objects.get_or_create(
            user=user,
            project_id=project_id,
            defaults={'role': role},
        )
        if not created:
            membership_obj.role = role
            membership_obj.save()

        return Response({'ok': True, 'role': membership_obj.role}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class ExportView(APIView):
    def post(self, request, project_id):
        membership = _get_membership(request.user, project_id)
        if not membership:
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if not _can_edit_tasks(membership.role):
            return Response({'error': 'only admins and members can export'}, status=status.HTTP_403_FORBIDDEN)

        tasks = Task.objects.filter(project_id=project_id).select_related('assignee', 'created_by')
        return Response({'exported': 0, 'tasks': TaskSerializer(tasks, many=True).data})
