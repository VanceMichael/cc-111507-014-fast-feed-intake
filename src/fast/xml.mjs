// 仅供解析项目约定范围内的模板 XML：元素、属性、注释、CDATA、实体引用。
// 不依赖外部包，不尝试成为通用 XML 解析器。
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

export function parseXml(text) {
  let pos = 0;
  const fail = (reason) => { throw new Error(`模板 XML 无效：${reason}（位置 ${pos}）`); };
  const skipWhitespace = () => { while (pos < text.length && /\s/.test(text[pos])) pos += 1; };
  const parseName = () => {
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(text.slice(pos));
    if (!match) fail('缺少名称');
    pos += match[0].length;
    return match[0];
  };
  const skipMisc = () => {
    for (;;) {
      skipWhitespace();
      if (text.startsWith('<?', pos)) {
        const end = text.indexOf('?>', pos + 2);
        if (end < 0) fail('处理指令未闭合');
        pos = end + 2;
        continue;
      }
      if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos + 4);
        if (end < 0) fail('注释未闭合');
        pos = end + 3;
        continue;
      }
      if (/^<!doctype/i.test(text.slice(pos, pos + 9))) {
        const end = text.indexOf('>', pos);
        if (end < 0) fail('DOCTYPE 未闭合');
        pos = end + 1;
        continue;
      }
      break;
    }
  };
  const parseElement = () => {
    if (text[pos] !== '<') fail('缺少元素起始');
    pos += 1;
    const name = parseName();
    const attributes = {};
    for (;;) {
      skipWhitespace();
      if (text.startsWith('/>', pos)) { pos += 2; return { name, attributes, children: [], text: '' }; }
      if (text[pos] === '>') { pos += 1; break; }
      const attrName = parseName();
      skipWhitespace();
      if (text[pos] !== '=') fail(`属性 ${attrName} 缺少等号`);
      pos += 1;
      skipWhitespace();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") fail(`属性 ${attrName} 缺少引号`);
      const end = text.indexOf(quote, pos + 1);
      if (end < 0) fail(`属性 ${attrName} 未闭合`);
      attributes[attrName] = decodeEntities(text.slice(pos + 1, end));
      pos = end + 1;
    }
    const children = [];
    let textContent = '';
    for (;;) {
      if (pos >= text.length) fail(`元素 ${name} 未闭合`);
      if (text.startsWith('</', pos)) {
        pos += 2;
        const close = parseName();
        skipWhitespace();
        if (text[pos] !== '>') fail('结束标签缺少 >');
        pos += 1;
        if (close !== name) fail(`结束标签 ${close} 与起始标签 ${name} 不匹配`);
        return { name, attributes, children, text: textContent };
      }
      if (text.startsWith('<![CDATA[', pos)) {
        const end = text.indexOf(']]>', pos + 9);
        if (end < 0) fail('CDATA 未闭合');
        textContent += text.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos + 4);
        if (end < 0) fail('注释未闭合');
        pos = end + 3;
        continue;
      }
      if (text[pos] === '<') {
        children.push(parseElement());
        continue;
      }
      const end = text.indexOf('<', pos);
      const stop = end < 0 ? text.length : end;
      textContent += decodeEntities(text.slice(pos, stop));
      pos = stop;
    }
  };
  skipMisc();
  const root = parseElement();
  skipMisc();
  if (pos < text.length) fail('根元素之后存在多余内容');
  return root;
}

export const localName = (name) => (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name);
