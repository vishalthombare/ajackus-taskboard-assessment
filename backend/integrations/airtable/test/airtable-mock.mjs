// Test-only transport. Production cli.mjs imports the official SDK client, never this module.
export class AirtableMock {
  constructor(fail) { this.records = new Map(); this.calls = []; this.fail = fail; }
  async upsert(records, keyField) {
    this.calls.push(records);
    if (this.fail) await this.fail(records, this.calls.length);
    const createdRecords = [], updatedRecords = [], response = [];
    for (const item of records) {
      const key = item.fields[keyField];
      const previous = this.records.get(key);
      const id = previous?.id ?? `rec${this.records.size + 1}`;
      (previous ? updatedRecords : createdRecords).push(id);
      this.records.set(key, { id, fields: { ...item.fields } });
      response.push({ id, fields: { ...item.fields } });
    }
    return { records: response, createdRecords, updatedRecords };
  }
}
