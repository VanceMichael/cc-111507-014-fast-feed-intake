import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplates } from '../src/fast/templates.mjs';
import { FastDecoder, decodeFeed } from '../src/fast/decoder.mjs';

// 手工编码辅助：与解码器约定一致的 stop-bit 编码。
function uintBytes(value) {
  let v = BigInt(value);
  const groups = [];
  do {
    groups.unshift(Number(v & 0x7fn));
    v >>= 7n;
  } while (v > 0n);
  groups[groups.length - 1] |= 0x80;
  return groups;
}
function intBytes(value) {
  const v = BigInt(value);
  let n = 1;
  const limit = (k) => 1n << BigInt(7 * k - 1);
  while (v < -limit(n) || v > limit(n) - 1n) n += 1;
  const mod = 1n << BigInt(7 * n);
  let u = ((v % mod) + mod) % mod;
  const groups = [];
  for (let i = 0; i < n; i += 1) {
    groups.unshift(Number(u & 0x7fn));
    u >>= 7n;
  }
  groups[groups.length - 1] |= 0x80;
  return groups;
}
function pmapBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 7) {
    let byte = 0;
    for (let j = 0; j < 7; j += 1) byte |= (bits[i + j] ? 1 : 0) << (6 - j);
    bytes.push(byte);
  }
  bytes[bytes.length - 1] |= 0x80;
  return bytes;
}
function strBytes(text) {
  const bytes = [...Buffer.from(text, 'latin1')];
  bytes[bytes.length - 1] |= 0x80;
  return bytes;
}
const msg = (...parts) => Buffer.from(parts.flat());

test('操作符 copy/default/increment/delta/constant/none 与字典延续', () => {
  const compiled = compileTemplates(`<templates xmlns="http://www.fixprotocol.org/ns/fast/td/1.1">
    <template name="Ops" id="7" dictionary="template">
      <uInt32 name="A"><copy/></uInt32>
      <uInt32 name="B"><default value="7"/></uInt32>
      <uInt32 name="C"><increment/></uInt32>
      <uInt32 name="D"><delta/></uInt32>
      <uInt32 name="E"><constant value="5"/></uInt32>
      <uInt32 name="F"/>
    </template>
  </templates>`);
  const decoder = new FastDecoder(compiled);
  const first = decoder.decodeMessage(msg(
    pmapBytes([1, 1, 1, 1]), uintBytes(7), uintBytes(10), uintBytes(20), uintBytes(30), intBytes(2), uintBytes(99),
  ));
  assert.equal(first.templateId, 7);
  assert.equal(first.templateName, 'Ops');
  assert.deepEqual(first.fields, { A: 10n, B: 20n, C: 30n, D: 2n, E: 5n, F: 99n });
  // 第二条消息：模板 id 沿用，A 复制前值，B 取初始值，C 自增，D 叠加差量。
  const second = decoder.decodeMessage(msg(pmapBytes([0, 0, 0, 0]), intBytes(3), uintBytes(100)));
  assert.equal(second.templateId, 7);
  assert.deepEqual(second.fields, { A: 10n, B: 7n, C: 31n, D: 5n, E: 5n, F: 100n });
});

test('显式重置清空字典，之后不能沿用陈旧前值', () => {
  const compiled = compileTemplates(`<templates><template name="Ops" id="7" dictionary="template">
    <uInt32 name="A"><copy/></uInt32>
  </template></templates>`);
  const decoder = new FastDecoder(compiled);
  decoder.decodeMessage(msg(pmapBytes([1, 1]), uintBytes(7), uintBytes(10)));
  decoder.reset();
  // 重置同时清空模板 id 字典，重置后首帧必须显式携带模板 id。
  assert.throws(() => decoder.decodeMessage(msg(pmapBytes([0, 0]))), /模板 id 未出现/);
  assert.throws(() => decoder.decodeMessage(msg(pmapBytes([1, 0]), uintBytes(7))), /缺少可复制的前值/);
});

test('可空字段遵守 nullable 编码', () => {
  const compiled = compileTemplates(`<templates><template name="N" id="1">
    <uInt32 name="Maybe" presence="optional"/>
  </template></templates>`);
  const decoder = new FastDecoder(compiled);
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(1), uintBytes(0))).fields.Maybe, null);
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(1), uintBytes(1))).fields.Maybe, 0n);
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(1), uintBytes(11))).fields.Maybe, 10n);
});

