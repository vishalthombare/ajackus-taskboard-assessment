import { createClient } from './client.mjs';
import { classifyError, DEFAULT_FIELDS, exportRecords } from './exporter.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const payload = JSON.parse(input);
  const { AIRTABLE_API_KEY: apiKey, AIRTABLE_BASE_ID: baseId, AIRTABLE_TABLE_NAME: tableName } = process.env;
  if (!apiKey || !/^app[a-zA-Z0-9]+$/.test(baseId ?? '') || !tableName) throw new Error('INVALID_CONFIGURATION');
  const client = createClient({ apiKey, baseId, tableName });
  const fields = { ...DEFAULT_FIELDS, ...payload.fields };
  let result;
  if (payload.operation === 'prepare') result = await client.prepare(fields);
  else if (payload.operation === 'verify') {
    const records = await client.listByTaskIds(payload.taskIds, fields.taskId);
    result = { count: records.length, taskIds: records.map(record => record.fields[fields.taskId]) };
  } else {
    result = await exportRecords({ client, records: payload.records, keyField: fields.taskId });
    result.baseUrl = `https://airtable.com/${baseId}`;
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const info = error.message === 'INVALID_CONFIGURATION'
    ? { code: 'INVALID_CONFIGURATION', message: 'Configure the server Airtable token, base ID, and table name.' }
    : classifyError(error);
  process.stdout.write(JSON.stringify({ error: { code: info.code, message: info.message } }));
  process.exitCode = 1;
}
