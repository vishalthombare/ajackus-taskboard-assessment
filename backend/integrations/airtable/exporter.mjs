export const DEFAULT_FIELDS = Object.freeze({
  taskId: 'Task ID', title: 'Name', description: 'Description', status: 'Status',
  assignee: 'Assignee Name', project: 'Project', projectId: 'Project ID',
  createdBy: 'Created By',
});

const GLOBAL_ERRORS = new Set([
  'AUTHENTICATION_REQUIRED', 'INVALID_API_KEY', 'NOT_AUTHORIZED',
  'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', 'NOT_FOUND', 'UNKNOWN_FIELD_NAME',
  'UNKNOWN_FIELD_ID', 'INVALID_UPSERT_FIELDS_TO_MERGE_ON', 'PUBLIC_API_BILLING_LIMIT_EXCEEDED',
]);
const NETWORK_CODES = new Set(['CONNECTION_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyError(error) {
  const status = error.statusCode ?? error.status;
  const code = error.error ?? error.code ?? error.name ?? 'AIRTABLE_ERROR';
  const global = GLOBAL_ERRORS.has(code) || [401, 403, 404].includes(status);
  const retryable = !global && (status === 429 || status === 408 || (status >= 500 && status <= 599)
    || NETWORK_CODES.has(code) || ['AbortError', 'TimeoutError', 'FetchError'].includes(code)
    || (code === 'UNEXPECTED_ERROR' && status >= 200 && status < 300));
  const message = [401, 403].includes(status) ? 'Airtable denied access. Check token scopes and base permissions.'
    : code === 'PUBLIC_API_BILLING_LIMIT_EXCEEDED' ? 'Airtable API quota is exhausted. Retry when the quota resets.'
    : ['UNKNOWN_FIELD_NAME', 'UNKNOWN_FIELD_ID', 'INVALID_UPSERT_FIELDS_TO_MERGE_ON'].includes(code)
      ? 'Airtable columns do not match the export configuration. Run the Airtable setup command.'
      : status === 404 ? 'The configured Airtable base or table could not be found.'
        : retryable ? 'Airtable is temporarily unavailable. You can safely export again.'
          : 'Airtable rejected this record. Check its field values and the table column types.';
  return { code: String(code), message, retryable, global, status };
}

export async function exportRecords({ client, records, keyField, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, random = Math.random, maxRetries = 3, minIntervalMs = 250, maxDurationMs = 240000 }) {
  const result = { total: records.length, exported: 0, created: 0, updated: 0, failed: 0, failures: [] };
  const deadline = now() + maxDurationMs;
  let previousRequest = -Infinity;
  let terminalError = null;
  const timeoutError = { code: 'EXPORT_DEADLINE', message: 'Export time limit reached. You can safely export again.', retryable: true, global: true };
  const fail = (items, error) => {
    for (const item of items) result.failures.push({ taskId: item.fields[keyField], code: error.code, message: error.message, retryable: error.retryable });
  };

  async function request(items) {
    for (let attempt = 0; ; attempt++) {
      const pause = Math.max(0, previousRequest + minIntervalMs - now());
      if (now() + pause + 15000 > deadline) throw timeoutError;
      if (pause) await sleep(pause);
      previousRequest = now();
      try {
        return await client.upsert(items, keyField);
      } catch (raw) {
        const error = classifyError(raw);
        if (!error.retryable || attempt >= maxRetries) throw error;
        const wait = (error.status === 429 ? 30000 : 1000) * (2 ** attempt) + Math.floor(random() * 250);
        if (now() + wait + 15000 > deadline) throw timeoutError;
        await sleep(wait);
      }
    }
  }

  async function send(items) {
    if (terminalError) { fail(items, terminalError); return; }
    try {
      const response = await request(items);
      if (!Array.isArray(response.records) || response.records.length !== items.length) {
        // An ambiguous response is not reported as success. Upsert makes a later rerun safe.
        fail(items, { code: 'INVALID_RESPONSE', message: 'Airtable returned an incomplete response. You can safely export again.', retryable: true });
        return;
      }
      result.exported += response.records.length;
      result.created += response.createdRecords?.length ?? 0;
      result.updated += response.updatedRecords?.length ?? 0;
    } catch (error) {
      if (error.global) terminalError = error;
      // Split a permanently rejected batch to isolate bad records; do not repeat that bad payload.
      if (!error.global && !error.retryable && items.length > 1) {
        const middle = Math.floor(items.length / 2);
        await send(items.slice(0, middle));
        await send(items.slice(middle));
      } else fail(items, error);
    }
  }

  for (let offset = 0; offset < records.length; offset += 10) await send(records.slice(offset, offset + 10));
  result.failed = result.failures.length;
  if (terminalError) result.error = terminalError.message;
  return result;
}
