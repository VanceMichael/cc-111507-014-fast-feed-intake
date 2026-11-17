// FAST 1.1 底层编码原语：stop-bit integer、nullable 整数、ASCII 字符串、decimal、presence map。
// 仅实现 docs/来源格式.md 承诺的范围；越界或截断抛出 FastError，由上层保留原文并报告。

export class FastError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FastError';
    this.code = code;
  }
}

export class Cursor {
  constructor(bytes, baseOffset = 0) {
    this.bytes = bytes;
    this.pos = 0;
    this.baseOffset = baseOffset; // 帧在来源 blob 中的绝对偏移，用于问题定位
  }
  get remaining() { return this.bytes.length - this.pos; }
  get absoluteOffset() { return this.baseOffset + this.pos; }
  readByte() {
    if (this.pos >= this.bytes.length) throw new FastError('TRUNCATED', '来源字节在读取过程中截断');
    return this.bytes[this.pos++];
  }
}

// 读取一个 stop-bit 编码的无符号整数，返回 BigInt 及字节宽度。
export function readStopBitUnsigned(cursor) {
  let value = 0n;
  const start = cursor.pos;
  for (;;) {
    const byte = cursor.readByte();
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (byte & 0x80) break;
    if (cursor.pos - start >= 12) throw new FastError('INTEGER_OVERFLOW', 'stop-bit 整数超出支持宽度');
  }
  return { value, width: cursor.pos - start };
}

// 带符号 stop-bit 整数：各组 7 个载荷位拼接后，最高有效位为符号位，按位宽符号扩展。
export function readStopBitSigned(cursor) {
  const start = cursor.pos;
  let value = 0n;
  for (;;) {
    const byte = cursor.readByte();
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (byte & 0x80) break;
    if (cursor.pos - start >= 12) throw new FastError('INTEGER_OVERFLOW', '带符号 stop-bit 整数超出支持宽度');
  }
  const width = cursor.pos - start;
  const signBit = 1n << BigInt(7 * width - 1);
  if (value & signBit) value -= signBit << 1n;
  return { value, width };
}

const INT_BOUNDS = {
  int32: [-2147483648n, 2147483647n],
  uInt32: [0n, 4294967295n],
  int64: [-9223372036854775808n, 9223372036854775807n],
  uInt64: [0n, 18446744073709551615n],
};

function fitInteger(value, type, code = 'INTEGER_OVERFLOW') {
  const bounds = INT_BOUNDS[type];
  if (bounds && (value < bounds[0] || value > bounds[1])) {
    throw new FastError(code, `${type} 字段值 ${value} 超出取值范围`);
  }
  return Number(value);
}

// 强制存在的整数字段。
export function readInteger(cursor, type) {
  const reader = type.startsWith('u') ? readStopBitUnsigned : readStopBitSigned;
  const { value } = reader(cursor);
  return fitInteger(value, type);
}

// nullable 整数：单字节 0x80 表示 null；否则按 FAST 符号量编码组装后右移一位还原数值。
export function readNullableInteger(cursor, type) {
  const start = cursor.pos;
  const first = cursor.readByte();
  if (first === 0x80) return { value: null, width: 1 };
  let value = BigInt(first & 0x7f);
  let last = first;
  for (;;) {
    if (last & 0x80) break;
    last = cursor.readByte();
    value = (value << 7n) | BigInt(last & 0x7f);
    if (cursor.pos - start >= 12) throw new FastError('INTEGER_OVERFLOW', 'nullable 整数超出支持宽度');
  }
  // FAST nullable：末字节最低位是符号量标记，整体右移一位；为 1 表示负数。
  const negative = (last & 0x01) === 1;
  value >>= 1n;
  if (negative) value = -value;
  return { value: fitInteger(value, type, 'NULLABLE_OVERFLOW'), width: cursor.pos - start };
}

// ASCII 字符串：长度为 stop-bit 无符号整数，随后为原始字节。
export function readAsciiString(cursor, { nullable = false } = {}) {
  if (nullable) {
    const mark = cursor.readByte();
    if (mark === 0x80) return { value: null, width: 1 };
    // 首字节已是长度的第一个字节：回退一位再走通用长度逻辑。
    cursor.pos -= 1;
  }
  const start = cursor.pos;
  const { value: length } = readStopBitUnsigned(cursor);
  if (length > BigInt(cursor.remaining)) throw new FastError('TRUNCATED', '字符串长度超过帧内剩余字节');
  const end = cursor.pos + Number(length);
  const value = cursor.bytes.subarray(cursor.pos, end).toString('ascii');
  cursor.pos = end;
  return { value, width: cursor.pos - start };
}

// decimal：先指数（带符号 stop-bit），再尾数（可空整数）。
export function readDecimal(cursor, { nullable = false } = {}) {
  const start = cursor.pos;
  const { value: exponent } = readStopBitSigned(cursor);
  let mantissa;
  if (nullable) {
    const result = readNullableInteger(cursor, 'int64');
    if (result.value === null) return { value: null, width: cursor.pos - start };
    mantissa = BigInt(result.value);
  } else {
    mantissa = BigInt(readInteger(cursor, 'int64'));
  }
  const exp = Number(exponent);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 14) throw new FastError('DECIMAL_RANGE', 'decimal 指数超出支持范围');
  // 保留精确十进制语义：输出数值与分量，避免浮点猜测。
  const numeric = Number(mantissa) * 10 ** exp;
  return { value: { numeric, exponent: exp, mantissa: Number(mantissa) }, width: cursor.pos - start };
}

// presence map：每字节最高位为终止位（不作为数据位消费），其余 7 位从高到低消费。
export class PresenceMap {
  constructor(cursor) {
    this.bits = [];
    for (;;) {
      const byte = cursor.readByte();
      for (let shift = 6; shift >= 0; shift -= 1) this.bits.push((byte >> shift) & 1);
      if (byte & 0x80) break;
      if (this.bits.length > 1024) throw new FastError('PMAP_OVERFLOW', 'presence map 超出支持长度');
    }
    this.index = 0;
  }
  next() {
    if (this.index >= this.bits.length) throw new FastError('PMAP_EXHAUSTED', 'presence map 位不足，字段与模板不匹配');
    return this.bits[this.index++];
  }
  get consumed() { return this.index; }
}
