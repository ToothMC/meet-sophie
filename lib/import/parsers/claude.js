// lib/import/parsers/claude.js — Parse Claude export format (text paste or ZIP/JSON)

/**
 * Parse Claude export — handles text paste, JSON array, or ZIP with JSON files.
 * @param {string | Buffer} input
 * @param {'text' | 'zip' | 'json'} [inputType]
 * @returns {Promise<Array<{ title: string, content: string, messageCount: number }>>}
 */
export async function parseClaudeExport(input, inputType = 'text') {
  if (inputType === 'zip') {
    return parseClaudeZip(input);
  }

  const text = typeof input === 'string' ? input : input.toString('utf-8');

  // Try parsing as JSON first (Claude export is JSON)
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return parseClaudeJson(data);
    if (data.conversations) return parseClaudeJson(data.conversations);
  } catch {
    // Not JSON — treat as text paste
  }

  return parseClaudeText(text);
}

/**
 * Parse Claude ZIP export (.zip or .dms file).
 */
async function parseClaudeZip(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const results = [];

  // Look for any JSON files in the ZIP
  const jsonFiles = Object.keys(zip.files).filter(name =>
    name.endsWith('.json') && !name.startsWith('__MACOSX')
  );

  for (const fileName of jsonFiles) {
    try {
      const content = await zip.file(fileName).async('string');
      const data = JSON.parse(content);

      if (Array.isArray(data)) {
        // Array of conversations
        results.push(...parseClaudeJson(data));
      } else if (data.chat_messages || data.messages) {
        // Single conversation object
        results.push(parseClaudeConversation(data));
      } else if (typeof data === 'object') {
        // Try to extract any conversation-like structure
        const conv = extractConversationFromObject(data);
        if (conv) results.push(conv);
      }
    } catch {
      // Skip unparseable files
    }
  }

  // If no JSON files found or all failed, try reading any text files
  if (results.length === 0) {
    const textFiles = Object.keys(zip.files).filter(name =>
      (name.endsWith('.txt') || name.endsWith('.md')) && !name.startsWith('__MACOSX')
    );
    for (const fileName of textFiles) {
      try {
        const content = await zip.file(fileName).async('string');
        if (content.trim()) {
          results.push({ title: fileName, content: content.trim(), messageCount: 0 });
        }
      } catch {}
    }
  }

  // Last resort: extract ALL text from ALL files
  if (results.length === 0) {
    const allContent = [];
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir || name.startsWith('__MACOSX')) continue;
      try {
        const content = await file.async('string');
        if (content.trim() && content.length > 20) {
          allContent.push(content.trim());
        }
      } catch {}
    }
    if (allContent.length > 0) {
      results.push({ title: 'Claude Export', content: allContent.join('\n\n---\n\n'), messageCount: 0 });
    }
  }

  return results.length > 0 ? results : [{ title: 'Claude Export (leer)', content: '', messageCount: 0 }];
}

/**
 * Parse Claude JSON conversations array.
 * Claude's export format: array of conversation objects with chat_messages.
 */
function parseClaudeJson(conversations) {
  if (!Array.isArray(conversations)) return [];

  return conversations
    .filter(conv => {
      // Filter out empty conversations
      const msgs = conv.chat_messages || conv.messages || [];
      return msgs.length > 0;
    })
    .map(conv => parseClaudeConversation(conv));
}

/**
 * Parse a single Claude conversation object.
 */
function parseClaudeConversation(conv) {
  const title = conv.name || conv.title || conv.uuid?.slice(0, 8) || 'Untitled';
  const messages = conv.chat_messages || conv.messages || [];

  // Extract text from messages — Claude format has sender + text/content
  const textParts = [];
  for (const msg of messages) {
    const role = msg.sender || msg.role || 'unknown';
    let text = '';

    if (typeof msg.text === 'string') {
      text = msg.text;
    } else if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Content blocks (like Anthropic API format)
      text = msg.content
        .filter(b => b.type === 'text' || typeof b === 'string')
        .map(b => typeof b === 'string' ? b : b.text || '')
        .join('');
    } else if (msg.text && Array.isArray(msg.text)) {
      text = msg.text.join('');
    }

    if (text.trim()) {
      textParts.push(`[${role}]: ${text.trim()}`);
    }
  }

  return {
    title,
    content: textParts.join('\n\n'),
    messageCount: messages.length,
  };
}

/**
 * Try to extract conversation data from an arbitrary JSON object.
 */
function extractConversationFromObject(obj) {
  // Walk the object looking for arrays of message-like items
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && (first.text || first.content || first.message || first.sender || first.role)) {
        return {
          title: obj.name || obj.title || key,
          content: value
            .map(m => {
              const role = m.sender || m.role || '?';
              const text = m.text || m.content || m.message || '';
              return `[${role}]: ${typeof text === 'string' ? text : JSON.stringify(text)}`;
            })
            .filter(t => t.length > 5)
            .join('\n\n'),
          messageCount: value.length,
        };
      }
    }
  }
  return null;
}

/**
 * Parse text paste (user copied extraction prompt output from Claude).
 */
function parseClaudeText(text) {
  const sections = {};
  const lines = text.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^(?:\d+\.\s*)?(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.*)/);
    if (sectionMatch && sectionMatch[1].length < 50) {
      currentSection = sectionMatch[1].toLowerCase().trim();
      sections[currentSection] = sectionMatch[2]?.trim() || '';
    } else if (currentSection && line.trim()) {
      sections[currentSection] = (sections[currentSection] ? sections[currentSection] + '\n' : '') + line.trim();
    }
  }

  return [{
    title: 'Claude Import',
    content: text,
    sections,
    messageCount: 0,
  }];
}
