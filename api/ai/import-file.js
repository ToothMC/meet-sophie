// api/ai/import-file.js — File Upload Import (ZIP, JSON, TXT, DOCX)
// Accepts multipart/form-data with a file field
// Vercel bodyParser must be disabled for this route
import { createClient } from '@supabase/supabase-js';
import { createSource } from '../../lib/import/source-ledger.js';
import { processImport } from '../../lib/import/pipeline.js';
import { parseChatGPTExport } from '../../lib/import/parsers/chatgpt.js';
import { parseClaudeExport } from '../../lib/import/parsers/claude.js';
import { parseGeminiExport } from '../../lib/import/parsers/gemini.js';
import { parseTextDocument, parseDocxDocument } from '../../lib/import/parsers/documents.js';

// Disable Vercel's default body parser for file uploads
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

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

  // Parse the body — expect JSON with base64 file data
  // (Frontend reads file as base64 and sends via JSON)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { fileName, fileData, source } = body;
  if (!fileData) return res.status(400).json({ error: 'Missing fileData (base64)' });
  if (!fileName) return res.status(400).json({ error: 'Missing fileName' });

  // Decode base64 to buffer
  const buffer = Buffer.from(fileData, 'base64');
  const ext = fileName.split('.').pop().toLowerCase();
  const detectedSource = source || detectSource(fileName, ext);

  // Parse file based on extension + detected source
  let parsedContent = '';
  let fileType = ext;

  try {
    if (ext === 'zip' || ext === 'dms') {
      // Try both parsers — Claude ZIP has different structure than ChatGPT
      let parsed = [];

      if (detectedSource === 'claude') {
        parsed = await parseClaudeExport(buffer, 'zip');
      } else {
        // Try ChatGPT parser first
        try {
          parsed = await parseChatGPTExport(buffer, 'zip');
        } catch {
          // If ChatGPT parser fails, try Claude parser (ZIP might be from Claude)
          parsed = await parseClaudeExport(buffer, 'zip');
        }
      }

      parsedContent = parsed.map(p => {
        const parts = [];
        if (p.title && p.title !== 'Untitled') parts.push(`# ${p.title}`);
        if (p.content) parts.push(p.content);
        else if (p.lastMessage) parts.push(p.lastMessage);
        if (p.sections) parts.push(Object.entries(p.sections).map(([k, v]) => `${k}: ${v}`).join('\n'));
        return parts.join('\n');
      }).filter(t => t.trim().length > 10).join('\n\n---\n\n');
    } else if (ext === 'json') {
      const jsonStr = buffer.toString('utf-8');
      // Try Claude JSON format first, then ChatGPT
      let parsed = [];
      try {
        const data = JSON.parse(jsonStr);
        if (Array.isArray(data) && data[0]?.chat_messages) {
          parsed = await parseClaudeExport(jsonStr, 'json');
        } else {
          parsed = await parseChatGPTExport(jsonStr, 'json');
        }
      } catch {
        parsed = await parseChatGPTExport(jsonStr, 'json');
      }
      parsedContent = parsed.map(p => {
        const parts = [];
        if (p.title && p.title !== 'Untitled') parts.push(`# ${p.title}`);
        if (p.content) parts.push(p.content);
        else if (p.lastMessage) parts.push(p.lastMessage);
        return parts.join('\n');
      }).filter(t => t.trim().length > 10).join('\n\n---\n\n');
    } else if (ext === 'docx') {
      const parsed = await parseDocxDocument(buffer);
      parsedContent = parsed.content;
    } else if (ext === 'txt' || ext === 'md') {
      parsedContent = buffer.toString('utf-8');
    } else {
      parsedContent = buffer.toString('utf-8');
    }
  } catch (err) {
    return res.status(400).json({ error: `Datei konnte nicht geparst werden: ${err.message?.slice(0, 200)}` });
  }

  if (!parsedContent.trim()) {
    return res.status(400).json({ error: 'Keine Inhalte in der Datei gefunden' });
  }

  // Create source connection
  const sourceId = await createSource({
    userId: user.id,
    sourceType: detectedSource,
    sourceName: `${fileName} (${new Date().toLocaleDateString('de-DE')})`,
    importMethod: 'file_upload',
  });

  // Run pipeline
  const result = await processImport(user.id, sourceId, parsedContent, detectedSource);

  return res.status(200).json({
    sourceId,
    ...result,
    fileName,
    fileType,
    message: `Datei "${fileName}" verarbeitet: ${result.zoneB} Insights extrahiert, ${result.memoryCandidates.length} Memory-Kandidaten gefunden.`,
  });
}

function detectSource(fileName, ext) {
  const name = fileName.toLowerCase();
  if (name.includes('chatgpt') || name.includes('conversations.json')) return 'chatgpt';
  if (name.includes('claude')) return 'claude';
  // Claude exports: "data-YYYY-MM-DD-HH-MM-SS-batch-NNNN.zip"
  if (name.match(/^data-\d{4}-\d{2}-\d{2}.*batch.*\.zip$/)) return 'claude';
  if (name.includes('gemini') || name.includes('takeout')) return 'gemini';
  if (ext === 'dms') return 'claude'; // Claude .dms exports
  if (ext === 'zip' || ext === 'json') return 'file'; // Don't assume — let parser detect
  return 'file';
}
