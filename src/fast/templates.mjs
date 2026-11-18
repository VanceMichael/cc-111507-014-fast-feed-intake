// 将项目约定范围内的 FAST 1.1 模板 XML 编译为字段指令。
// 支持：stop-bit 整数、ASCII string、decimal、sequence；
// 操作符 none/constant/default/copy/increment/delta；字典作用域 global/template/type。
// 未列出的扩展（byteVector、group、tail、unicode 等）标记为 unsupported，
// 由解码侧保留原文并报告，不能假装完整解析。
import { parseXml, localName } from './xml.mjs';

export const INTEGER_TYPES = {
  uInt32: { signed: false, bits: 32 },
  uInt64: { signed: false, bits: 64 },
  int32: { signed: true, bits: 32 },
  int64: { signed: true, bits: 64 },
};
const OPERATORS = new Set(['constant', 'default', 'copy', 'delta', 'increment']);
const DICTIONARIES = new Set(['global', 'template', 'type']);

export class TemplateError extends Error {}

function parseIntegerInitial(text) {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new TemplateError(`初始值不是整数：${text}`);
  return BigInt(trimmed);
}

export function parseDecimalInitial(text) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) throw new TemplateError(`初始值不是十进制数：${text}`);
  const [, sign, intPart, fracPart = '', expPart] = match;
  let mantissa = BigInt(intPart + fracPart);
  const exponent = BigInt(-fracPart.length) + (expPart ? BigInt(expPart) : 0n);
  if (sign === '-') mantissa = -mantissa;
  return { mantissa, exponent };
}

function compileOperator(element, context) {
  if (!element) return { kind: 'none' };
  const kind = localName(element.name);
  if (kind === 'none') return { kind: 'none' };
  if (!OPERATORS.has(kind)) {
    context.unsupported.push(`字段 ${context.fieldName} 的操作符 ${kind}`);
    return { kind: 'none' };
  }
  const dictionary = element.attributes.dictionary ?? context.inheritedDictionary;
  if (!DICTIONARIES.has(dictionary)) context.unsupported.push(`字段 ${context.fieldName} 的字典作用域 ${dictionary}`);
  const ns = element.attributes.ns;
  const key = element.attributes.key ?? (ns ? `${ns}:${context.fieldName}` : context.fieldName);
  let initial;
  if (element.attributes.value !== undefined) {
    try {
      initial = context.parseInitial(element.attributes.value);
    } catch (error) {
      context.unsupported.push(`字段 ${context.fieldName} 的初始值无效：${error.message}`);
    }
  }
  if (kind === 'constant' && initial === undefined) {
    context.unsupported.push(`字段 ${context.fieldName} 的 constant 缺少初始值`);
  }
  if (kind === 'increment' && !context.integer) {
    context.unsupported.push(`字段 ${context.fieldName} 的类型不支持 increment`);
  }
  return { kind, initial, key, dictionary: DICTIONARIES.has(dictionary) ? dictionary : 'global' };
}

function compileScalarOperator(element, context) {
  if (element.children.length > 1) {
    context.unsupported.push(`字段 ${context.fieldName} 包含无法识别的子元素`);
    return { kind: 'none' };
  }
  return compileOperator(element.children[0] ?? null, context);
}

