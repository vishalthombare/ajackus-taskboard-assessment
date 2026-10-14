import pytest
from rest_framework.test import APIClient
from users.models import User
from projects.models import Project, Membership, Task


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def user(db):
    return User.objects.create_user(email='meera@taskboard.dev', name='Meera Iyer', password='password123')


@pytest.fixture
def auth_client(client, user):
    response = client.post('/api/auth/login', {
        'email': 'meera@taskboard.dev',
        'password': 'password123',
    }, format='json')
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['token']}")
    return client


@pytest.mark.django_db
class TestProjects:
    def test_create_project(self, auth_client, user):
        response = auth_client.post('/api/projects', {'name': 'My Project'}, format='json')
        assert response.status_code == 201
        assert response.data['project']['name'] == 'My Project'

    def test_list_only_returns_member_projects(self, auth_client, user):
        p1 = Project.objects.create(name='Mine', owner=user)
        Membership.objects.create(user=user, project=p1, role='admin')
        other = User.objects.create_user(email='other@example.com', name='Other', password='password123')
        p2 = Project.objects.create(name='Not Mine', owner=other)
        Membership.objects.create(user=other, project=p2, role='admin')

        response = auth_client.get('/api/projects')
        assert response.status_code == 200
        names = [p['name'] for p in response.data['projects']]
        assert 'Mine' in names
        assert 'Not Mine' not in names

    def test_get_project_detail(self, auth_client, user):
        project = Project.objects.create(name='My Project', owner=user)
        Membership.objects.create(user=user, project=project, role='admin')

        response = auth_client.get(f'/api/projects/{project.id}')
        assert response.status_code == 200
        assert response.data['project']['name'] == 'My Project'

    def test_non_member_cannot_view_project(self, client, user):
        owner = User.objects.create_user(email='owner@example.com', name='Owner', password='password123')
        project = Project.objects.create(name='Private', owner=owner)
        Membership.objects.create(user=owner, project=project, role='admin')

        resp = client.post('/api/auth/login', {'email': 'meera@taskboard.dev', 'password': 'password123'}, format='json')
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['token']}")

        response = client.get(f'/api/projects/{project.id}')
        assert response.status_code == 403


@pytest.mark.django_db
class TestTasks:
    def test_create_task(self, auth_client, user):
        project = Project.objects.create(name='P', owner=user)
        Membership.objects.create(user=user, project=project, role='admin')

        response = auth_client.post(f'/api/projects/{project.id}/tasks', {'title': 'Do a thing'}, format='json')
        assert response.status_code == 201
        assert response.data['task']['title'] == 'Do a thing'

    def test_viewers_cannot_create_tasks(self, client, user):
        owner = User.objects.create_user(email='owner@example.com', name='Owner', password='password123')
        project = Project.objects.create(name='P', owner=owner)
        Membership.objects.create(user=owner, project=project, role='admin')
        Membership.objects.create(user=user, project=project, role='viewer')

        resp = client.post('/api/auth/login', {'email': 'meera@taskboard.dev', 'password': 'password123'}, format='json')
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['token']}")

        response = client.post(f'/api/projects/{project.id}/tasks', {'title': 'A task'}, format='json')
        assert response.status_code == 403

    def test_delete_task_requires_membership(self, client, user):
        owner = User.objects.create_user(email='owner@example.com', name='Owner', password='password123')
        project = Project.objects.create(name='P', owner=owner)
        Membership.objects.create(user=owner, project=project, role='admin')
        task = Task.objects.create(project=project, title='A task', created_by=owner)

        resp = client.post('/api/auth/login', {'email': 'meera@taskboard.dev', 'password': 'password123'}, format='json')
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['token']}")

        response = client.delete(f'/api/tasks/{task.id}')
        assert response.status_code == 403


@pytest.mark.django_db
class TestTaskSearch:
    @pytest.fixture
    def search_project(self, user):
        project = Project.objects.create(name='Searchable', owner=user)
        Membership.objects.create(user=user, project=project, role='admin')
        return project

    @pytest.mark.parametrize('targeted', [False, True])
    def test_sql_payload_cannot_expose_another_projects_tasks(self, auth_client, user, search_project, targeted):
        owner = User.objects.create_user(email='private@example.com', name='Private', password='password123')
        private_project = Project.objects.create(name='Private', owner=owner)
        private_task = Task.objects.create(project=private_project, title='Private task', created_by=owner)
        payload = f"zznomatch') OR (id = '{private_task.id}') -- " if targeted else "') OR TRUE -- "

        response = auth_client.get(f'/api/projects/{search_project.id}/tasks', {'q': payload})

        assert response.status_code == 200
        assert response.data == {'tasks': []}

    @pytest.mark.parametrize('field', ['title', 'description'])
    @pytest.mark.parametrize('query', ["oWnEr'S", '%', '_', '\\'])
    def test_search_treats_special_characters_as_literal_text(self, auth_client, user, search_project, field, query):
        values = {'title': 'Ordinary title', field: f'Match {query.lower()} text'}
        match = Task.objects.create(project=search_project, created_by=user, **values)
        Task.objects.create(project=search_project, title='Unrelated', created_by=user)

        response = auth_client.get(f'/api/projects/{search_project.id}/tasks', {'q': query})

        assert response.status_code == 200
        assert [task['id'] for task in response.data['tasks']] == [str(match.id)]

    @pytest.mark.parametrize('role', ['admin', 'member', 'viewer'])
    def test_members_can_search_only_their_project(self, auth_client, user, search_project, role):
        Membership.objects.filter(user=user, project=search_project).update(role=role)
        first = Task.objects.create(project=search_project, title='Release plan', created_by=user, assignee=user, position=0)
        second = Task.objects.create(project=search_project, title='Notes', description='release details', created_by=user, position=1)
        Task.objects.create(project=search_project, title='Unrelated', created_by=user)
        other = Project.objects.create(name='Other', owner=user)
        Task.objects.create(project=other, title='Release plan', created_by=user)

        response = auth_client.get(f'/api/projects/{search_project.id}/tasks', {'q': 'RELEASE'})
        unfiltered = auth_client.get(f'/api/projects/{search_project.id}/tasks')

        assert response.status_code == 200
        assert [task['id'] for task in response.data['tasks']] == [str(first.id), str(second.id)]
        assert response.data['tasks'][0]['assignee']['id'] == str(user.id)
        assert set(response.data['tasks'][0]) == set(unfiltered.data['tasks'][0])

    @pytest.mark.parametrize('query', [None, ''])
    def test_empty_search_returns_project_tasks(self, auth_client, user, search_project, query):
        task = Task.objects.create(project=search_project, title='Task', created_by=user)
        response = auth_client.get(f'/api/projects/{search_project.id}/tasks', {} if query is None else {'q': query})
        assert response.status_code == 200
        assert [record['id'] for record in response.data['tasks']] == [str(task.id)]

    def test_non_member_cannot_search(self, auth_client, user):
        private_project = Project.objects.create(name='Private', owner=user)
        response = auth_client.get(f'/api/projects/{private_project.id}/tasks', {'q': "') OR TRUE -- "})
        assert response.status_code == 403

    def test_anonymous_cannot_search(self, client, search_project):
        response = client.get(f'/api/projects/{search_project.id}/tasks', {'q': 'Task'})
        assert response.status_code == 401
