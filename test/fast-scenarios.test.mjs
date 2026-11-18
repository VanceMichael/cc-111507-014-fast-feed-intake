import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

const feedBytes = await readFile(new URL('../fixtures/feed.fast', import.meta.url));

async function structuredIntake(scenario, dataDir) {
  const service = await createService({ dataDir, scenario });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'structured' }),
    });
    assert.equal(response.status, 201);
    return { receipt: await response.json(), service };
  } catch (error) {
    await service.close();
    throw error;
  }
}

test('standard：完整解码，记录与原始报文可相互定位', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fast-standard-'));
  const { receipt, service } = await structuredIntake('standard', dataDir);
  try {
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.session, 'feed-a');
    assert.equal(receipt.records.length, 3);
    assert.deepEqual(receipt.records.map((r) => r.id), ['feed-a#1', 'feed-a#2', 'feed-a#3']);
    assert.deepEqual(receipt.records.map((r) => r.sequence), [1, 2, 3]);
    for (const record of receipt.records) {
      assert.equal(record.templateId, 1);
      assert.equal(record.templateName, 'Quote');
      assert.equal(record.session, 'feed-a');
      assert.deepEqual(record.fields, { Instrument: 10, Price: null });
    }
    // 记录 → 原文：raw 指向内容寻址 blob 中的帧范围。
    assert.deepEqual(receipt.records.map((r) => [r.raw.offset, r.raw.length]), [[0, 4], [4, 2], [6, 4]]);
    const blob = await readFile(join(dataDir, 'blobs', receipt.records[0].raw.blob));
    assert.deepEqual(blob, feedBytes);
    for (const record of receipt.records) {
      const slice = blob.subarray(record.raw.offset, record.raw.offset + record.raw.length);
      assert.deepEqual(slice, feedBytes.subarray(record.raw.offset, record.raw.offset + record.raw.length));
    }
    // 原文 → 记录：同一 offset 能找回同一记录。
    const byOffset = new Map(receipt.records.map((r) => [r.raw.offset, r]));
    assert.equal(byOffset.get(4).id, 'feed-a#2');
    // 证据与覆盖：来源字节、版本、模板与清单的关系依据。
    assert.equal(receipt.evidence.source.etag, '"source-v1"');
    assert.equal(receipt.evidence.source.digest, receipt.records[0].raw.blob);
    assert.equal(typeof receipt.evidence.templates.digest, 'string');
    assert.equal(receipt.coverage.complete, true);
    assert.deepEqual(receipt.coverage.resets, [1]);
    assert.deepEqual(receipt.coverage.templates.names, ['Quote']);
    assert.equal(receipt.issues.length, 0);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('gap：序号缺口使字典失效，后续帧阻断且不凑连续行情', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fast-gap-'));
  const { receipt, service } = await structuredIntake('gap', dataDir);
  try {
    assert.equal(receipt.state, 'partial');
    assert.deepEqual(receipt.records.map((r) => r.sequence), [1]);
    assert.deepEqual(receipt.coverage.blockedSequences, [3, 4]);
    assert.deepEqual(receipt.coverage.gaps, [{ expected: 2, got: 3 }]);
    assert.equal(receipt.coverage.complete, false);
    const blocked = receipt.issues.filter((issue) => issue.kind === 'blocked');
    assert.equal(blocked.length, 2);
    assert.ok(blocked.every((issue) => issue.raw && Number.isInteger(issue.raw.offset)));
    assert.ok(receipt.issues.some((issue) => issue.kind === 'sequence-gap'));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('explicit-reset：合法重置恢复解释依据', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fast-reset-'));
  const { receipt, service } = await structuredIntake('explicit-reset', dataDir);
  try {
    assert.equal(receipt.state, 'partial');
    assert.deepEqual(receipt.records.map((r) => r.sequence), [1, 4]);
    assert.deepEqual(receipt.coverage.blockedSequences, [3]);
    assert.deepEqual(receipt.coverage.resets, [1, 4]);
    assert.deepEqual(receipt.records[1].fields, { Instrument: 10, Price: null });
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('missing-template：完全无法解释时 rejected，原文仍保留', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fast-missing-'));
  const { receipt, service } = await structuredIntake('missing-template', dataDir);
  try {
    assert.equal(receipt.state, 'rejected');
    assert.equal(receipt.records.length, 0);
    assert.ok(receipt.issues.some((issue) => /模板不可取得/.test(issue.message)));
    assert.equal(receipt.coverage.complete, false);
    const entry = receipt.blobs.find((blob) => blob.role === 'entry');
    const blob = await readFile(join(dataDir, 'blobs', entry.digest));
    assert.deepEqual(blob, feedBytes);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('新实例打开相同 DATA_DIR 仍可查询既有结构化收件', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fast-persist-'));
  const first = await structuredIntake('standard', dataDir);
  await first.service.close();
  const reopened = await createService({ dataDir, scenario: 'standard' });
  try {
    const saved = await (await fetch(`${reopened.baseUrl}/v1/receipts/${first.receipt.id}`)).json();
    assert.deepEqual(saved.records, first.receipt.records);
    assert.deepEqual(saved.coverage, first.receipt.coverage);
    assert.deepEqual(saved.evidence, first.receipt.evidence);
  } finally {
    await reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
