import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSession } from '../src/fast/session.mjs';

// 构造帧的辅助：dataBits 为 PMAP 数据位（最高位优先），自动补终止位与填零。
function frame({ dataBits, templateId, payload }) {
  let byte = 0x80; // 终止位
  dataBits.forEach((bit, index) => {
    if (bit) byte |= 1 << (6 - index);
  });
  return Buffer.from([byte, ...(templateId === null ? [] : [0x80 | templateId]), ...payload]);
}
function manifestFor(frames, resets = [1]) {
  let offset = 0;
  return {
    session: 'op-session',
    frames: frames.map((bytes, index) => {
      const item = { sequence: index + 1, offset, length: bytes.length };
      offset += bytes.length;
      return item;
    }),
    resets,
  };
}

test('copy 操作符跨消息沿用字典值，显式重置后重新开始', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="C" id="1" dictionary="global"><uInt32 name="V"><copy/></uInt32></template></templates>`;
  // 强制 copy 不占位：PMAP 只有模板位。三帧分别给 7、8、9。
  const frames = [
    frame({ dataBits: [1], templateId: 1, payload: [0x87] }),
    frame({ dataBits: [1], templateId: 1, payload: [0x88] }),
    frame({ dataBits: [1], templateId: 1, payload: [0x89] }),
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields.V), [7, 8, 9]);
});

test('可选 copy：存在位 0 时沿用上一个字典值，无字典值则报错并 blocked', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="C" id="1" dictionary="global"><uInt32 name="V" presence="optional"><copy/></uInt32></template></templates>`;
  // 帧1：PMAP 11（模板+字段），V=5；帧2：PMAP 10（仅模板，字段存在位 0）沿用 5。
  const frames = [
    frame({ dataBits: [1, 1], templateId: 1, payload: [0x8a] }), // 5 的 nullable 非空编码为 0x8a
    frame({ dataBits: [1, 0], templateId: 1, payload: [] }),
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields.V), [5, 5]);
});

test('可选 copy 首帧存在位即 0：无字典可沿用，标记 blocked 且不编造值', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="C" id="1" dictionary="global"><uInt32 name="V" presence="optional"><copy/></uInt32></template></templates>`;
  // 首帧字段存在位为 0，字典尚无初值。
  const frames = [frame({ dataBits: [1, 0], templateId: 1, payload: [] })];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'partial');
  assert.equal(result.records[0].state, 'blocked');
  assert.equal(result.records[0].fields, null);
  assert.equal(result.records[0].issues[0].code, 'DICT_UNDEFINED');
});

test('delta 操作符在字典基准上累加，null 重置基准为 null', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="D" id="1" dictionary="global"><int32 name="V"><delta/></int32></template></templates>`;
  // 强制 delta 不占位。帧1 基准 10；帧2 增量 +3 -> 13；帧3 增量 -2 -> 11。
  const frames = [
    frame({ dataBits: [1], templateId: 1, payload: [0x8a] }), // 10
    frame({ dataBits: [1], templateId: 1, payload: [0x83] }), // 3
    frame({ dataBits: [1], templateId: 1, payload: [0xfe] }), // -2
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields.V), [10, 13, 11]);
});

test('increment 操作符：流中给值后按字典递增', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="I" id="1" dictionary="global"><uInt32 name="N"><increment/></uInt32></template></templates>`;
  // 强制 increment 始终在流中：100、101、105。
  const frames = [
    frame({ dataBits: [1], templateId: 1, payload: [0xe4] }), // 100
    frame({ dataBits: [1], templateId: 1, payload: [0xe5] }), // 101
    frame({ dataBits: [1], templateId: 1, payload: [0xe9] }), // 105
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields.N), [100, 101, 105]);
});

test('constant 与 default 操作符按模板声明取值', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="T" id="1" dictionary="global">
<uInt32 name="K"><constant value="42"/></uInt32>
<uInt32 name="D" presence="optional"><default value="7"/></uInt32>
</template></templates>`;
  // 强制 constant 不占位且不在流中；可选 default 占一位。帧1 default 出现给 9；帧2 default 缺失取 7。
  const frames = [
    frame({ dataBits: [1, 1], templateId: 1, payload: [0x92] }), // nullable 9 -> 0x92(=2*9|0x80)
    frame({ dataBits: [1, 0], templateId: 1, payload: [] }),
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields), [{ K: 42, D: 9 }, { K: 42, D: 7 }]);
});

test('none 可选字段：存在位 0 返回 null，不查字典', () => {
  const xml = `<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
<template name="N" id="1" dictionary="global"><uInt32 name="V" presence="optional"><none/></uInt32></template></templates>`;
  const frames = [
    frame({ dataBits: [1, 1], templateId: 1, payload: [0x82] }), // nullable 1
    frame({ dataBits: [1, 0], templateId: 1, payload: [] }),    // 缺失 -> null
  ];
  const result = decodeSession({ feedBytes: Buffer.concat(frames), manifest: manifestFor(frames), templateXml: xml });
  assert.equal(result.state, 'complete', JSON.stringify(result.issues));
  assert.deepEqual(result.records.map(r => r.fields.V), [1, null]);
});
