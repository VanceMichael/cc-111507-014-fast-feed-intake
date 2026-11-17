import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSession, validateManifest } from '../src/fast/session.mjs';
import { parseTemplates } from '../src/fast/templates.mjs';
import { FastError, Cursor, PresenceMap } from '../src/fast/primitives.mjs';

const TEMPLATE_XML = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="Quote" id="1" dictionary="template">
<uInt32 name="Instrument"><copy/></uInt32>
<uInt32 name="Price" presence="optional"><delta/></uInt32>
</template></templates>`;

const FEED = Buffer.from([0xe0, 0x81, 0x8a, 0x80, 0x80, 0x80, 0xe0, 0x81, 0x8a, 0x80]);
const MANIFEST = {
  session: 'feed-a',
  templateFile: 'templates.xml',
  frames: [
    { sequence: 1, offset: 0, length: 4 },
    { sequence: 2, offset: 4, length: 2 },
    { sequence: 3, offset: 6, length: 4 },
  ],
  resets: [1],
};

test('标准来源：三帧全部解码并保留模板与字典上下文', () => {
  const result = decodeSession({ feedBytes: FEED, manifest: MANIFEST, templateXml: TEMPLATE_XML });
  assert.equal(result.state, 'complete');
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map(r => r.templateName), ['Quote', 'Quote', 'Quote']);
  assert.deepEqual(result.records.map(r => r.templateId), [1, 1, 1]);
  assert.equal(result.records[0].fields.Instrument, 10);
  assert.equal(result.records[0].fields.Price, null);
  assert.equal(result.records[2].fields.Instrument, 10);
  assert.equal(result.coverage.decodedCount, 3);
  assert.equal(result.coverage.blockedCount, 0);
});

test('记录携带 session、sequence、raw offset，且 offset 可反查原始字节', () => {
  const { records } = decodeSession({ feedBytes: FEED, manifest: MANIFEST, templateXml: TEMPLATE_XML });
  for (const record of records) {
    assert.equal(record.session, 'feed-a');
    assert.ok(Number.isInteger(record.sequence));
    assert.ok(Number.isInteger(record.offset) && Number.isInteger(record.length));
    const back = FEED.subarray(record.offset, record.offset + record.length).toString('hex');
    assert.equal(back, record.rawHex);
    assert.ok(/^[0-9a-f]{64}$/.test(record.rawDigest));
  }
});

test('稳定身份由会话、序号、偏移和摘要派生，不依赖数组下标', () => {
  const first = decodeSession({ feedBytes: FEED, manifest: MANIFEST, templateXml: TEMPLATE_XML });
  const second = decodeSession({ feedBytes: FEED, manifest: MANIFEST, templateXml: TEMPLATE_XML });
  assert.deepEqual(first.records.map(r => r.recordId), second.records.map(r => r.recordId));
  const ids = new Set(first.records.map(r => r.recordId));
  assert.equal(ids.size, 3);
  // 相同字节在不同会话中应能区分：session 进入身份与记录。
  const other = decodeSession({ feedBytes: FEED, manifest: { ...MANIFEST, session: 'feed-b' }, templateXml: TEMPLATE_XML });
  assert.notEqual(first.records[0].recordId, other.records[0].recordId);
  assert.equal(other.records[0].session, 'feed-b');
});

test('源流缺口使字典失效，重置前停止发布依赖状态的消息，只保留原文', () => {
  const gapManifest = { ...MANIFEST, frames: [
    MANIFEST.frames[0],
    { sequence: 3, offset: 4, length: 2 },
    { sequence: 4, offset: 6, length: 4 },
  ] };
  const result = decodeSession({ feedBytes: FEED, manifest: gapManifest, templateXml: TEMPLATE_XML });
  assert.equal(result.state, 'partial');
  assert.equal(result.records[0].state, 'decoded');
  for (const record of result.records.slice(1)) {
    assert.equal(record.state, 'blocked');
    assert.equal(record.fields, null);
    assert.ok(record.rawHex.length > 0); // 原文仍保留，可核对
    assert.equal(record.issues[0].code, 'SEQUENCE_GAP');
  }
  assert.ok(result.issues.some(i => i.code === 'SEQUENCE_GAP' && i.severity === 'error'));
  assert.ok(!result.coverage.complete);
});

test('合法显式重置恢复解释依据，重置后的帧可以重新解码', () => {
  const resetManifest = { ...MANIFEST, resets: [1, 4], frames: [
    MANIFEST.frames[0],
    { sequence: 3, offset: 4, length: 2 },
    { sequence: 4, offset: 6, length: 4 },
  ] };
  const result = decodeSession({ feedBytes: FEED, manifest: resetManifest, templateXml: TEMPLATE_XML });
  assert.equal(result.state, 'partial');
  const [one, gapFrame, resetFrame] = result.records;
  assert.equal(one.state, 'decoded');
  assert.equal(gapFrame.state, 'blocked');
  assert.equal(resetFrame.state, 'decoded');
  assert.equal(resetFrame.fields.Instrument, 10);
  assert.ok(result.issues.filter(i => i.code === 'DICTIONARY_RESET').length === 2);
});

test('字典作用域：template 字典不跨模板共享，copy 字段按模板分别沿用', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="A" id="1" dictionary="template"><uInt32 name="V"><copy/></uInt32></template>
<template name="B" id="2" dictionary="template"><uInt32 name="V"><copy/></uInt32></template>
</templates>`;
  parseTemplates(xml); // 先确认模板可解析
  // 手工构造三帧：模板1 V=7；模板2 V=9；再回模板1 V=0，验证 template 字典按模板隔离。
  const framesBytes = [
    Buffer.from([0xc0, 0x81, 0x87]),       // PMAP 110.., id=1, V=7
    Buffer.from([0xc0, 0x82, 0x89]),       // id=2, V=9
    Buffer.from([0xc0, 0x81, 0x80]),       // id=1, V=0
  ];
  const bytes = Buffer.concat(framesBytes);
  let offset = 0;
  const frames = framesBytes.map((part, index) => {
    const frame = { sequence: index + 1, offset, length: part.length };
    offset += part.length;
    return frame;
  });
  const manifest = { session: 's', frames, resets: [1] };
  const result = decodeSession({ feedBytes: bytes, manifest, templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.templateName), ['A', 'B', 'A']);
  assert.deepEqual(result.records.map(r => r.fields), [{ V: 7 }, { V: 9 }, { V: 0 }]);
});

