from django.core.management.base import BaseCommand, CommandError
from users.models import User
from projects.models import Project, Membership, Task, TaskEvent


class Command(BaseCommand):
    help = 'Seed the database with sample data'

    def handle(self, *args, **options):
        if TaskEvent.objects.exists():
            raise CommandError('Seed refuses to erase task history. Use a fresh development database.')
        self.stdout.write('seeding...')

        Task.objects.all().delete()
        Membership.objects.all().delete()
        Project.objects.all().delete()
        User.objects.all().delete()

        meera = User.objects.create_user(email='meera@taskboard.dev', name='Meera Iyer',  password='password123')
        arjun = User.objects.create_user(email='arjun@taskboard.dev', name='Arjun Rao',   password='password123')
        kavya = User.objects.create_user(email='kavya@example.com',   name='Kavya Reddy', password='password123')
        dev   = User.objects.create_user(email='dev@example.com',     name='Dev Sharma',  password='password123')
        lina  = User.objects.create_user(email='lina@example.com',    name='Lina Joshi',  password='password123')

        launch = Project.objects.create(
            name='Q3 Launch',
            description='Coordinate the Q3 product launch across engineering, design, and marketing.',
            owner=meera,
        )
        Membership.objects.create(user=meera,  project=launch, role='admin')
        Membership.objects.create(user=arjun,  project=launch, role='member')
        Membership.objects.create(user=kavya,  project=launch, role='member')
        Membership.objects.create(user=dev,    project=launch, role='viewer')

        onboarding = Project.objects.create(
            name='Customer Onboarding Revamp',
            description='Reduce time-to-first-value from 9 days to under 3 days.',
            owner=arjun,
        )
        Membership.objects.create(user=arjun,  project=onboarding, role='admin')
        Membership.objects.create(user=meera,  project=onboarding, role='member')
        Membership.objects.create(user=lina,   project=onboarding, role='member')

        tools = Project.objects.create(
            name='Internal Tools Cleanup',
            description='Retire legacy admin tools and consolidate into the new console.',
            owner=meera,
        )
        Membership.objects.create(user=meera, project=tools, role='admin')

        launch_tasks = [
            ('Finalize launch date with marketing', 'done',        meera, 0),
            ('Draft press release',                 'review',       arjun, 1),
            ('Record demo video',                   'in_progress',  kavya, 2),
            ('Set up analytics dashboards',         'in_progress',  arjun, 3),
            ('Prepare customer email blast',        'todo',         kavya, 4),
            ('Update pricing page copy',            'todo',         None,  5),
            ('QA the new signup flow end-to-end',   'todo',         arjun, 6),
        ]
        for title, task_status, assignee, position in launch_tasks:
            Task.objects.create(
                project=launch,
                title=title,
                description=f'Detail for: {title}',
                status=task_status,
                assignee=assignee,
                created_by=meera,
                position=position,
            )

        onboarding_tasks = [
            ('Map current onboarding funnel',            'done',        arjun, 0),
            ('Interview 5 recently-onboarded customers', 'review',       lina,  1),
            ('Wireframe new welcome screens',            'in_progress',  meera, 2),
            ('Audit current onboarding emails',          'todo',         lina,  3),
            ('Define success metric (TTFV target)',      'todo',         arjun, 4),
        ]
        for title, task_status, assignee, position in onboarding_tasks:
            Task.objects.create(
                project=onboarding,
                title=title,
                description=f'Detail for: {title}',
                status=task_status,
                assignee=assignee,
                created_by=arjun,
                position=position,
            )

        self.stdout.write(self.style.SUCCESS('seed complete.'))
        self.stdout.write('login with any of these (password: password123):')
        self.stdout.write('  meera@taskboard.dev   — admin on Q3 Launch, Internal Tools')
        self.stdout.write('  arjun@taskboard.dev   — admin on Onboarding, member on Q3 Launch')
        self.stdout.write('  kavya@example.com     — member on Q3 Launch')
        self.stdout.write('  dev@example.com       — viewer on Q3 Launch')
        self.stdout.write('  lina@example.com      — member on Onboarding')
