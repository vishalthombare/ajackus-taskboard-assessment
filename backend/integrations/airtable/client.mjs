import Airtable from 'airtable';
import { DEFAULT_FIELDS } from './exporter.mjs';

export function createClient({ apiKey, baseId, tableName }) {
  const sdk = new Airtable({ apiKey, noRetryIfRateLimited: true, requestTimeout: 15000 });
  const base = sdk.base(baseId);
  return {
    async upsert(records, keyField) {
      const response = await base.makeRequest({ method: 'PATCH', path: '/' + encodeURIComponent(tableName), body: {
        records, performUpsert: { fieldsToMergeOn: [keyField] }, typecast: true,
      } });
      return response.body;
    },
    async listByTaskIds(taskIds, keyField) {
      if (!taskIds.length) return [];
      const safeField = keyField.replace(/[{}]/g, '');
      const formula = 'OR(' + taskIds.map(id => `{${safeField}}='${String(id).replace(/['\\]/g, '')}'`).join(',') + ')';
      return base(tableName).select({ filterByFormula: formula, pageSize: 100 }).all();
    },
    async prepare(fields = DEFAULT_FIELDS) {
      const meta = sdk.base('meta');
      const response = await meta.makeRequest({ path: `/bases/${baseId}/tables` });
      const table = response.body.tables.find(item => item.id === tableName || item.name === tableName);
      if (!table) throw Object.assign(new Error('Table not found'), { statusCode: 404, error: 'NOT_FOUND' });
      const types = { description: 'multilineText' };
      const created = [];
      for (const [key, name] of Object.entries(fields)) {
        const existing = table.fields.find(field => field.name === name);
        if (existing) {
          if (key === 'taskId' && !['singleLineText', 'multilineText'].includes(existing.type)) {
            throw Object.assign(new Error('Task ID must be text'), { statusCode: 422, error: 'INVALID_UPSERT_FIELDS_TO_MERGE_ON' });
          }
          continue;
        }
        const type = types[key] ?? 'singleLineText';
        const body = { name, type };
        await meta.makeRequest({ method: 'POST', path: `/bases/${baseId}/tables/${table.id}/fields`, body });
        created.push(name);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { tableId: table.id, tableName: table.name, createdFields: created, baseUrl: `https://airtable.com/${baseId}/${table.id}` };
    },
  };
}
