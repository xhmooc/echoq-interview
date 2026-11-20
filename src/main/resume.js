/* 简历解析：把 txt / md / docx / pdf 读成纯文本，填入「个人资料」。
 *
 * 不依赖第三方库：docx 用内置 zlib 解 zip，pdf 只提取能读出来的文本层。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv']);
const MAX_SIZE = 20 * 1024 * 1024;
const MAX_CHARS = 20000;

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeText(text) {
  return text
    .replace(/\uFEFF/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- docx ---------- */

function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('文件不是有效的 Word 文档');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, { compression, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipFile(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Word 文档结构损坏');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const data = buffer.slice(start, start + entry.compressedSize);
  if (entry.compression === 0) return data;
  if (entry.compression === 8) return zlib.inflateRawSync(data);
  throw new Error('不支持的 Word 压缩格式');
}

function xmlToText(xml) {
  const raw = xml
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return normalizeText(decodeEntities(raw).replace(/\u00a0/g, ' '));
}

function parseDocx(buffer) {
  const entries = readZipEntries(buffer);
  const entry = entries.get('word/document.xml');
  if (!entry) throw new Error('这份 Word 文档里没有正文');
  return xmlToText(readZipFile(buffer, entry).toString('utf8'));
}

/* ---------- pdf ---------- */

function decodePdfHex(raw) {
  const hex = raw.replace(/\s+/g, '');
  if (hex.length < 2) return '';
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  // 只处理单字节可见字符，CID 编码的中文无法可靠还原，交给可读性校验兜底
  if (bytes.some((byte) => byte < 32 || byte > 126)) return '';
  return String.fromCharCode(...bytes);
}

function decodePdfString(raw) {
  return raw
    .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (match, code) => {
      switch (code) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case '(': return '(';
        case ')': return ')';
        case '\\': return '\\';
        default: return String.fromCharCode(parseInt(code, 8));
      }
    })
    .replace(/[\r\n]+/g, ' ');
}

function pdfContentToText(content) {
  let out = '';
  let pending = '';
  const token = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g;
  let match;

  while ((match = token.exec(content)) !== null) {
    const value = match[0];
    if (value.startsWith('(')) {
      pending += decodePdfString(value.slice(1, -1));
    } else if (value.startsWith('<')) {
      pending += decodePdfHex(value.slice(1, -1));
    } else if (value === 'TJ' || value === 'Tj') {
      out += pending;
      pending = '';
    } else {
      out += `${pending}\n`;
      pending = '';
    }
  }

  return out;
}

function extractPdfText(buffer) {
  const parts = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let cursor = 0;

  while (cursor < buffer.length) {
    const index = buffer.indexOf(marker, cursor);
    if (index === -1) break;

    let start = index + marker.length;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) break;

    const data = buffer.slice(start, end);
    let decoded = null;
    try {
      decoded = zlib.inflateSync(data);
    } catch (err) {
      try {
        decoded = zlib.inflateRawSync(data);
      } catch (err2) {
        decoded = null;
      }
    }

    if (decoded) {
      const text = pdfContentToText(decoded.toString('latin1'));
      if (text.trim()) parts.push(text);
    } else if (data.includes('BT')) {
      // 少数 PDF 的正文流没有压缩
      const text = pdfContentToText(data.toString('latin1'));
      if (text.trim()) parts.push(text);
    }

    cursor = end + endMarker.length;
  }

  return parts.join('\n');
}

function looksReadable(text) {
  const chars = text.replace(/\s/g, '');
  if (chars.length < 20) return false;
  const good = (chars.match(/[\u4e00-\u9fa5a-zA-Z0-9.,;:!?()（）【】、，。；：""''\-+/@#%&*=]/g) || []).length;
  return good / chars.length >= 0.55;
}

function parsePdf(buffer) {
  const text = normalizeText(extractPdfText(buffer));
  if (!looksReadable(text)) {
    throw new Error('这份 PDF 的文字层读不出来（可能是扫描件或特殊字体），请改用 Word（.docx），或直接把简历文字粘贴到下面。');
  }
  return text;
}

/* ---------- 入口 ---------- */

async function parseFile(file) {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_SIZE) throw new Error('文件超过 20 MB，请换一份更小的简历');

  const buffer = await fs.promises.readFile(file);
  const ext = path.extname(file).toLowerCase();
  let text;

  if (TEXT_EXT.has(ext)) {
    text = buffer.toString('utf8');
  } else if (ext === '.docx') {
    text = parseDocx(buffer);
  } else if (ext === '.pdf') {
    text = parsePdf(buffer);
  } else if (ext === '.doc') {
    throw new Error('旧版 .doc 暂不支持，请另存为 .docx 或 .pdf 后再上传');
  } else {
    throw new Error(`不支持的文件类型：${ext || '未知'}，请上传 txt / md / docx / pdf`);
  }

  const clean = normalizeText(text);
  if (clean.length < 20) throw new Error('没有从文件里读取出有效文字，请换一份文件或直接粘贴');
  return clean.slice(0, MAX_CHARS);
}

module.exports = { parseFile };
