from django.core.management.base import BaseCommand, CommandError

from projects.airtable import AirtableExportError, field_mapping, run_helper


class Command(BaseCommand):
    help = 'Create missing Airtable export columns (requires schema.bases:read and schema.bases:write).'

    def handle(self, *args, **options):
        try:
            result = run_helper({'operation': 'prepare', 'fields': field_mapping()})
        except AirtableExportError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(self.style.SUCCESS(f"Airtable table ready: {result['tableName']} ({len(result['createdFields'])} columns added)."))
        self.stdout.write(result['baseUrl'])
