// FAST 1.1 解码：presence map 最高位为终止位、位从高到低消费；
// 可选字段遵守 nullable 编码；模板 id 可沿用；字典作用域 global/template/type 及 key。
// 解码状态（字典）在帧之间延续；源流序号缺口或解码失败使解释依据失效，
// 之后帧保留原文并报告 blocked，直到清单声明的重置帧恢复，不从输出数值猜测重置。
import { INTEGER_TYPES } from './templates.mjs';

export class FastDecodeError extends Error {}

export class UnsupportedTemplateError extends FastDecodeError {
  constructor(template) {
    super(`模板 ${template.name}（id ${template.id}）包含未支持特性：${template.reason}`);
    this.templateId = template.id;
  }
}

const STOP_BIT = 0x80;
const MAX_INT_BYTES = 10;
const MAX_STRING_BYTES = 1 << 20;
const MAX_PMAP_BYTES = 1024;
const MAX_SEQUENCE_LENGTH = 1_000_000n;
const MAX_SAFE = 9007199254740991n;

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  get remaining() { return this.bytes.length - this.pos; }
  readByte() {
    if (this.pos >= this.bytes.length) throw new FastDecodeError('报文截断');
    return this.bytes[this.pos++];
  }
  readUnsigned() {
    let value = 0n;
    for (let count = 1; ; count += 1) {
      const byte = this.readByte();
      value = (value << 7n) | BigInt(byte & 0x7f);
      if (byte & STOP_BIT) return value;
      if (count >= MAX_INT_BYTES) throw new FastDecodeError('整数编码超出长度限制');
    }
  }
  readSigned() {
    let value = 0n;
    let negative = false;
    for (let count = 1; ; count += 1) {
      const byte = this.readByte();
      if (count === 1) negative = (byte & 0x40) !== 0;
      value = (value << 7n) | BigInt(byte & 0x7f);
      if (byte & STOP_BIT) {
        if (negative) value -= 1n << BigInt(7 * count);
        return value;
      }
      if (count >= MAX_INT_BYTES) throw new FastDecodeError('整数编码超出长度限制');
    }
  }
  readStringBytes() {
    const out = [];
    for (;;) {
      const byte = this.readByte();
      out.push(byte & 0x7f);
      if (byte & STOP_BIT) return Buffer.from(out);
      if (out.length > MAX_STRING_BYTES) throw new FastDecodeError('字符串超出长度限制');
    }
  }
}

class PresenceMap {
  constructor(bytes) { this.bytes = bytes; this.index = 0; }
  static read(reader) {
    const bytes = [];
    for (;;) {
      const byte = reader.readByte();
      bytes.push(byte & 0x7f);
      if (byte & STOP_BIT) return new PresenceMap(bytes);
      if (bytes.length >= MAX_PMAP_BYTES) throw new FastDecodeError('presence map 超出长度限制');
    }
  }
  next() {
    const byteIndex = (this.index / 7) | 0;
    if (byteIndex >= this.bytes.length) throw new FastDecodeError('presence map 位数不足');
    const bit = (this.bytes[byteIndex] >> (6 - (this.index % 7))) & 1;
    this.index += 1;
    return bit === 1;
  }
}

class Dictionaries {
  constructor() { this.reset(); }
  reset() {
    this.global = new Map();
    this.template = new Map();
    this.type = new Map();
  }
  entry(scope, template) {
    if (scope === 'global') return this.global;
    const holder = scope === 'template' ? this.template : this.type;
    const id = scope === 'template' ? String(template.id) : (template.typeRef || template.name);
    let map = holder.get(id);
    if (!map) {
      map = new Map();
      holder.set(id, map);
    }
    return map;
  }
}

function checkRange(value, spec, fieldName) {
  const { signed, bits } = spec;
  const ok = signed
    ? value >= -(1n << BigInt(bits - 1)) && value <= (1n << BigInt(bits - 1)) - 1n
    : value >= 0n && value <= (1n << BigInt(bits)) - 1n;
  if (!ok) throw new FastDecodeError(`字段 ${fieldName} 的值超出 ${bits} 位${signed ? '有符号' : '无符号'}范围`);
  return value;
}

function readIntegerValue(reader, spec, optional, fieldName) {
  if (spec.signed) {
    let value = reader.readSigned();
    if (optional) {
      if (value === 0n) return null;
      if (value > 0n) value -= 1n;
    }
    return checkRange(value, spec, fieldName);
  }
  let value = reader.readUnsigned();
  if (optional) {
    if (value === 0n) return null;
    value -= 1n;
  }
  return checkRange(value, spec, fieldName);
}

