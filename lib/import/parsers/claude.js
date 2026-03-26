// lib/import/parsers/claude.js — Parse Claude export format

/**
 * Parse Claude export or paste.
 * @param {string} input
 * @returns {Array<{ title: string, content: string, sections: Record<string, string> }>}
 */
export function parseClaudeExport(input) {
  const text = typeof input === 'string' ? input : input.toString('utf-8');

  // Claude memories format: numbered list items
  const sections = {};
  const lines = text.split('\n');
  let currentSection = null;

  for (const line of lines) {
    // Match numbered sections or bold headers
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
  }];
}
