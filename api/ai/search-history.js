// api/ai/search-history.js — Search through imported conversation history (Zone A)
// Finds relevant conversations by keyword, returns matching excerpts
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  // Auth
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { query } = body;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Missing search query' });
  }

  // Get user's active source connections
  const { data: sources } = await supabase
    .from('source_connections')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'active');

  if (!sources?.length) {
    return res.status(200).json({ results: [], message: 'Keine importierten Daten gefunden.' });
  }

  const sourceIds = sources.map(s => s.id);

  // Load Zone A raw content
  const { data: rawItems } = await supabase
    .from('source_items')
    .select('raw_content, source_id')
    .in('source_id', sourceIds)
    .eq('zone', 'A');

  if (!rawItems?.length) {
    return res.status(200).json({ results: [], message: 'Keine Rohdaten vorhanden.' });
  }

  // Search through raw content — split into conversations and find matches
  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const allResults = [];

  for (const item of rawItems) {
    if (!item.raw_content) continue;

    // Split into conversations (by "# Title" markers)
    const conversations = item.raw_content.split(/(?=^# )/m).filter(c => c.trim());

    for (const conv of conversations) {
      const lower = conv.toLowerCase();
      // Check if any search term matches
      const matchCount = searchTerms.filter(term => lower.includes(term)).length;
      if (matchCount === 0) continue;

      // Extract title
      const titleMatch = conv.match(/^# (.+)/);
      const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
      if (title === 'Untitled') continue;

      // Extract relevant excerpt around the match (first match context)
      const firstTerm = searchTerms.find(t => lower.includes(t));
      const matchIdx = lower.indexOf(firstTerm);
      const excerptStart = Math.max(0, matchIdx - 200);
      const excerptEnd = Math.min(conv.length, matchIdx + 500);
      const excerpt = conv.slice(excerptStart, excerptEnd).trim();

      allResults.push({
        title,
        excerpt,
        relevance: matchCount / searchTerms.length,
        charLength: conv.length,
      });
    }
  }

  // Sort by relevance, take top 5
  allResults.sort((a, b) => b.relevance - a.relevance);
  const topResults = allResults.slice(0, 5);

  // Build a readable summary for Sophie
  let summary = '';
  if (topResults.length > 0) {
    summary = topResults.map((r, i) =>
      `[${i + 1}] "${r.title}":\n${r.excerpt.slice(0, 400)}`
    ).join('\n\n---\n\n');
  }

  return res.status(200).json({
    results: topResults.map(r => ({ title: r.title, relevance: r.relevance })),
    summary,
    resultCount: topResults.length,
    totalSearched: allResults.length + (allResults.length === 0 ? 0 : 1),
    message: topResults.length > 0
      ? `${topResults.length} Gespräche zu "${query}" gefunden.`
      : `Keine Gespräche zu "${query}" gefunden.`,
  });
}
