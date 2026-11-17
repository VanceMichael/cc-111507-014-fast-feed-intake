// 解析项目约定范围内的 FAST 1.1 模板 XML：template 及 none/constant/default/copy/increment/delta 操作符。
// 未承诺的扩展不静默忽略：解析为 unsupported 指令，解码时保留原文并形成可定位问题。

import { FastError } from './primitives.mjs';

const FIELD_TAGS = new Set(['int32', 'uInt32', 'int64', 'uInt64', 'string', 'ascii', 'decimal', 'sequence']);
const OPERATOR_TAGS = new Set(['none', 'constant', 'default', 'copy', 'increment', 'delta']);

function tokenize(xml) {
  const tokens = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (xml.slice(i).trim()) throw new FastError('TEMPLATE_XML', '模板 XML 在根元素外含有文本');
      break;
    }
    if (lt > i && xml.slice(i, lt).trim()) throw new FastError('TEMPLATE_XML', '模板 XML 含有元素间文本');
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new FastError('TEMPLATE_XML', '模板 XML 标签未闭合');
    const raw = xml.slice(lt, gt + 1);
    if (raw.startsWith('<!--')) {
      const end = xml.indexOf('-->', lt);
      if (end < 0) throw new FastError('TEMPLATE_XML', '模板 XML 注释未闭合');
      i = end + 3;
      continue;
    }
    if (raw.startsWith('<?') || raw.startsWith('<!')) { i = gt + 1; continue; }
    tokens.push(raw);
    i = gt + 1;
  }
  return tokens;
}

function parseTag(raw) {
  const selfClosing = raw.endsWith('/>');
  const body = raw.slice(1, selfClosing ? -2 : -1).trim();
  const parts = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const tag = parts[0];
  const attrs = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new FastError('TEMPLATE_XML', `模板标签 ${tag} 属性格式无效`);
    const name = part.slice(0, eq);
    let value = part.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attrs[name] = value;
  }
  return { tag, attrs, selfClosing };
}

// 将模板文本解析为节点树。
function parseTree(xml) {
  const tokens = tokenize(xml);
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const raw of tokens) {
    const isClose = raw.startsWith('</');
    if (isClose) {
      const tag = raw.slice(2, -1).trim();
      if (stack.length <= 1 || stack.at(-1).tag !== tag) throw new FastError('TEMPLATE_XML', `模板 XML 闭合标签不匹配：${tag}`);
      stack.pop();
      continue;
    }
    const node = parseTag(raw);
    node.children = [];
    stack.at(-1).children.push(node);
    if (!node.selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new FastError('TEMPLATE_XML', '模板 XML 存在未闭合标签');
  return root;
}

function parseKey(operatorNode) {
  const keyNode = operatorNode.children.find(child => child.tag === 'key');
  if (!keyNode) return null;
  const name = keyNode.attrs.name;
  if (!name) throw new FastError('TEMPLATE_XML', '字典 key 缺少 name 属性');
  return { name, dictionary: keyNode.attrs.dictionary || null };
}

function parseOperator(fieldNode) {
  const opNode = fieldNode.children.find(child => OPERATOR_TAGS.has(child.tag));
  if (!opNode) return { type: 'none' };
  const operator = {
    type: opNode.tag,
    value: opNode.attrs.value,
    key: parseKey(opNode),
  };
  const unknown = opNode.children.filter(child => child.tag !== 'key');
  if (unknown.length) operator.unsupported = unknown.map(child => child.tag);
  return operator;
}

// 把模板标量类型映射到原语读取方式。
function describeType(tag) {
  if (['int32', 'uInt32', 'int64', 'uInt64'].includes(tag)) return { kind: 'integer', integer: tag };
  if (tag === 'decimal') return { kind: 'decimal' };
  if (tag === 'string' || tag === 'ascii') return { kind: 'ascii' };
  return { kind: 'unsupported', source: tag };
}

function buildInstruction(node, parentTemplate) {
  const optional = node.attrs.presence === 'optional';
  const base = {
    name: node.attrs.name,
    optional,
    dictionary: node.attrs.dictionary || parentTemplate.dictionary || null,
    operator: parseOperator(node),
  };
  if (!base.name) throw new FastError('TEMPLATE_XML', `${node.tag} 字段缺少 name 属性`);
  if (node.tag === 'sequence') {
    const lengthName = node.attrs.name;
    const children = node.children
      .filter(child => FIELD_TAGS.has(child.tag))
      .map(child => buildInstruction(child, parentTemplate));
    return { ...base, type: { kind: 'sequence', lengthName }, instructions: children };
  }
  return { ...base, type: describeType(node.tag) };
}

export function parseTemplates(xml) {
  const tree = parseTree(xml);
  const templatesNode = tree.children.find(child => child.tag === 'templates');
  if (!templatesNode) throw new FastError('TEMPLATE_XML', '模板 XML 缺少 templates 根元素');
  const templates = new Map();
  const unsupported = [];
  for (const node of templatesNode.children) {
    if (node.tag !== 'template') {
      unsupported.push({ tag: node.tag, reason: 'templates 下出现非 template 元素' });
      continue;
    }
    const idAttr = node.attrs.id;
    if (!/^\d+$/.test(idAttr || '')) throw new FastError('TEMPLATE_XML', `模板 ${node.attrs.name || ''} 缺少数值 id`);
    const id = Number(idAttr);
    if (templates.has(id)) throw new FastError('TEMPLATE_XML', `模板 id ${id} 重复定义`);
    const template = {
      id,
      name: node.attrs.name || `template-${id}`,
      dictionary: node.attrs.dictionary || 'global',
      instructions: [],
    };
    for (const child of node.children) {
      if (!FIELD_TAGS.has(child.tag)) {
        unsupported.push({ template: id, tag: child.tag, reason: '不在承诺范围内的字段类型' });
        template.instructions.push({ name: child.attrs.name || child.tag, optional: false, dictionary: template.dictionary,
          operator: { type: 'none' }, type: { kind: 'unsupported', source: child.tag } });
        continue;
      }
      template.instructions.push(buildInstruction(child, template));
    }
    templates.set(id, template);
  }
  if (!templates.size) throw new FastError('TEMPLATE_XML', '模板 XML 未定义任何 template');
  return { templates, unsupported };
}