function readStringValue(reader, optional) {
  const bytes = reader.readStringBytes();
  // 可空 NULL 编码为单个 0x80；空串编码为 0x00 0x80；强制空串同样使用单个 0x80。
  if (bytes.length === 1 && bytes[0] === 0) return optional ? null : '';
  if (bytes.length === 2 && bytes[0] === 0 && bytes[1] === 0) return '';
  return bytes.toString('latin1');
}

function dictionaryEntry(ctx, operator) {
  return { map: ctx.dictionaries.entry(operator.dictionary, ctx.template), key: operator.key };
}

function decodeIntegerField(field, ctx) {
  const { reader, pmap } = ctx;
  const op = field.operator;
  const spec = field.spec;
  const read = () => readIntegerValue(reader, spec, field.optional, field.name);
  switch (op.kind) {
    case 'none':
      return read();
    case 'constant':
      return field.optional ? (pmap.next() ? op.initial : null) : op.initial;
    case 'default':
      if (pmap.next()) return read();
      if (op.initial !== undefined) return op.initial;
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少默认初始值`);
    case 'copy': {
      const { map, key } = dictionaryEntry(ctx, op);
      if (pmap.next()) {
        const value = read();
        if (value === null) map.delete(key); else map.set(key, value);
        return value;
      }
      if (map.has(key)) return map.get(key);
      if (op.initial !== undefined) {
        if (op.initial !== null) map.set(key, op.initial);
        return op.initial;
      }
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少可复制的前值`);
    }
    case 'increment': {
      const { map, key } = dictionaryEntry(ctx, op);
      if (pmap.next()) {
        const value = read();
        if (value === null) map.delete(key); else map.set(key, value);
        return value;
      }
      let value;
      if (map.has(key)) value = map.get(key) + 1n;
      else if (op.initial !== undefined) value = op.initial;
      else if (field.optional) return null;
      else throw new FastDecodeError(`字段 ${field.name} 缺少可自增的前值`);
      map.set(key, checkRange(value, spec, field.name));
      return value;
    }
    case 'delta': {
      const { map, key } = dictionaryEntry(ctx, op);
      const delta = readIntegerValue(reader, { signed: true, bits: spec.bits }, field.optional, field.name);
      if (delta === null) {
        map.delete(key);
        return null;
      }
      const base = map.has(key) ? map.get(key) : (op.initial !== undefined ? op.initial : 0n);
      const value = checkRange(base + delta, spec, field.name);
      map.set(key, value);
      return value;
    }
    default:
      throw new FastDecodeError(`字段 ${field.name} 的操作符 ${op.kind} 未支持`);
  }
}

function decodeStringField(field, ctx) {
  const { reader, pmap } = ctx;
  const op = field.operator;
  switch (op.kind) {
    case 'none':
      return readStringValue(reader, field.optional);
    case 'constant':
      return field.optional ? (pmap.next() ? op.initial : null) : op.initial;
    case 'default':
      if (pmap.next()) return readStringValue(reader, field.optional);
      if (op.initial !== undefined) return op.initial;
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少默认初始值`);
    case 'copy': {
      const { map, key } = dictionaryEntry(ctx, op);
      if (pmap.next()) {
        const value = readStringValue(reader, field.optional);
        if (value === null) map.delete(key); else map.set(key, value);
        return value;
      }
      if (map.has(key)) return map.get(key);
      if (op.initial !== undefined) {
        if (op.initial !== null) map.set(key, op.initial);
        return op.initial;
      }
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少可复制的前值`);
    }
    case 'delta': {
      const { map, key } = dictionaryEntry(ctx, op);
      const count = readIntegerValue(reader, { signed: true, bits: 32 }, field.optional, field.name);
      if (count === null) {
        map.delete(key);
        return null;
      }
      const diff = readStringValue(reader, false);
      const base = map.has(key) ? map.get(key) : (op.initial ?? '');
      const value = count >= 0n
        ? base.slice(Number(count)) + diff
        : diff + base.slice(0, Math.max(0, base.length + Number(count)));
      map.set(key, value);
      return value;
    }
    default:
      throw new FastDecodeError(`字段 ${field.name} 的操作符 ${op.kind} 未支持`);
  }
}

