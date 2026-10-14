import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRecords } from '../exporter.mjs';
import { AirtableMock } from './airtable-mock.mjs';

const rows = n => Array.from({ length: n }, (_, i) => ({ fields: { 'Task ID': `task-${i}`, Name: `Task ${i}` } }));
const error = (statusCode, code = 'INVALID_VALUE_FOR_COLUMN') => Object.assign(new Error('Upstream rejected'), { statusCode, error: code });
function context(client, records, overrides = {}) {
  let time = 0;
  const waits = [];
  return { client, records, keyField: 'Task ID', now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; }, random: () => 0, waits,
    advance: ms => { time += ms; }, ...overrides };
}

test('exports 1,000 tasks in batches of ten with pacing', async () => {
  const client = new AirtableMock(), input = context(client, rows(1000));
  const result = await exportRecords(input);
  assert.equal(result.exported, 1000);
  assert.equal(result.created, 1000);
  assert.equal(result.failed, 0);
  assert.equal(client.calls.length, 100);
  assert.ok(client.calls.every(batch => batch.length <= 10));
  assert.ok(input.waits.every(ms => ms >= 250));
});

test('rerunning upserts existing tasks and persists changed/cleared values without duplicates', async () => {
  const client = new AirtableMock(), records = rows(12);
  await exportRecords(context(client, records));
  records[0].fields.Name = 'Updated title';
  records[0].fields['Assignee Name'] = '';
  const result = await exportRecords(context(client, records));
  assert.equal(client.records.size, 12);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 12);
  assert.equal(client.records.get('task-0').fields.Name, 'Updated title');
  assert.equal(client.records.get('task-0').fields['Assignee Name'], '');
});

test('retries 503 with exponential backoff', async () => {
  const client = new AirtableMock((_records, call) => { if (call < 3) throw error(503, 'SERVICE_UNAVAILABLE'); });
  const input = context(client, rows(1)), result = await exportRecords(input);
  assert.equal(result.exported, 1);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(input.waits, [1000, 2000]);
});

test('waits at least 30 seconds after rate limiting', async () => {
  const client = new AirtableMock((_records, call) => { if (call === 1) throw error(429, 'TOO_MANY_REQUESTS'); });
  const input = context(client, rows(1));
  assert.equal((await exportRecords(input)).exported, 1);
  assert.equal(input.waits[0], 30000);
});

test('retries transient network failures', async () => {
  const client = new AirtableMock((_records, call) => { if (call === 1) throw Object.assign(new Error(), { code: 'ECONNRESET' }); });
  assert.equal((await exportRecords(context(client, rows(1)))).exported, 1);
  assert.equal(client.calls.length, 2);
});

test('does not retry a permanent single-record error', async () => {
  const client = new AirtableMock(() => { throw error(422); });
  const result = await exportRecords(context(client, rows(1)));
  assert.equal(client.calls.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].retryable, false);
});

test('isolates a bad record from a rejected batch and continues with all other batches', async () => {
  const client = new AirtableMock(records => { if (records.some(row => row.fields['Task ID'] === 'task-3')) throw error(422); });
  const result = await exportRecords(context(client, rows(25)));
  assert.equal(result.exported, 24);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].taskId, 'task-3');
  assert.equal(client.records.size, 24);
});

for (const status of [401, 403, 404]) test(`does not retry or split global HTTP ${status} errors`, async () => {
  const client = new AirtableMock(() => { throw error(status); });
  const result = await exportRecords(context(client, rows(25)));
  assert.equal(client.calls.length, 1);
  assert.equal(result.failed, 25);
  assert.ok(result.error);
});

test('does not retry monthly billing quota errors', async () => {
  const client = new AirtableMock(() => { throw error(429, 'PUBLIC_API_BILLING_LIMIT_EXCEEDED'); });
  const input = context(client, rows(20)), result = await exportRecords(input);
  assert.equal(client.calls.length, 1);
  assert.equal(input.waits.length, 0);
  assert.equal(result.failed, 20);
});

test('exhausted transient failures do not prevent a later batch from succeeding', async () => {
  const client = new AirtableMock((records) => { if (records[0].fields['Task ID'] === 'task-0') throw error(503); });
  const result = await exportRecords(context(client, rows(15)));
  assert.equal(result.exported, 5);
  assert.equal(result.failed, 10);
  assert.equal(client.calls.length, 5);
});

test('deadline returns successes and marks unattempted records without hanging', async () => {
  let input;
  const client = new AirtableMock(() => input.advance(225001));
  input = context(client, rows(20));
  const result = await exportRecords(input);
  assert.equal(result.exported, 10);
  assert.equal(result.failed, 10);
  assert.equal(result.failures[0].code, 'EXPORT_DEADLINE');
});

test('incomplete upstream response is not reported as success', async () => {
  const result = await exportRecords(context({ upsert: async () => ({ records: [] }) }, rows(1)));
  assert.equal(result.exported, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, 'INVALID_RESPONSE');
});

test('empty project makes no upstream requests', async () => {
  const client = new AirtableMock(), result = await exportRecords(context(client, []));
  assert.equal(result.total, 0);
  assert.equal(client.calls.length, 0);
});