test('可选 delta 收到空值后清空字典，不沿用陈旧基值', () => {
  const compiled = compileTemplates(`<templates><template name="D" id="1">
    <uInt32 name="Price" presence="optional"><delta/></uInt32>
  </template></templates>`);
  const decoder = new FastDecoder(compiled);
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(1), intBytes(41))).fields.Price, 40n);
  // 可空 delta 的空值编码为 0，收到后字典前值清空。
  assert.equal(decoder.decodeMessage(msg(pmapBytes([0]), intBytes(0))).fields.Price, null);
  // 空值已清空前值，下一条从缺省基值 0 重新累计。
  assert.equal(decoder.decodeMessage(msg(pmapBytes([0]), intBytes(6))).fields.Price, 5n);
});

test('ASCII string：普通值、可空、空串与 string delta', () => {
  const compiled = compileTemplates(`<templates>
    <template name="S" id="5">
      <string name="Sym"/><string name="Note" presence="optional"/>
    </template>
    <template name="SD" id="6"><string name="Text"><delta/></string></template>
  </templates>`);
  const decoder = new FastDecoder(compiled);
  const first = decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(5), strBytes('AB'), [0x80]));
  assert.deepEqual(first.fields, { Sym: 'AB', Note: null });
  const empty = decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(5), strBytes('AB'), [0x00, 0x80]));
  assert.deepEqual(empty.fields, { Sym: 'AB', Note: '' });
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(6), intBytes(0), strBytes('hello'))).fields.Text, 'hello');
  assert.equal(decoder.decodeMessage(msg(pmapBytes([0]), intBytes(3), strBytes('p'))).fields.Text, 'lop');
  assert.equal(decoder.decodeMessage(msg(pmapBytes([0]), intBytes(-2), strBytes('XY'))).fields.Text, 'XYl');
});

test('decimal 整体 delta 跨消息累计', () => {
  const compiled = compileTemplates(`<templates><template name="Px" id="4">
    <decimal name="Price"><delta/></decimal>
  </template></templates>`);
  const decoder = new FastDecoder(compiled);
  const first = decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(4), intBytes(-2), intBytes(12345)));
  assert.deepEqual(first.fields.Price, { exponent: -2n, mantissa: 12345n });
  const second = decoder.decodeMessage(msg(pmapBytes([0]), intBytes(0), intBytes(5)));
  assert.deepEqual(second.fields.Price, { exponent: -2n, mantissa: 12350n });
});

test('sequence：长度加逐元素 presence map', () => {
  const compiled = compileTemplates(`<templates><template name="Seq" id="3">
    <sequence name="Items"><uInt32 name="Id"><copy/></uInt32></sequence>
  </template></templates>`);
  const decoder = new FastDecoder(compiled);
  const decoded = decoder.decodeMessage(msg(
    pmapBytes([1]), uintBytes(3), uintBytes(2),
    pmapBytes([1]), uintBytes(7),
    pmapBytes([0]),
  ));
  assert.deepEqual(decoded.fields.Items, [{ Id: 7n }, { Id: 7n }]);
});

test('多字节 presence map 位从高到低消费', () => {
  const fields = Array.from({ length: 8 }, (_, i) => `<uInt32 name="F${i}"><copy/></uInt32>`).join('');
  const compiled = compileTemplates(`<templates><template name="Wide" id="2">${fields}</template></templates>`);
  const decoder = new FastDecoder(compiled);
  const decoded = decoder.decodeMessage(msg(
    pmapBytes([1, 1, 1, 1, 1, 1, 1, 1, 1]), uintBytes(2),
    uintBytes(10), uintBytes(11), uintBytes(12), uintBytes(13),
    uintBytes(14), uintBytes(15), uintBytes(16), uintBytes(17),
  ));
  assert.deepEqual(Object.values(decoded.fields), [10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n]);
});

test('字典作用域：global 跨模板共享，template 按模板隔离', () => {
  const shared = compileTemplates(`<templates>
    <template name="T1" id="1" dictionary="global"><uInt32 name="X"><copy/></uInt32></template>
    <template name="T2" id="2" dictionary="global"><uInt32 name="X"><copy/></uInt32></template>
  </templates>`);
  const decoder = new FastDecoder(shared);
  decoder.decodeMessage(msg(pmapBytes([1, 1]), uintBytes(1), uintBytes(10)));
  assert.equal(decoder.decodeMessage(msg(pmapBytes([1, 0]), uintBytes(2))).fields.X, 10n);
  const isolated = compileTemplates(`<templates>
    <template name="T1" id="1" dictionary="template"><uInt32 name="X"><copy/></uInt32></template>
    <template name="T2" id="2" dictionary="template"><uInt32 name="X"><copy/></uInt32></template>
  </templates>`);
  const other = new FastDecoder(isolated);
  other.decodeMessage(msg(pmapBytes([1, 1]), uintBytes(1), uintBytes(10)));
  assert.throws(() => other.decodeMessage(msg(pmapBytes([1, 0]), uintBytes(2))), /缺少可复制的前值/);
});

