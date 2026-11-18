// Readable text for attachments a CLI cannot open by itself. Claude Code, Grok Build and Antigravity read
// plain text, images and PDFs; Word, Excel, PowerPoint, OpenDocument files and archives are ZIP files of XML
// or binary data, so a text copy is written next to them. Everything else is passed as it is.
const path = require('node:path');
const { readZip } = require('./zipfile');

const MAX_TEXT = 2 * 1024 * 1024;

const decode = (xml) => xml
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, '&');

const byNumber = (a, b) => (Number(/(\d+)\.xml$/.exec(a.name)?.[1]) || 0) - (Number(/(\d+)\.xml$/.exec(b.name)?.[1]) || 0);

function word(zip) {
  const parts = zip.entries.filter((entry) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(entry.name));
  return parts.map((entry) => decode(zip.read(entry).toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n'))).join('\n');
}

function excel(zip) {
  const shared = zip.entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  const strings = shared ? [...zip.read(shared).toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(m[1])) : [];
  const names = (() => {
    const book = zip.entries.find((entry) => entry.name === 'xl/workbook.xml');
    return book ? [...zip.read(book).toString('utf8').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1])) : [];
  })();
  const sheets = zip.entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)).sort(byNumber);
  return sheets.map((entry, index) => {
    const rows = [...zip.read(entry).toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attributes, inner = '']) => {
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
        return /t="s"/.test(attributes) ? strings[Number(value)] ?? '' : decode(value);
      }).join('\t'));
    return `## ${names[index] || 'Sheet ' + (index + 1)}\n${rows.join('\n')}`;
  }).join('\n\n');
}

function slides(zip) {
  return zip.entries.filter((entry) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(entry.name)).sort(byNumber)
    .map((entry) => `## ${entry.name.includes('notes') ? '备注' : '幻灯片'} ${/(\d+)\.xml$/.exec(entry.name)[1]}\n` +
      [...zip.read(entry).toString('utf8').matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => decode(m[1])).filter(Boolean).join('\n'))
    .join('\n\n');
}

function openDocument(zip) {
  const content = zip.entries.find((entry) => entry.name === 'content.xml');
  return content ? decode(zip.read(content).toString('utf8').replace(/<\/text:(p|h)>/g, '\n').replace(/<text:tab\/>/g, '\t')
    .replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')) : '';
}

function listing(zip) {
  return 'Archive contents:\n' + zip.entries.map((entry) => `${entry.name}\t${entry.size} bytes`).join('\n');
}

const EXTRACTORS = {
  '.docx': word, '.docm': word, '.dotx': word,
  '.xlsx': excel, '.xlsm': excel,
  '.pptx': slides, '.pptm': slides,
  '.odt': openDocument, '.ods': openDocument, '.odp': openDocument,
  '.zip': listing, '.jar': listing, '.apk': listing, '.epub': listing,
};

// Returns the text for a file, or undefined when the file is not one of the formats above or cannot be read.
function extractText(name, bytes) {
  const extractor = EXTRACTORS[path.extname(name).toLowerCase()];
  if (!extractor) return undefined;
  try {
    const text = extractor(readZip(bytes)).replace(/\n{3,}/g, '\n\n').trim();
    return text ? text.slice(0, MAX_TEXT) : undefined;
  } catch {
    return undefined;
  }
}

// Writes "<file>.txt" beside an attachment when it has extractable text; returns that path or undefined.
function writeTextCopy(fs, filename, name, bytes) {
  const text = extractText(name, bytes);
  if (text === undefined) return undefined;
  const copy = filename + '.txt';
  fs.writeFileSync(copy, text, { mode: 0o400 });
  return copy;
}

module.exports = { extractText, writeTextCopy, EXTENSIONS: Object.keys(EXTRACTORS) };