function compileField(element, inheritedDictionary, unsupported) {
  const kind = localName(element.name);
  const name = element.attributes.name;
  if (!name) {
    unsupported.push(`存在未命名字段 ${kind}`);
    return null;
  }
  const presence = element.attributes.presence ?? 'mandatory';
  if (!['mandatory', 'optional'].includes(presence)) {
    unsupported.push(`字段 ${name} 的 presence=${presence}`);
    return null;
  }
  const optional = presence === 'optional';
  if (INTEGER_TYPES[kind]) {
    const spec = INTEGER_TYPES[kind];
    const operator = compileScalarOperator(element, {
      fieldName: name, inheritedDictionary, unsupported, integer: true,
      parseInitial: parseIntegerInitial,
    });
    return { name, type: kind, spec, optional, operator };
  }
  if (kind === 'string') {
    const charset = element.attributes.charset ?? 'ascii';
    if (charset !== 'ascii') {
      unsupported.push(`字段 ${name} 的字符集 ${charset}`);
      return null;
    }
    const operator = compileScalarOperator(element, {
      fieldName: name, inheritedDictionary, unsupported, integer: false,
      parseInitial: (text) => text,
    });
    return { name, type: 'string', optional, operator };
  }
  if (kind === 'decimal') {
    const exponentEl = element.children.find((child) => localName(child.name) === 'exponent');
    const mantissaEl = element.children.find((child) => localName(child.name) === 'mantissa');
    if (exponentEl || mantissaEl) {
      const extras = element.children.filter((child) => child !== exponentEl && child !== mantissaEl);
      if (extras.length > 0) unsupported.push(`字段 ${name} 的 decimal 结构无法识别`);
      const exponent = compileOperator(exponentEl?.children[0] ?? null, {
        fieldName: `${name}.exponent`, inheritedDictionary, unsupported, integer: true,
        parseInitial: parseIntegerInitial,
      });
      const mantissa = compileOperator(mantissaEl?.children[0] ?? null, {
        fieldName: `${name}.mantissa`, inheritedDictionary, unsupported, integer: true,
        parseInitial: parseIntegerInitial,
      });
      return { name, type: 'decimal', optional, mode: 'individual', exponent, mantissa };
    }
    const operator = compileScalarOperator(element, {
      fieldName: name, inheritedDictionary, unsupported, integer: false,
      parseInitial: parseDecimalInitial,
    });
    return { name, type: 'decimal', optional, mode: 'whole', operator };
  }
  if (kind === 'sequence') {
    const lengthEl = element.children.find((child) => localName(child.name) === 'length');
    const length = {
      name: lengthEl?.attributes.name ?? `${name}Length`,
      operator: compileOperator(lengthEl?.children[0] ?? null, {
        fieldName: lengthEl?.attributes.name ?? `${name}Length`,
        inheritedDictionary, unsupported, integer: true,
        parseInitial: parseIntegerInitial,
      }),
    };
    const children = [];
    for (const child of element.children) {
      if (localName(child.name) === 'length') continue;
      const field = compileField(child, inheritedDictionary, unsupported);
      if (field) children.push(field);
    }
    return { name, type: 'sequence', optional, length, children };
  }
  unsupported.push(`字段类型 ${kind}`);
  return null;
}

function compileTemplate(element, rootDictionary) {
  const unsupported = [];
  const name = element.attributes.name;
  const idText = element.attributes.id;
  const id = /^\d+$/.test(idText ?? '') ? Number(idText) : Number.NaN;
  if (!name) unsupported.push('模板缺少 name');
  if (!Number.isInteger(id)) unsupported.push(`模板 ${name ?? idText ?? '?'} 缺少有效 id`);
  const dictionary = element.attributes.dictionary ?? rootDictionary;
  if (!DICTIONARIES.has(dictionary)) unsupported.push(`模板 ${name ?? idText} 的字典作用域 ${dictionary}`);
  let typeRef = null;
  const fields = [];
  for (const child of element.children) {
    if (localName(child.name) === 'typeRef') {
      typeRef = child.attributes.name ?? null;
      continue;
    }
    const field = compileField(child, DICTIONARIES.has(dictionary) ? dictionary : 'global', unsupported);
    if (field) fields.push(field);
  }
  return {
    id, name: name ?? `template-${idText}`, dictionary, typeRef, fields,
    status: unsupported.length ? 'unsupported' : 'ok',
    reason: unsupported.join('；') || null,
  };
}

export function compileTemplates(xmlText) {
  let root;
  try {
    root = parseXml(xmlText);
  } catch (error) {
    throw new TemplateError(error.message);
  }
  if (localName(root.name) !== 'templates') throw new TemplateError('模板根元素不是 templates');
  const rootDictionary = root.attributes.dictionary ?? 'global';
  const list = [];
  for (const child of root.children) {
    if (localName(child.name) !== 'template') continue;
    list.push(compileTemplate(child, rootDictionary));
  }
  if (list.length === 0) throw new TemplateError('模板文件不包含任何 template');
  const byId = new Map();
  const byName = new Map();
  for (const template of list) {
    if (byId.has(template.id)) throw new TemplateError(`模板 id 重复：${template.id}`);
    byId.set(template.id, template);
    byName.set(template.name, template);
  }
  return { list, byId, byName };
}
