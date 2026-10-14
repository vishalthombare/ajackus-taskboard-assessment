import pytest
from rest_framework.test import APIClient
from users.models import User


@pytest.fixture
def client():
    return APIClient()


@pytest.mark.django_db
class TestRegister:
    def test_ignores_invalid_bearer_token(self, client):
        client.credentials(HTTP_AUTHORIZATION='Bearer stale-token')
        response = client.post('/api/auth/register', {
            'email': 'test@example.com',
            'password': 'password123',
            'name': 'Test User',
        }, format='json')
        assert response.status_code == 201
        assert 'token' in response.data

    def test_creates_user_and_returns_token(self, client):
        response = client.post('/api/auth/register', {
            'email': 'test@example.com',
            'password': 'password123',
            'name': 'Test User',
        }, format='json')
        assert response.status_code == 201
        assert 'token' in response.data
        assert response.data['user']['email'] == 'test@example.com'

    def test_rejects_short_password(self, client):
        response = client.post('/api/auth/register', {
            'email': 'test@example.com',
            'password': 'short',
            'name': 'Test User',
        }, format='json')
        assert response.status_code == 400

    def test_rejects_duplicate_email(self, client):
        User.objects.create_user(email='test@example.com', name='Existing', password='password123')
        response = client.post('/api/auth/register', {
            'email': 'test@example.com',
            'password': 'password123',
            'name': 'New User',
        }, format='json')
        assert response.status_code == 400

    def test_rejects_missing_name(self, client):
        response = client.post('/api/auth/register', {
            'email': 'test@example.com',
            'password': 'password123',
        }, format='json')
        assert response.status_code == 400


@pytest.mark.django_db
class TestLogin:
    def test_ignores_token_for_deleted_user(self, client):
        from rest_framework_simplejwt.tokens import RefreshToken

        old_user = User.objects.create_user(
            email='old@example.com', name='Old', password='password123',
        )
        token = str(RefreshToken.for_user(old_user).access_token)
        old_user.delete()
        User.objects.create_user(email='test@example.com', name='Test', password='password123')
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        response = client.post('/api/auth/login', {
            'email': 'test@example.com',
            'password': 'password123',
        }, format='json')
        assert response.status_code == 200
        assert response.data['user']['email'] == 'test@example.com'

    def test_returns_token_on_valid_credentials(self, client):
        User.objects.create_user(email='test@example.com', name='Test', password='password123')
        response = client.post('/api/auth/login', {
            'email': 'test@example.com',
            'password': 'password123',
        }, format='json')
        assert response.status_code == 200
        assert 'token' in response.data
        assert response.data['user']['email'] == 'test@example.com'

    def test_rejects_wrong_password(self, client):
        User.objects.create_user(email='test@example.com', name='Test', password='password123')
        response = client.post('/api/auth/login', {
            'email': 'test@example.com',
            'password': 'wrongpassword',
        }, format='json')
        assert response.status_code == 401

    def test_rejects_missing_email(self, client):
        response = client.post('/api/auth/login', {'password': 'anything'}, format='json')
        assert response.status_code == 400

    def test_rejects_unknown_email(self, client):
        response = client.post('/api/auth/login', {
            'email': 'nobody@example.com',
            'password': 'password123',
        }, format='json')
        assert response.status_code == 401
