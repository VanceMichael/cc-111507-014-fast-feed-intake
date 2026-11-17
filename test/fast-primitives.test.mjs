import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FastError, Cursor, readStopBitUnsigned, readStopBitSigned,
  readInteger, readNullableInteger, readAsciiString, readDecimal, PresenceMap,
} from '../src/fast/primitives.mjs';
import { FastDictionary } from '../src/fast/decoder.mjs';

const cursorOf = (array, offset = 0) => new Cursor(Buffer.from(array), offset);

test('stop-bit 无符号整数：单字节与多字节拼接', () => {
  assert.equal(readStopBitUnsigned(cursorOf([0x80])).value, 0n);
  assert.equal(readStopBitUnsigned(cursorOf([0x81])).value, 1n);
  // 0x39 0x25 0xa5 -> (0x39<<14)|(0x25<<7)|0x25
  const multi = readStopBitUnsigned(cursorOf([0x39, 0x25, 0xa5]));
  assert.equal(multi.value, BigInt((0x39 << 14) | (0x25 << 7) | 0x25));
});

test('带符号 stop-bit 整数执行符号扩展', () => {
  assert.equal(readStopBitSigned(cursorOf([0xff])).value, -1n);
  assert.equal(readStopBitSigned(cursorOf([0xfe])).value, -2n);
  assert.equal(readStopBitSigned(cursorOf([0x81])).value, 1n);
});

test('整数越界抛出 FastError 而不是静默截断', () => {
  // uInt32 最大值 4294967295 = 0xffffffff，需要 5 个 7 位组。
  assert.throws(() => readInteger(cursorOf([0x1f, 0x7f, 0x7f, 0x7f, 0xff]), 'uInt32'),
    (error) => error instanceof FastError && error.code === 'INTEGER_OVERFLOW');
  assert.equal(readInteger(cursorOf([0x0f, 0x7f, 0x7f, 0x7f, 0xff]), 'uInt32'), 4294967295);
});

test('nullable 整数：0x80 为 null，普通值按符号量映射解码并支持负数', () => {
  assert.equal(readNullableInteger(cursorOf([0x80]), 'uInt32').value, null);
  // FAST nullable：流中数值 2v 表示非空值 v；0x82 -> v=1，0x84 -> v=2。
  assert.equal(readNullableInteger(cursorOf([0x82]), 'uInt32').value, 1);
  assert.equal(readNullableInteger(cursorOf([0x84]), 'uInt32').value, 2);
  // 多字节：值 128 编码为 256 = 2*128 -> 组 [0x02, 0x80]。
  assert.equal(readNullableInteger(cursorOf([0x02, 0x80]), 'uInt32').value, 128);
  // 负数 -1：流中 2*1 的符号量形式，末位为 1 -> 0x83。
  assert.equal(readNullableInteger(cursorOf([0x83]), 'int32').value, -1);
});

test('ASCII 字符串带长度前缀，nullable 空值标记独立', () => {
  // 长度 3，随后 "abc"。
  const result = readAsciiString(cursorOf([0x83, 0x61, 0x62, 0x63]));
  assert.equal(result.value, 'abc');
  assert.equal(readAsciiString(cursorOf([0x80]), { nullable: true }).value, null);
  assert.throws(() => readAsciiString(cursorOf([0x85, 0x61])), (error) => error.code === 'TRUNCATED');
});

test('decimal 保留指数与尾数分量，避免浮点猜测', () => {
  // 指数 -2（带符号 stop-bit 单字节 0xfe）；尾数 63 的规范编码为 0xbf。
  const decimal = readDecimal(cursorOf([0xfe, 0xbf]));
  assert.equal(decimal.value.exponent, -2);
  assert.equal(decimal.value.mantissa, 63);
  assert.equal(decimal.value.numeric, 0.63);
  // 负尾数 -64 的规范编码为 0xc0。
  const negative = readDecimal(cursorOf([0xfe, 0xc0]));
  assert.equal(negative.value.mantissa, -64);
  assert.equal(negative.value.numeric, -0.64);
  // 指数为正：指数 2（0x82），尾数 5（0x85）-> 500。
  const positiveExp = readDecimal(cursorOf([0x82, 0x85]));
  assert.equal(positiveExp.value.exponent, 2);
  assert.equal(positiveExp.value.mantissa, 5);
  assert.equal(positiveExp.value.numeric, 500);
  assert.equal(readDecimal(cursorOf([0x80, 0x80]), { nullable: true }).value, null);
});

test('字典按 global/template/type 作用域与显式 key 隔离', () => {
  const dict = new FastDictionary();
  const t1 = { name: 'F', dictionary: 'template', operator: { type: 'copy' }, type: { kind: 'integer' } };
  const t2 = { name: 'F', dictionary: 'template', operator: { type: 'copy' }, type: { kind: 'integer' } };
  dict.store(t1, 1, 100);
  dict.store(t2, 2, 200);
  assert.equal(dict.load(t1, 1).value, 100);
  assert.equal(dict.load(t2, 2).value, 200);
  const global = { name: 'G', dictionary: 'global', operator: { type: 'copy' }, type: { kind: 'integer' } };
  dict.store(global, 1, 9);
  assert.equal(dict.load(global, 2).value, 9);
  const keyedA = { name: 'K', dictionary: 'global', operator: { type: 'copy', key: { name: 'a' } }, type: { kind: 'integer' } };
  const keyedB = { name: 'K', dictionary: 'global', operator: { type: 'copy', key: { name: 'b' } }, type: { kind: 'integer' } };
  dict.store(keyedA, 1, 1);
  dict.store(keyedB, 1, 2);
  assert.equal(dict.load(keyedA, 1).value, 1);
  assert.equal(dict.load(keyedB, 1).value, 2);
  dict.reset();
  assert.equal(dict.load(t1, 1).defined, false);
  assert.equal(dict.load(global, 1).defined, false);
});

test('presence map 耗尽后继续取位报错而非返回 undefined', () => {
  const pmap = new PresenceMap(cursorOf([0x80]));
  for (let i = 0; i < 7; i += 1) pmap.next();
  assert.throws(() => pmap.next(), (error) => error.code === 'PMAP_EXHAUSTED');
});

test('截断字节在读取处被识别', () => {
  assert.throws(() => readStopBitUnsigned(cursorOf([0x39, 0x25])), (error) => error.code === 'TRUNCATED');
});