function readDecimalParts(reader, optional, fieldName) {
  const exponent = readIntegerValue(reader, { signed: true, bits: 32 }, optional, fieldName);
  if (exponent === null) return null;
  const mantissa = readIntegerValue(reader, { signed: true, bits: 64 }, false, fieldName);
  return { exponent, mantissa };
}

function decodeDecimalField(field, ctx) {
  const { reader, pmap } = ctx;
  if (field.mode === 'individual') {
    const exponent = decodeIntegerField({
      name: `${field.name}.exponent`, spec: { signed: true, bits: 32 },
      optional: field.optional, operator: field.exponent,
    }, ctx);
    if (exponent === null) return null;
    const mantissa = decodeIntegerField({
      name: `${field.name}.mantissa`, spec: { signed: true, bits: 64 },
      optional: false, operator: field.mantissa,
    }, ctx);
    return { exponent, mantissa };
  }
  const op = field.operator;
  switch (op.kind) {
    case 'none':
      return readDecimalParts(reader, field.optional, field.name);
    case 'constant':
      return field.optional ? (pmap.next() ? op.initial : null) : op.initial;
    case 'default':
      if (pmap.next()) return readDecimalParts(reader, field.optional, field.name);
      if (op.initial !== undefined) return op.initial;
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少默认初始值`);
    case 'copy': {
      const { map, key } = dictionaryEntry(ctx, op);
      if (pmap.next()) {
        const value = readDecimalParts(reader, field.optional, field.name);
        if (value === null) map.delete(key); else map.set(key, value);
        return value;
      }
      if (map.has(key)) return map.get(key);
      if (op.initial !== undefined) {
        if (op.initial !== null) map.set(key, op.initial);
        return op.initial;
      }
      if (field.optional) return null;
      throw new FastDecodeError(`字段 ${field.name} 缺少可复制的前值`);
    }
    case 'delta': {
      const { map, key } = dictionaryEntry(ctx, op);
      const exponentDelta = readIntegerValue(reader, { signed: true, bits: 32 }, field.optional, field.name);
      if (exponentDelta === null) {
        map.delete(key);
        return null;
      }
      const mantissaDelta = readIntegerValue(reader, { signed: true, bits: 64 }, false, field.name);
      const base = map.has(key) ? map.get(key) : (op.initial ?? { exponent: 0n, mantissa: 0n });
      const value = {
        exponent: checkRange(base.exponent + exponentDelta, { signed: true, bits: 32 }, field.name),
        mantissa: checkRange(base.mantissa + mantissaDelta, { signed: true, bits: 64 }, field.name),
      };
      map.set(key, value);
      return value;
    }
    default:
      throw new FastDecodeError(`字段 ${field.name} 的操作符 ${op.kind} 未支持`);
  }
}

function decodeSequenceField(field, ctx) {
  const { reader } = ctx;
  const count = decodeIntegerField({
    name: field.length.name, spec: { signed: false, bits: 32 },
    optional: field.optional, operator: field.length.operator,
  }, ctx);
  if (count === null) return null;
  if (count > MAX_SEQUENCE_LENGTH) throw new FastDecodeError(`序列 ${field.name} 长度超出限制`);
  const items = [];
  for (let index = 0; index < Number(count); index += 1) {
    const pmap = PresenceMap.read(reader);
    const item = {};
    for (const child of field.children) {
      item[child.name] = decodeField(child, { ...ctx, pmap });
    }
    items.push(item);
  }
  return items;
}

function decodeField(field, ctx) {
  if (field.spec) return decodeIntegerField(field, ctx);
  switch (field.type) {
    case 'string': return decodeStringField(field, ctx);
    case 'decimal': return decodeDecimalField(field, ctx);
    case 'sequence': return decodeSequenceField(field, ctx);
    default: throw new FastDecodeError(`字段 ${field.name} 的类型 ${field.type} 未支持`);
  }
}

export class FastDecoder {
  constructor(compiled) {
    this.compiled = compiled;
    this.dictionaries = new Dictionaries();
  }
  reset() { this.dictionaries.reset(); }
  decodeMessage(bytes) {
    const reader = new Reader(bytes);
    const pmap = PresenceMap.read(reader);
    let templateId;
    if (pmap.next()) {
      templateId = Number(readIntegerValue(reader, { signed: false, bits: 32 }, false, 'templateId'));
      this.dictionaries.global.set('templateId', templateId);
    } else if (this.dictionaries.global.has('templateId')) {
      templateId = this.dictionaries.global.get('templateId');
    } else {
      throw new FastDecodeError('模板 id 未出现且无可沿用值');
    }
    const template = this.compiled.byId.get(templateId);
    if (!template) throw new FastDecodeError(`未知模板 id ${templateId}`);
    if (template.status !== 'ok') throw new UnsupportedTemplateError(template);
    const ctx = { reader, pmap, dictionaries: this.dictionaries, template };
    const fields = {};
    for (const field of template.fields) fields[field.name] = decodeField(field, ctx);
    if (reader.remaining !== 0) throw new FastDecodeError(`帧内剩余 ${reader.remaining} 字节未消费`);
    return { templateId, templateName: template.name, fields };
  }
}

function toOutput(value) {
  if (typeof value === 'bigint') {
    return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map(toOutput);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = toOutput(item);
    return out;
  }
  return value;
}

// 按来源清单逐帧解码。frames 的顺序以来源清单为准；sequence 连续性、resets
// 共同决定字典上下文是否可信。失去解释依据的帧保留原文定位并报告 blocked。
export function decodeFeed({ bytes, manifest, compiled, session, blobDigest }) {
  const decoder = new FastDecoder(compiled);
  const records = [];
  const issues = [];
  const gaps = [];
  const appliedResets = [];
  const resets = new Set(Array.isArray(manifest.resets) ? manifest.resets.filter(Number.isInteger) : []);
  const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
  let blocked = false;
  let expected = null;
  const usedIds = new Set();
  for (const frame of frames) {
    const { sequence, offset, length } = frame ?? {};
    const raw = { blob: blobDigest, offset, length };
    if (!Number.isInteger(sequence) || !Number.isInteger(offset) || !Number.isInteger(length)) {
      issues.push({ kind: 'decode-error', session, sequence, raw, message: '清单帧描述无效' });
      blocked = true;
      continue;
    }
    if (expected !== null && sequence !== expected) {
      gaps.push({ expected, got: sequence });
      blocked = true;
      issues.push({
        kind: 'sequence-gap', session, sequence, expected, got: sequence, raw,
        message: `源流序号缺口：期望 ${expected}，实到 ${sequence}，字典上下文失效`,
      });
    }
    if (resets.has(sequence)) {
      decoder.reset();
      blocked = false;
      appliedResets.push(sequence);
    }
    expected = sequence + 1;
    if (blocked) {
      issues.push({
        kind: 'blocked', session, sequence, raw,
        message: '解释依据缺失，等待合法重置，本帧保留原文未解码',
      });
      continue;
    }
    if (offset < 0 || length <= 0 || offset + length > bytes.length) {
      issues.push({ kind: 'decode-error', session, sequence, raw, message: '帧范围超出来源字节' });
      blocked = true;
      continue;
    }
    try {
      const message = decoder.decodeMessage(bytes.subarray(offset, offset + length));
      let id = `${session}#${sequence}`;
      if (usedIds.has(id)) id = `${id}@${offset}`;
      usedIds.add(id);
      records.push({
        id, session, sequence,
        templateId: message.templateId, templateName: message.templateName,
        raw, fields: toOutput(message.fields),
      });
    } catch (error) {
      if (!(error instanceof FastDecodeError)) throw error;
      issues.push({
        kind: error instanceof UnsupportedTemplateError ? 'unsupported-template' : 'decode-error',
        session, sequence, raw,
        templateId: error.templateId, message: error.message,
      });
      blocked = true;
    }
  }
  const decodedSequences = records.map((record) => record.sequence);
  const blockedSequences = issues.filter((issue) => issue.kind !== 'sequence-gap').map((issue) => issue.sequence);
  const complete = gaps.length === 0 && blockedSequences.length === 0 && records.length === frames.length;
  const coverage = {
    structured: true,
    session,
    frames: { total: frames.length, decoded: records.length, blocked: blockedSequences.length },
    decodedSequences,
    blockedSequences,
    gaps,
    resets: appliedResets,
    templates: {
      file: manifest.templateFile ?? null,
      ids: compiled.list.map((template) => template.id),
      names: compiled.list.map((template) => template.name),
      unsupported: compiled.list
        .filter((template) => template.status !== 'ok')
        .map((template) => ({ id: template.id, name: template.name, reason: template.reason })),
    },
    complete,
  };
  const state = frames.length > 0 && records.length === 0 ? 'rejected' : complete ? 'complete' : 'partial';
  return { records, issues, coverage, state };
}
