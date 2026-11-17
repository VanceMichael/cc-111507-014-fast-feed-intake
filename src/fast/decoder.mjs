// FAST 1.1 字典与消息解码。
// 字典作用域支持 global/template/type 及显式 key；reset 清空全部字典。
// 解码严格按 presence map 位、字段操作符与 nullable 规则执行，不把每条消息当作独立编码。

import { createHash } from 'node:crypto';
import {
  FastError, Cursor, PresenceMap,
  readInteger, readNullableInteger, readAsciiString, readDecimal, readStopBitUnsigned,
} from './primitives.mjs';

// 三段式字典：dictionary 名称 -> 存储键 -> 条目。
export class FastDictionary {
  constructor() { this.scopes = new Map(); }
  keyFor(instruction, templateId) {
    const dictionary = instruction.dictionary || 'global';
    const explicit = instruction.operator.key?.name;
    let prefix;
    if (dictionary === 'template') prefix = `t${templateId}:`;
    else if (dictionary === 'type') prefix = `type:${instruction.type.kind}:`;
    else prefix = '';
    return { dictionary, storageKey: `${prefix}${explicit ? `k:${explicit}:` : ''}${instruction.name}` };
  }
  load(instruction, templateId) {
    const { dictionary, storageKey } = this.keyFor(instruction, templateId);
    const entry = this.scopes.get(dictionary)?.get(storageKey);
    return entry === undefined ? { defined: false } : { defined: true, value: entry };
  }
  store(instruction, templateId, value) {
    const { dictionary, storageKey } = this.keyFor(instruction, templateId);
    if (!this.scopes.has(dictionary)) this.scopes.set(dictionary, new Map());
    this.scopes.get(dictionary).set(storageKey, value);
  }
  reset() { for (const scope of this.scopes.values()) scope.clear(); }
}

function pmapBitNeeded(instruction) {
  const op = instruction.operator.type;
  if (op === 'none') return instruction.optional;
  if (op === 'constant') return instruction.optional;
  // default/copy/increment/delta：强制字段不占位，可选字段占一位。
  return instruction.optional;
}

function readScalar(cursor, instruction) {
  const { type, optional } = instruction;
  if (type.kind === 'integer') {
    return optional ? readNullableInteger(cursor, type.integer).value : readInteger(cursor, type.integer);
  }
  if (type.kind === 'decimal') return readDecimal(cursor, { nullable: optional }).value;
  if (type.kind === 'ascii') return readAsciiString(cursor, { nullable: optional }).value;
  throw new FastError('UNSUPPORTED_TYPE', `字段 ${instruction.name} 使用了未承诺支持的类型 ${type.source}`);
}

function deltaApply(previous, delta, instruction) {
  if (instruction.type.kind === 'decimal') {
    if (!previous) return { numeric: Number(delta.mantissa) * 10 ** delta.exponent, exponent: delta.exponent, mantissa: delta.mantissa };
    const mantissa = previous.mantissa + delta.mantissa;
    return { numeric: mantissa * 10 ** delta.exponent, exponent: delta.exponent, mantissa };
  }
  return (previous ?? 0) + delta;
}

// 按操作符解码单个标量字段，必要时读写字典。
function decodeScalar(instruction, pmap, cursor, dictionaries, templateId, issues, frameRef) {
  const op = instruction.operator.type;
  const optional = instruction.optional;
  const usesBit = pmapBitNeeded(instruction);
  const present = usesBit ? pmap.next() === 1 : true;

  switch (op) {
    case 'none':
      if (!present) return null;
      return readScalar(cursor, instruction);
    case 'constant': {
      if (!present) return null;
      if (instruction.operator.value === undefined) {
        throw new FastError('TEMPLATE_CONSTANT', `常量字段 ${instruction.name} 未在模板中声明 value`);
      }
      return coerceConstant(instruction);
    }
    case 'default': {
      if (!present) return instruction.operator.value === undefined ? null : coerceConstant(instruction);
      return readScalar(cursor, instruction);
    }
    case 'copy': {
      if (optional) {
        if (!present) {
          const prior = dictionaries.load(instruction, templateId);
          if (!prior.defined) {
            throw new FastError('DICT_UNDEFINED', `copy 字段 ${instruction.name} 缺少可沿用的字典值（存在位为 0）`);
          }
          return prior.value;
        }
        const value = readScalar(cursor, instruction);
        dictionaries.store(instruction, templateId, value);
        return value;
      }
      // 强制 copy 不占 presence map 位：字段始终在流中；无字典初值时按类型初值 0/空串处理。
      const value = readScalar(cursor, instruction);
      dictionaries.store(instruction, templateId, value);
      return value;
    }
    case 'increment': {
      if (optional && !present) {
        const prior = dictionaries.load(instruction, templateId);
        if (!prior.defined) {
          throw new FastError('DICT_UNDEFINED', `increment 字段 ${instruction.name} 缺少可递增的字典值（存在位为 0）`);
        }
        return prior.value === null ? null : prior.value + 1;
      }
      const value = readScalar(cursor, instruction);
      dictionaries.store(instruction, templateId, value);
      return value;
    }
    case 'delta': {
      if (optional && !present) {
        const prior = dictionaries.load(instruction, templateId);
        if (!prior.defined) {
          throw new FastError('DICT_UNDEFINED', `delta 字段 ${instruction.name} 缺少基准字典值（存在位为 0）`);
        }
        return prior.value;
      }
      const delta = readScalar(cursor, instruction);
      if (delta === null) {
        dictionaries.store(instruction, templateId, null);
        return null;
      }
      const prior = dictionaries.load(instruction, templateId);
      const value = deltaApply(prior.defined ? prior.value : undefined, delta, instruction);
      dictionaries.store(instruction, templateId, value);
      return value;
    }
    default:
      throw new FastError('UNSUPPORTED_OPERATOR', `字段 ${instruction.name} 使用了未承诺的操作符 ${op}`);
  }
}