test('帧内未消费字节与未知模板 id 都是解码错误', () => {
  const compiled = compileTemplates(`<templates><template name="A" id="1"><uInt32 name="X"/></template></templates>`);
  const decoder = new FastDecoder(compiled);
  assert.throws(() => decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(1), uintBytes(5), [0x80])), /未消费/);
  assert.throws(() => decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(9), uintBytes(5))), /未知模板 id 9/);
});

test('未列出扩展标记为不支持，不假装完整解析', () => {
  const compiled = compileTemplates(`<templates>
    <template name="U" id="9"><byteVector name="Blob"/></template>
    <template name="T" id="10"><uInt32 name="X"><tail/></uInt32></template>
    <template name="W" id="11"><string name="S" charset="unicode"/></template>
  </templates>`);
  assert.equal(compiled.byId.get(9).status, 'unsupported');
  assert.match(compiled.byId.get(9).reason, /byteVector/);
  assert.equal(compiled.byId.get(10).status, 'unsupported');
  assert.match(compiled.byId.get(10).reason, /tail/);
  assert.equal(compiled.byId.get(11).status, 'unsupported');
  assert.match(compiled.byId.get(11).reason, /unicode/);
  const decoder = new FastDecoder(compiled);
  assert.throws(() => decoder.decodeMessage(msg(pmapBytes([1]), uintBytes(9))), /未支持特性/);
});

test('decodeFeed：缺口阻断后续帧，合法重置恢复，记录可定位', () => {
  const compiled = compileTemplates(`<templates><template name="Q" id="1" dictionary="template">
    <uInt32 name="Instrument"><copy/></uInt32>
  </template></templates>`);
  const m1 = msg(pmapBytes([1, 1]), uintBytes(1), uintBytes(10));
  const m2 = msg(pmapBytes([0, 0]));
  const bytes = Buffer.concat([m1, m2, m1]);
  const manifest = {
    session: 'feed-x',
    frames: [
      { sequence: 1, offset: 0, length: m1.length },
      { sequence: 3, offset: m1.length, length: m2.length },
      { sequence: 4, offset: m1.length + m2.length, length: m1.length },
    ],
    resets: [1, 4],
  };
  const outcome = decodeFeed({ bytes, manifest, compiled, session: 'feed-x', blobDigest: 'digest' });
  assert.equal(outcome.state, 'partial');
  assert.deepEqual(outcome.records.map((r) => r.sequence), [1, 4]);
  assert.deepEqual(outcome.records.map((r) => r.id), ['feed-x#1', 'feed-x#4']);
  assert.deepEqual(outcome.records[0].raw, { blob: 'digest', offset: 0, length: m1.length });
  assert.deepEqual(outcome.records[0].fields, { Instrument: 10 });
  const blocked = outcome.issues.filter((issue) => issue.kind === 'blocked');
  assert.deepEqual(blocked.map((issue) => issue.sequence), [3]);
  assert.deepEqual(outcome.coverage.gaps, [{ expected: 2, got: 3 }]);
  assert.deepEqual(outcome.coverage.resets, [1, 4]);
  assert.equal(outcome.coverage.complete, false);
});

test('decodeFeed：无重置时缺口之后全部阻断，不凑连续行情', () => {
  const compiled = compileTemplates(`<templates><template name="Q" id="1" dictionary="template">
    <uInt32 name="Instrument"><copy/></uInt32>
  </template></templates>`);
  const m1 = msg(pmapBytes([1, 1]), uintBytes(1), uintBytes(10));
  const bytes = Buffer.concat([m1, m1, m1]);
  const manifest = {
    session: 'feed-x',
    frames: [
      { sequence: 1, offset: 0, length: m1.length },
      { sequence: 3, offset: m1.length, length: m1.length },
      { sequence: 4, offset: m1.length * 2, length: m1.length },
    ],
    resets: [1],
  };
  const outcome = decodeFeed({ bytes, manifest, compiled, session: 'feed-x', blobDigest: 'digest' });
  assert.equal(outcome.state, 'partial');
  assert.deepEqual(outcome.records.map((r) => r.sequence), [1]);
  assert.deepEqual(outcome.coverage.blockedSequences, [3, 4]);
});

test('decodeFeed：全部无法解释时 rejected', () => {
  const compiled = compileTemplates(`<templates><template name="Q" id="1"><uInt32 name="X"/></template></templates>`);
  const manifest = { session: 's', frames: [{ sequence: 1, offset: 0, length: 2 }], resets: [] };
  const outcome = decodeFeed({ bytes: msg(pmapBytes([1]), uintBytes(9)), manifest, compiled, session: 's', blobDigest: 'd' });
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.records.length, 0);
  assert.match(outcome.issues[0].message, /未知模板 id 9/);
});
