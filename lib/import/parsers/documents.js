// lib/import/parsers/documents.js — Parse PDF/DOCX/TXT free-text documents

/**
 * Parse a plain text document.
 * @param {string} text
 * @returns {{ title: string, content: string }}
 */
export function parseTextDocument(text) {
  // First line as title, rest as content
  const lines = text.trim().split('\n');
  const title = lines[0]?.slice(0, 100) || 'Document Import';
  return { title, content: text };
}

/**
 * Parse a DOCX file (using mammoth, which is already a dependency).
 * @param {Buffer} buffer
 * @returns {Promise<{ title: string, content: string }>}
 */
export async function parseDocxDocument(buffer) {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || '';
  const lines = text.trim().split('\n');
  const title = lines[0]?.slice(0, 100) || 'DOCX Import';
  return { title, content: text };
}

/**
 * Parse a PDF file — extracts text via basic approach.
 * For production use, a proper PDF parser should be added.
 * @param {Buffer} buffer
 * @returns {{ title: string, content: string }}
 */
export function parsePdfDocument(buffer) {
  // Basic: convert buffer to string, strip binary
  // In production, use pdf-parse or similar
  const raw = buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\täöüÄÖÜß]/g, ' ');
  const clean = raw.replace(/\s{3,}/g, '\n').trim();
  const title = clean.split('\n')[0]?.slice(0, 100) || 'PDF Import';
  return { title, content: clean };
}
