import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function intake(service, body = { mode: 'structured' }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
}

test('结构化收件：标准来源返回完整记录且可再次查询', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-ok-'));
  const service = await createService({ dataDir });
  try {
    const { status, result } = await intake(service);
    assert.equal(status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.records.length, 3);
    assert.ok(result.records.every(r => r.templateName === 'Quote'));
    assert.ok(result.records.every(r => typeof r.recordId === 'string' && r.recordId.length >= 16));
    // 原始报文与解码记录可相互定位。
    const feed = await readFile(new URL('../fixtures/feed.fast', import.meta.url));
    for (const record of result.records) {
      assert.equal(feed.subarray(record.offset, record.offset + record.length).toString('hex'), record.rawHex);
      assert.equal(record.session, 'feed-a');
    }
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    assert.ok(Array.isArray(saved.evidence) && saved.evidence.map(e => e.role).sort().join(',') === 'feed,manifest,templates');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：新进程打开同一 DATA_DIR 仍可查询既有结果', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-persist-'));
  const service = await createService({ dataDir });
  let id;
  try {
    const { result } = await intake(service);
    id = result.id;
  } finally {
    await service.close();
  }
  const reopened = await createService({ dataDir });
  try {
    const saved = await (await fetch(`${reopened.baseUrl}/v1/receipts/${id}`)).json();
    assert.equal(saved.state, 'complete');
    assert.equal(saved.records.length, 3);
    assert.equal(saved.mode, 'structured');
  } finally {
    await reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('缺口场景：缺口后停止发布依赖状态的消息，partial 且原文保留', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-gap-'));
  const service = await createService({ dataDir, scenario: 'gap' });
  try {
    const { result } = await intake(service);
    assert.equal(result.state, 'partial');
    assert.ok(!result.coverage.complete);
    const blocked = result.records.filter(r => r.state === 'blocked');
    assert.equal(blocked.length, 2);
    assert.ok(blocked.every(r => r.fields === null && r.rawHex.length > 0));
    assert.ok(result.issues.some(i => i.code === 'SEQUENCE_GAP'));
    // 缺口后的记录绝不能携带沿用陈旧字典拼出的字段值。
    assert.ok(blocked.every(r => r.templateId === null));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('显式重置场景：重置帧恢复解释依据，重置后记录重新可解码', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-reset-'));
  const service = await createService({ dataDir, scenario: 'explicit-reset' });
  try {
    const { result } = await intake(service);
    assert.equal(result.state, 'partial');
    const states = result.records.map(r => r.state);
    assert.deepEqual(states, ['decoded', 'blocked', 'decoded']);
    assert.deepEqual(result.records[2].fields.Instrument, 10);
    assert.ok(result.coverage.explicitResets.includes(4));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('模板缺失：形成 rejected 收件但不丢失已领取的原文证据', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-notpl-'));
  const service = await createService({ dataDir, scenario: 'missing-template' });
  try {
    const { status, result } = await intake(service);
    assert.equal(status, 201);
    assert.equal(result.state, 'rejected');
    assert.ok(result.issues.some(i => i.code === 'TEMPLATE_UNAVAILABLE'));
    assert.ok(result.blobs.some(b => b.role === 'feed'));
    assert.ok(result.evidence.some(e => e.role === 'feed'));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('未知 mode 返回 400，raw 模式行为保持不变', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-mode-'));
  const service = await createService({ dataDir });
  try {
    const bad = await intake(service, { mode: 'side-channel' });
    assert.equal(bad.status, 400);
    const raw = await intake(service, { mode: 'raw' });
    assert.equal(raw.status, 201);
    assert.equal(raw.result.state, 'received');
    assert.equal(raw.result.coverage.structured, false);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
