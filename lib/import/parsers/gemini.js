// lib/import/parsers/gemini.js — Parse Gemini / Google Takeout export

/**
 * Parse Gemini export or paste.
 * @param {string} input
 * @returns {Array<{ title: string, content: string, sections: Record<string, string> }>}
 */
export function parseGeminiExport(input) {
  const text = typeof input === 'string' ? input : input.toString('utf-8');

  // Gemini paste: usually bullet points with dashes
  const sections = {};
  const lines = text.split('\n');
  let currentSection = null;

  for (const line of lines) {
    // Match bullet-section headers
    const sectionMatch = line.match(/^[-•]\s*(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.*)/);
    if (sectionMatch && sectionMatch[1].length < 50) {
      currentSection = sectionMatch[1].toLowerCase().trim();
      sections[currentSection] = sectionMatch[2]?.trim() || '';
    } else if (currentSection && line.trim()) {
      sections[currentSection] = (sections[currentSection] ? sections[currentSection] + '\n' : '') + line.trim();
    }
  }

  return [{
    title: 'Gemini Import',
    content: text,
    sections,
  }];
}