function coerceConstant(instruction) {
  const raw = instruction.operator.value;
  if (instruction.type.kind === 'integer') {
    if (!/^-?\d+$/.test(raw)) throw new FastError('TEMPLATE_CONSTANT', `常量字段 ${instruction.name} 值不是整数：${raw}`);
    return Number(raw);
  }
  return raw;
}

function decodeInstruction(instruction, pmap, cursor, dictionaries, templateId, issues, frameRef) {
  if (instruction.type.kind === 'unsupported') {
    throw new FastError('UNSUPPORTED_TYPE', `字段 ${instruction.name} 类型 ${instruction.type.source} 不在承诺范围内`);
  }
  if (instruction.operator.unsupported) {
    throw new FastError('UNSUPPORTED_OPERATOR', `字段 ${instruction.name} 操作符含未承诺扩展：${instruction.operator.unsupported.join(',')}`);
  }
  if (instruction.type.kind === 'sequence') {
    // 长度字段按标量规则解码（通常为 none/强制，不占 presence map 位）。
    const length = decodeScalar(
      { name: instruction.type.lengthName, optional: false, dictionary: instruction.dictionary,
        operator: { type: 'none' }, type: { kind: 'integer', integer: 'uInt32' } },
      pmap, cursor, dictionaries, templateId, issues, frameRef,
    );
    const groups = [];
    for (let index = 0; index < length; index += 1) {
      const group = {};
      for (const child of instruction.instructions) {
        group[child.name] = decodeInstruction(child, pmap, cursor, dictionaries, templateId, issues, frameRef);
      }
      groups.push(group);
    }
    return groups;
  }
  return decodeScalar(instruction, pmap, cursor, dictionaries, templateId, issues, frameRef);
}

// 来源样例约定：个别实现会在可选字段存在位为 0 时仍写一个单字节 nullable 空值标记 0x80。
// 严格 FAST 下该字节属于多余字节；此处仅接受这一种可识别形态，记录 warning，不猜任何数值。
function reconcileTrailing(cursor, instruction, issues, frameRef) {
  if (cursor.remaining === 0) return;
  const singleNull = cursor.remaining === 1 && cursor.bytes[cursor.pos] === 0x80;
  const lastOptional = instruction && instruction.optional;
  if (singleNull && lastOptional) {
    cursor.readByte();
    issues.push({ severity: 'warning', code: 'OPTIONAL_NULL_MARKER', sequence: frameRef.sequence, offset: frameRef.offset,
      message: `字段 ${instruction.name} 存在位为 0，来源仍写入单字节空值标记 0x80；按显式 null 标记接受，未沿用任何陈旧值` });
    return;
  }
  throw new FastError('TRAILING_BYTES', `帧解码后仍有 ${cursor.remaining} 个无法解释的字节`);
}

export function decodeFrame(frameBytes, { offset, sequence }, templates, dictionaries, priorTemplate, issues) {
  const cursor = new Cursor(frameBytes, offset);
  const pmap = new PresenceMap(cursor);
  // presence map 第一个位对应模板 id：为 1 时流中携带 id；为 0 时沿用上一条消息的模板。
  const templatePresent = pmap.next() === 1;
  let template;
  if (templatePresent) {
    const templateId = Number(readStopBitUnsigned(cursor).value);
    if (!templates.has(templateId)) {
      throw new FastError('UNKNOWN_TEMPLATE', `模板 id ${templateId} 不在接收端理解的模板范围内`);
    }
    template = templates.get(templateId);
  } else {
    if (!priorTemplate) {
      throw new FastError('TEMPLATE_CONTEXT', '模板存在位为 0，但没有可沿用的上一条消息模板');
    }
    template = priorTemplate;
  }
  const templateId = template.id;
  const fields = {};
  let lastInstruction = null;
  for (const instruction of template.instructions) {
    fields[instruction.name] = decodeInstruction(instruction, pmap, cursor, dictionaries, templateId, issues, { sequence, offset });
    lastInstruction = instruction;
  }
  reconcileTrailing(cursor, lastInstruction, issues, { sequence, offset });
  return { templateId, templateName: template.name, fields, priorTemplate: template };
}

export function stableRecordId(session, sequence, offset, digest) {
  return createHash('sha256').update(`${session}|${sequence}|${offset}|${digest}`).digest('hex').slice(0, 32);
}
