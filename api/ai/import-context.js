// api/ai/import-context.js — Import Context API (POST handler)
// Accepts chat paste (text) or file upload info, runs pipeline, returns preview.
// Second call: user confirms Zone-C items.
import { createClient } from '@supabase/supabase-js';
import { createSource } from '../../lib/import/source-ledger.js';
import { processImport, approveForMemory } from '../../lib/import/pipeline.js';
import { writeToProfile } from '../../lib/import/profile-writer.js';
import { getExtractionPrompt } from '../../lib/import/prompts.js';
import { parseChatGPTExport } from '../../lib/import/parsers/chatgpt.js';
import { parseClaudeExport } from '../../lib/import/parsers/claude.js';
import { parseGeminiExport } from '../../lib/import/parsers/gemini.js';

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

  const { action } = body;

  // --- Action: get-prompt ---
  // Returns the extraction prompt for a specific source
  if (action === 'get-prompt') {
    const { source } = body;
    if (!source || !['chatgpt', 'claude', 'gemini'].includes(source)) {
      return res.status(400).json({ error: 'Invalid source. Use: chatgpt, claude, gemini' });
    }
    return res.status(200).json({ prompt: getExtractionPrompt(source) });
  }

  // --- Action: import ---
  // Processes pasted text through the 3-zone pipeline
  if (action === 'import') {
    const { source, content } = body;
    if (!content) return res.status(400).json({ error: 'Missing content' });
    if (!source) return res.status(400).json({ error: 'Missing source (chatgpt/claude/gemini/file)' });

    // Parse based on source
    let parsedContent = content;
    try {
      if (source === 'chatgpt') {
        const parsed = await parseChatGPTExport(content, 'text');
        parsedContent = parsed.map(p => p.lastMessage || p.content || content).join('\n\n');
      } else if (source === 'claude') {
        const parsed = parseClaudeExport(content);
        parsedContent = parsed.map(p => p.content || content).join('\n\n');
      } else if (source === 'gemini') {
        const parsed = parseGeminiExport(content);
        parsedContent = parsed.map(p => p.content || content).join('\n\n');
      }
    } catch {
      // If parsing fails, use raw content
      parsedContent = content;
    }

    // Create source connection
    const sourceId = await createSource({
      userId: user.id,
      sourceType: source,
      sourceName: `${source} Import vom ${new Date().toLocaleDateString('de-DE')}`,
      importMethod: 'chat_paste',
    });

    // Run pipeline
    const result = await processImport(user.id, sourceId, parsedContent, source);

    return res.status(200).json({
      sourceId,
      ...result,
      message: `Import verarbeitet: ${result.zoneB} Insights extrahiert, ${result.memoryCandidates.length} Memory-Kandidaten gefunden.`,
    });
  }

  // --- Action: approve ---
  // User approves specific items to be promoted to Zone C (memory)
  if (action === 'approve') {
    const { sourceId, itemIds } = body;
    if (!sourceId || !Array.isArray(itemIds)) {
      return res.status(400).json({ error: 'Missing sourceId or itemIds array' });
    }

    // Approve items
    await approveForMemory(sourceId, itemIds);

    // Get approved items and write to profile
    const { data: approvedItems } = await supabase
      .from('source_items')
      .select('*')
      .eq('source_id', sourceId)
      .eq('zone', 'C')
      .eq('user_approved', true);

    if (approvedItems?.length > 0) {
      await writeToProfile(user.id, sourceId, approvedItems.map(item => ({
        type: item.content_type,
        insights: item.extracted_insights || {},
        content: item.summary || item.raw_content || '',
      })));
    }

    return res.status(200).json({
      approved: itemIds.length,
      profileUpdated: (approvedItems?.length || 0) > 0,
      message: `${itemIds.length} Items in Sophie's Gedächtnis übernommen.`,
    });
  }

  return res.status(400).json({ error: 'Unknown action. Use: get-prompt, import, approve' });
}
