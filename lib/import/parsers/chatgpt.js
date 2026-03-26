// lib/import/parsers/chatgpt.js — Parse ChatGPT exports (conversations.json or ZIP)

/**
 * Parse a ChatGPT export.
 * @param {Buffer | string} input - File buffer (ZIP or JSON) or plain text paste
 * @param {'zip' | 'json' | 'text'} inputType
 * @returns {Promise<Array<{ title: string, messageCount: number, created: number | null, lastMessage: string, themes: string[] }>>}
 */
export async function parseChatGPTExport(input, inputType = 'text') {
  if (inputType === 'text' || typeof input === 'string') {
    return parseTextPaste(typeof input === 'string' ? input : input.toString('utf-8'));
  }

  if (inputType === 'zip') {
    // Dynamic import for jszip (optional dependency)
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(input);
    const convFile = zip.file('conversations.json');
    if (!convFile) throw new Error('conversations.json nicht gefunden im ZIP');
    const content = await convFile.async('string');
    return parseConversationsJson(JSON.parse(content));
  }

  // JSON
  const data = JSON.parse(typeof input === 'string' ? input : input.toString('utf-8'));
  return parseConversationsJson(data);
}

function parseConversationsJson(data) {
  if (!Array.isArray(data)) return [];

  return data.map(conv => ({
    title: conv.title || 'Untitled',
    messageCount: Object.keys(conv.mapping || {}).length,
    created: conv.create_time || null,
    lastMessage: extractLastMessage(conv),
    themes: [],
  }));
}

function extractLastMessage(conv) {
  if (!conv.mapping) return '';
  const nodes = Object.values(conv.mapping);
  const lastNode = nodes.filter(n => n.message?.content?.parts?.length > 0).pop();
  return lastNode?.message?.content?.parts?.join('') || '';
}

/**
 * Parse a text paste (e.g. user copied extraction prompt output from ChatGPT).
 */
function parseTextPaste(text) {
  // Extract sections from structured paste
  const sections = {};
  const lines = text.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^(ARBEIT|KOMMUNIKATION|THEMEN|PRÄFERENZEN|PERSÖNLICH|PROJEKTE|MUSTER)\s*:/i);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      sections[currentSection] = line.replace(sectionMatch[0], '').trim();
    } else if (currentSection && line.trim()) {
      sections[currentSection] = (sections[currentSection] ? sections[currentSection] + '\n' : '') + line.trim();
    }
  }

  return [{
    title: 'ChatGPT Paste Import',
    messageCount: 0,
    created: Date.now() / 1000,
    lastMessage: text,
    themes: Object.keys(sections),
    sections,
  }];
}
