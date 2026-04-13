// lib/gmail-fetch.js — Gmail API Wrapper
// On-demand: kein Preloading, kein Cache, kein Context-Injection.
// Nur Tool-basiert ueber Voice/Chat.

import { getValidToken } from './google-token.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Sucht Emails via Gmail API.
 * @param {string} token
 * @param {string} query — Gmail-Suchsyntax (from:, subject:, is:unread, etc.)
 * @param {number} maxResults
 * @returns {Array} — Liste von { id, threadId, snippet, from, subject, date }
 */
export async function searchEmails(token, query, maxResults = 5) {
  try {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(maxResults, 10)),
    });

    const listRes = await fetch(`${GMAIL_API}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) {
      console.warn(`[gmail] List error: ${listRes.status}`);
      return [];
    }

    const listData = await listRes.json();
    const messageIds = (listData.messages || []).map(m => m.id);
    if (!messageIds.length) return [];

    // Batch-Get: Header-Details (allSettled = ein fehlender Eintrag killt nicht alles)
    const results = await Promise.allSettled(
      messageIds.map(id => getMessageHeaders(token, id))
    );

    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  } catch (e) {
    console.warn('[gmail] Search error:', e?.message);
    return [];
  }
}

async function getMessageHeaders(token, messageId) {
  try {
    const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const msg = await res.json();
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    return {
      id: msg.id,
      threadId: msg.threadId,
      snippet: msg.snippet || '',
      from: getHeader('From'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      labelIds: msg.labelIds || [],
      isUnread: (msg.labelIds || []).includes('UNREAD'),
    };
  } catch {
    return null;
  }
}

/**
 * Liest eine einzelne Email mit vollem Body.
 * @returns {{ id, from, to, subject, date, body, snippet } | null}
 */
export async function getEmail(token, messageId) {
  try {
    const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const msg = await res.json();
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    // Body extrahieren (text/plain bevorzugt, dann text/html)
    const body = extractBody(msg.payload);

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      body: body.slice(0, 3000), // Max 3000 Zeichen fuer den Prompt
      snippet: msg.snippet || '',
    };
  } catch (e) {
    console.warn('[gmail] Get error:', e?.message);
    return null;
  }
}

function extractBody(payload) {
  if (!payload) return '';

  // Direkt im Body (simple messages)
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    if (payload.mimeType === 'text/plain') return decoded;
    if (payload.mimeType === 'text/html') return stripHtml(decoded);
  }

  // Multipart: text/plain zuerst suchen, dann text/html
  if (payload.parts) {
    const plainPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plainPart?.body?.data) {
      return Buffer.from(plainPart.body.data, 'base64url').toString('utf8');
    }
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return stripHtml(Buffer.from(htmlPart.body.data, 'base64url').toString('utf8'));
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sendet eine Email via Gmail API.
 * @returns {{ success: boolean, messageId?: string, error?: string }}
 */
export async function sendEmail(token, { to, subject, body, cc, replyTo }) {
  try {
    // RFC 2822 Format
    const lines = [];
    lines.push(`To: ${to}`);
    if (cc) lines.push(`Cc: ${cc}`);
    lines.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
    if (replyTo) lines.push(`In-Reply-To: ${replyTo}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(body);

    const raw = Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch(`${GMAIL_API}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error?.message || `HTTP ${res.status}` };
    }

    const data = await res.json();
    return { success: true, messageId: data.id };
  } catch (e) {
    return { success: false, error: e?.message || 'Unknown error' };
  }
}

// ── Formatierung ──────────────────────────────────────

export function formatEmailResults(messages, language = 'de') {
  if (!messages?.length) return language === 'de' ? 'Keine Emails gefunden.' : 'No emails found.';

  return messages.map(m => {
    const from = m.from?.replace(/<[^>]+>/, '').trim() || '?';
    const unread = m.isUnread ? ' [NEU]' : '';
    return `- ${from}: ${m.subject || '(kein Betreff)'}${unread} {id:${m.id}}`;
  }).join('\n');
}

export function formatEmailDetail(message, language = 'de') {
  if (!message) return language === 'de' ? 'Email nicht gefunden.' : 'Email not found.';

  return `Von: ${message.from}\nAn: ${message.to}\nBetreff: ${message.subject}\nDatum: ${message.date}\n\n${message.body}`;
}

// ── Convenience Wrapper ──────────────────────────────

export async function searchEmailsForUser(userId, query, { maxResults = 5, language = 'de' } = {}) {
  const token = await getValidToken(userId, 'google');
  if (!token) return { text: 'Gmail nicht verbunden.', messages: [] };

  const messages = await searchEmails(token, query, maxResults);
  return { text: formatEmailResults(messages, language), messages };
}

export async function getEmailForUser(userId, messageId, { language = 'de' } = {}) {
  const token = await getValidToken(userId, 'google');
  if (!token) return { text: 'Gmail nicht verbunden.' };

  const message = await getEmail(token, messageId);
  return { text: formatEmailDetail(message, language), message };
}

export async function sendEmailForUser(userId, { to, subject, body, cc, replyTo }) {
  const token = await getValidToken(userId, 'google');
  if (!token) return { success: false, error: 'Gmail nicht verbunden.' };

  return sendEmail(token, { to, subject, body, cc, replyTo });
}