test('未承诺的字段类型保留原文并形成问题，不假装完整解析', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="X" id="1"><byteVector name="Blob"/></template></templates>`;
  parseTemplates(xml);
  const bytes = Buffer.from([0xc0, 0x81, 0x80]);
  const manifest = { session: 's', frames: [{ sequence: 1, offset: 0, length: 3 }], resets: [1] };
  const result = decodeSession({ feedBytes: bytes, manifest, templateXml: xml });
  assert.equal(result.state, 'partial');
  assert.equal(result.records[0].state, 'blocked');
  assert.equal(result.records[0].issues[0].code, 'UNSUPPORTED_TYPE');
});

test('manifest 与来源字节不一致时拒绝解释，不建立虚假帧边界', () => {
  assert.throws(() => validateManifest(MANIFEST, FEED.length + 1), (error) => error.code === 'MANIFEST_INVALID');
  const overlapped = { ...MANIFEST, frames: [{ sequence: 1, offset: 0, length: 4 }, { sequence: 2, offset: 5, length: 2 }, { sequence: 3, offset: 7, length: 3 }] };
  assert.throws(() => validateManifest(overlapped, FEED.length), (error) => error.code === 'MANIFEST_INVALID');
});

test('截断帧被标记 blocked 且原文保留，后续帧不会沿用陈旧状态', () => {
  const cut = FEED.subarray(0, 7); // 最后一帧不完整；manifest 仍声明 10 字节会先在 manifest 校验拦截
  assert.throws(() => validateManifest(MANIFEST, cut.length), (error) => error.code === 'MANIFEST_INVALID');
  // 长度自洽但帧内字节截断：把第三帧长度改为 1。
  const truncatedManifest = { ...MANIFEST, frames: [
    MANIFEST.frames[0], MANIFEST.frames[1], { sequence: 3, offset: 6, length: 1 }] };
  const result = decodeSession({ feedBytes: cut, manifest: truncatedManifest, templateXml: TEMPLATE_XML });
  assert.equal(result.records[2].state, 'blocked');
  assert.equal(result.records[2].rawHex, 'e0');
  assert.equal(result.state, 'partial');
});

test('presence map 位从高到低消费，终止位不作为数据位', () => {
  const cursor = new Cursor(Buffer.from([0xe0]));
  const pmap = new PresenceMap(cursor);
  // 0xE0 = 1 1100000：最高位 1 是终止位，数据位依次为 1、1、0、0、0、0、0。
  assert.deepEqual([pmap.next(), pmap.next(), pmap.next(), pmap.next()], [1, 1, 0, 0]);
});

test('presence map 跨字节时继续按高位优先消费', () => {
  // 首字节 0x01：终止位 0，数据位 0000001；次字节 0x80：终止位 1，数据位全 0。
  const cursor = new Cursor(Buffer.from([0x01, 0x80]));
  const pmap = new PresenceMap(cursor);
  const bits = Array.from({ length: 14 }, () => pmap.next());
  assert.deepEqual(bits, [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test('模板 XML 损坏抛出可识别的中文错误', () => {
  assert.throws(() => parseTemplates('<templates><template id="1"></templates>'), (error) => error instanceof FastError && error.code === 'TEMPLATE_XML');
});
