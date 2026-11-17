import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

test('结构化收件：来源记录、可查询性及覆盖身份', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'structured' }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.ok(['complete', 'partial'].includes(result.state));
    assert.ok(Array.isArray(result.records));
    assert.ok(Array.isArray(result.issues));
    assert.equal(result.records.length, 3);
    assert.ok(JSON.stringify(result.records).includes('Quote') || JSON.stringify(result.records).includes('template'));
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    // 每条记录保留模板与字典解码所需的来源定位，且身份不依赖数组下标。
    for (const [index, record] of result.records.entries()) {
      assert.ok(record.recordId && record.recordId !== String(index));
      assert.ok(Number.isInteger(record.offset));
      assert.equal(record.session, result.coverage.session);
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
