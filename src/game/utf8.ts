const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function getUtf8ByteLength(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  if (utf8Encoder) {
    return utf8Encoder.encode(text).length;
  }
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number,
  ellipsis = '',
): string {
  if (typeof text !== 'string' || maxBytes <= 0) return '';
  if (getUtf8ByteLength(text) <= maxBytes) return text;

  const ellipsisBytes = ellipsis ? getUtf8ByteLength(ellipsis) : 0;
  const suffix = ellipsisBytes <= maxBytes ? ellipsis : '';
  const budget = maxBytes - (suffix ? ellipsisBytes : 0);

  let usedBytes = 0;
  let result = '';
  for (const char of text) {
    const charBytes = getUtf8ByteLength(char);
    if (usedBytes + charBytes > budget) break;
    result += char;
    usedBytes += charBytes;
  }
  return `${result}${suffix}`;
}
