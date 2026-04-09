// lib/report-templates.js — Default report templates for new users
// Each template uses placeholder content to demonstrate the layout.
// The AI replaces placeholders with real content from the conversation.

// ── Shared inline-style constants for the Reflexion template ──
const S = {
  wrap:    'font-family:Georgia,"Times New Roman",serif;max-width:640px;margin:0 auto;padding:48px 0;color:#2c2420;line-height:1.85;',
  label:   'font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#c4a882;margin-bottom:10px;',
  title:   'font-size:26px;font-weight:400;color:#1a1210;margin:0 0 8px;font-style:italic;letter-spacing:0.01em;',
  sub:     'font-size:13px;color:#a09080;',
  divider: 'height:1px;background:linear-gradient(to right,#c4a882 40%,transparent);margin-bottom:40px;',
  heading: 'font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#c4a882;margin-bottom:14px;',
  body:    'font-size:17px;color:#3a3028;margin:0;line-height:1.9;text-align:justify;',
  bodyS:   'font-size:15px;color:#3a3028;line-height:1.8;',
  insightBox: 'margin:40px 0;padding:24px 28px;background:#faf7f4;border-radius:14px;border:1px solid #ede8e2;',
  dot:     'color:#c4a882;font-size:18px;line-height:1;margin-top:2px;',
  dotRow:  'display:flex;gap:14px;align-items:flex-start;',
  card:    'padding:14px 20px;background:rgba(196,168,130,0.08);border-radius:12px;border-left:3px solid #c4a882;',
  cardT:   'font-size:15px;font-weight:600;color:#2a2420;',
  cardD:   'font-size:13px;color:#7a6a5a;margin-top:3px;',
  highlight: 'margin:40px 0;padding:20px 24px;background:#faf7f4;border-radius:12px;border-left:3px solid #c4a882;font-size:16px;font-style:italic;color:#2a2420;line-height:1.8;',
  quote:   'font-size:15px;font-style:italic;color:#3a3028;line-height:1.8;margin:8px 0 0;padding:10px 16px;background:rgba(196,168,130,0.05);border-radius:8px;',
  qaQ:     'font-size:13px;font-weight:600;color:#7a6a5a;margin-bottom:4px;',
  qaA:     'font-size:15px;color:#3a3028;line-height:1.8;font-style:italic;',
  footer:  'margin-top:52px;padding-top:20px;border-top:1px solid #ede8e2;font-size:11px;color:#b0a090;text-align:center;font-style:italic;',
  mb40:    'margin-bottom:40px;',
  mb44:    'margin-bottom:44px;',
  col:     'display:flex;flex-direction:column;gap:12px;',
  colS:    'display:flex;flex-direction:column;gap:10px;',
};

/**
 * Renders a Sophie Reflexion report from structured section data.
 * Used by both the AI report generator and the landing page demo.
 *
 * @param {Array} sections - Array of section objects
 * @returns {string} HTML string with inline styles
 *
 * Section types:
 *   { type:'header', label, title, subtitle }
 *   { type:'summary', text }
 *   { type:'insightBox', heading, items:[] }
 *   { type:'bulletList', heading, items:[] }
 *   { type:'actionCards', heading, cards:[{title, detail}] }
 *   { type:'highlight', heading, text }
 *   { type:'subsections', heading, groups:[{label, lines:[]}] }
 *   { type:'qaPairs', heading, pairs:[{q, a}] }
 *   { type:'footer' }
 */
export function renderReflectionReport(sections) {
  const parts = [];
  for (const sec of sections) {
    switch (sec.type) {

      case 'header':
        parts.push(`<div style="${S.mb44}">
  <div style="${S.label}">${sec.label || 'Sophie · Gesprächsleitfaden'}</div>
  <h1 style="${S.title}">${sec.title}</h1>
  ${sec.subtitle ? `<div style="${S.sub}">${sec.subtitle}</div>` : ''}
</div>
<div style="${S.divider}"></div>`);
        break;

      case 'summary':
        parts.push(`<div style="${S.mb40}">
  <p style="${S.body}">${sec.text}</p>
</div>`);
        break;

      case 'insightBox':
        parts.push(`<div style="${S.insightBox}">
  <div style="${S.heading}">${sec.heading}</div>
  <div style="${S.col}">
    ${sec.items.map(item => `<div style="${S.dotRow}">
      <div style="${S.dot}">·</div>
      <div style="${S.bodyS}">${item}</div>
    </div>`).join('\n    ')}
  </div>
</div>`);
        break;

      case 'bulletList':
        parts.push(`<div style="${S.mb40}">
  <div style="${S.heading}">${sec.heading}</div>
  <div style="${S.col}">
    ${sec.items.map(item => `<div style="${S.dotRow}">
      <div style="${S.dot}">·</div>
      <div style="${S.bodyS}">${item}</div>
    </div>`).join('\n    ')}
  </div>
</div>`);
        break;

      case 'actionCards':
        parts.push(`<div style="${S.mb40}">
  <div style="${S.heading}">${sec.heading}</div>
  <div style="${S.colS}">
    ${sec.cards.map(c => `<div style="${S.card}">
      <div style="${S.cardT}">${c.title}</div>
      ${c.detail ? `<div style="${S.cardD}">${c.detail}</div>` : ''}
    </div>`).join('\n    ')}
  </div>
</div>`);
        break;

      case 'highlight':
        parts.push(`<div style="${S.mb40}">
  ${sec.heading ? `<div style="${S.heading}">${sec.heading}</div>` : ''}
  <div style="${S.highlight}">${sec.text}</div>
</div>`);
        break;

      case 'subsections':
        parts.push(`<div style="${S.mb40}">
  <div style="${S.heading}">${sec.heading}</div>
  <div style="${S.col}">
    ${sec.groups.map(g => `<div style="margin-bottom:16px;">
      <div style="font-size:13px;font-weight:600;color:#2a2420;margin-bottom:6px;">${g.label}</div>
      ${g.lines.map(l => `<div style="${S.quote}">${l}</div>`).join('\n      ')}
    </div>`).join('\n    ')}
  </div>
</div>`);
        break;

      case 'qaPairs':
        parts.push(`<div style="${S.mb40}">
  <div style="${S.heading}">${sec.heading}</div>
  <div style="${S.col}">
    ${sec.pairs.map(p => `<div style="margin-bottom:12px;">
      <div style="${S.qaQ}">${p.q}</div>
      <div style="${S.qaA}">${p.a}</div>
    </div>`).join('\n    ')}
  </div>
</div>`);
        break;

      case 'footer':
        parts.push(`<div style="${S.footer}">Sophie · meet-sophie.com</div>`);
        break;
    }
  }
  return `<div style="${S.wrap}">\n${parts.join('\n\n')}\n</div>`;
}

export const DEFAULT_TEMPLATES = {

  // ── 1. Talk mit Sophie — warm, persönlich, Tagebuch-tauglich ──
  default: `<div style="font-family:Georgia,'Times New Roman',serif;max-width:640px;margin:0 auto;padding:48px 0;color:#2c2420;line-height:1.85;">

  <div style="margin-bottom:44px;">
    <div style="font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#c4a882;margin-bottom:10px;">Sophie · Reflexion</div>
    <h1 style="font-size:26px;font-weight:400;color:#1a1210;margin:0 0 8px;font-style:italic;letter-spacing:0.01em;">[Titel des Gesprächs]</h1>
    <div style="font-size:13px;color:#a09080;">[Datum]</div>
  </div>

  <div style="height:1px;background:linear-gradient(to right,#c4a882 40%,transparent);margin-bottom:40px;"></div>

  <div style="margin-bottom:40px;">
    <p style="font-size:17px;color:#3a3028;margin:0;line-height:1.9;text-align:justify;">[Hier steht die Zusammenfassung des Gesprächs — persönlich, reflektierend, wie ein Tagebucheintrag. Was wurde besprochen, was bewegt, welche Gedanken sind entstanden.]</p>
  </div>

  <div style="margin:40px 0;padding:24px 28px;background:#faf7f4;border-radius:14px;border:1px solid #ede8e2;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#c4a882;margin-bottom:14px;">Was mir aufgefallen ist</div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;gap:14px;align-items:flex-start;">
        <div style="color:#c4a882;font-size:18px;line-height:1;margin-top:2px;">·</div>
        <div style="font-size:15px;color:#3a3028;line-height:1.8;">[Erkenntnis 1 — ein Gedanke, eine Beobachtung]</div>
      </div>
      <div style="display:flex;gap:14px;align-items:flex-start;">
        <div style="color:#c4a882;font-size:18px;line-height:1;margin-top:2px;">·</div>
        <div style="font-size:15px;color:#3a3028;line-height:1.8;">[Erkenntnis 2 — etwas das nachhallt]</div>
      </div>
      <div style="display:flex;gap:14px;align-items:flex-start;">
        <div style="color:#c4a882;font-size:18px;line-height:1;margin-top:2px;">·</div>
        <div style="font-size:15px;color:#3a3028;line-height:1.8;">[Erkenntnis 3 — ein wichtiger Takeaway]</div>
      </div>
    </div>
  </div>

  <div style="margin-bottom:40px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#c4a882;margin-bottom:14px;">Was ich mitnehme</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="padding:14px 20px;background:rgba(196,168,130,0.08);border-radius:12px;border-left:3px solid #c4a882;">
        <div style="font-size:15px;font-weight:600;color:#2a2420;">[Nächster Schritt 1]</div>
        <div style="font-size:13px;color:#7a6a5a;margin-top:3px;">[Was konkret getan werden kann]</div>
      </div>
      <div style="padding:14px 20px;background:rgba(196,168,130,0.08);border-radius:12px;border-left:3px solid #c4a882;">
        <div style="font-size:15px;font-weight:600;color:#2a2420;">[Nächster Schritt 2]</div>
        <div style="font-size:13px;color:#7a6a5a;margin-top:3px;">[Was konkret getan werden kann]</div>
      </div>
    </div>
  </div>

  <div style="margin-top:52px;padding-top:20px;border-top:1px solid #ede8e2;font-size:11px;color:#b0a090;text-align:center;font-style:italic;">Sophie · meet-sophie.com</div>
</div>`,


  // ── 2. Meeting Report — formal, schwarz-weiß, DIN A4 Stil ──
  meeting: `<style>
@media print {
  @page { size: A4; margin: 20mm 18mm; }
  html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .meeting-protocol { max-width: 100% !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; }
  .meeting-protocol > div { page-break-inside: avoid; }
  div[data-section="full-transcript"] { page-break-before: always; }
}
</style>
<div class="meeting-protocol" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:780px;margin:0 auto;padding:60px 72px;color:#1a1a1a;line-height:1.6;background:#fff;box-sizing:border-box;">

  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #1a1a1a;padding-bottom:16px;margin-bottom:6px;">
    <div>
      <div style="font-size:9px;font-weight:400;letter-spacing:0.22em;text-transform:uppercase;color:#888;margin-bottom:6px;">Sitzungsprotokoll</div>
      <div style="font-size:22px;font-weight:300;letter-spacing:0.04em;color:#1a1a1a;">[Meeting-Titel]</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#aaa;margin-bottom:4px;">Datum</div>
      <div style="font-size:12px;font-weight:300;color:#444;">[DD.MM.YYYY]</div>
    </div>
  </div>
  <div style="height:1px;background:#e0e0e0;margin-bottom:40px;"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-bottom:48px;">
    <div>
      <div style="font-size:8px;letter-spacing:0.2em;text-transform:uppercase;color:#aaa;margin-bottom:6px;">Ort</div>
      <div style="font-size:12px;font-weight:300;color:#333;">[Ort / Link]</div>
    </div>
    <div>
      <div style="font-size:8px;letter-spacing:0.2em;text-transform:uppercase;color:#aaa;margin-bottom:6px;">Uhrzeit</div>
      <div style="font-size:12px;font-weight:300;color:#333;">[00:00 – 00:00]</div>
    </div>
    <div>
      <div style="font-size:8px;letter-spacing:0.2em;text-transform:uppercase;color:#aaa;margin-bottom:6px;">Protokoll</div>
      <div style="font-size:12px;font-weight:300;color:#333;">[Name]</div>
    </div>
  </div>

  <div style="margin-bottom:48px;">
    <div style="font-size:8px;letter-spacing:0.22em;text-transform:uppercase;color:#aaa;margin-bottom:14px;">Teilnehmer</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 40px;">
      <div style="font-size:12px;font-weight:300;color:#333;padding:5px 0;border-bottom:1px solid #f0f0f0;">[Name 1] <span style="color:#bbb;font-size:11px;">[Rolle]</span></div>
      <div style="font-size:12px;font-weight:300;color:#333;padding:5px 0;border-bottom:1px solid #f0f0f0;">[Name 2] <span style="color:#bbb;font-size:11px;">[Rolle]</span></div>
    </div>
  </div>

  <div style="height:1px;background:#e8e8e8;margin-bottom:48px;"></div>

  <div style="margin-bottom:52px;">
    <div style="font-size:8px;letter-spacing:0.22em;text-transform:uppercase;color:#aaa;margin-bottom:20px;">Tagesordnung</div>
    <div style="margin-bottom:36px;">
      <div style="display:flex;align-items:baseline;gap:20px;margin-bottom:10px;">
        <span style="font-size:9px;letter-spacing:0.14em;color:#bbb;min-width:36px;">01</span>
        <span style="font-size:13px;font-weight:400;letter-spacing:0.02em;color:#1a1a1a;">[Tagesordnungspunkt 1]</span>
      </div>
      <div style="padding-left:56px;font-size:12px;font-weight:300;color:#555;line-height:1.75;">[Zusammenfassung der Diskussion zu diesem Punkt.]</div>
    </div>
    <div style="margin-bottom:36px;">
      <div style="display:flex;align-items:baseline;gap:20px;margin-bottom:10px;">
        <span style="font-size:9px;letter-spacing:0.14em;color:#bbb;min-width:36px;">02</span>
        <span style="font-size:13px;font-weight:400;letter-spacing:0.02em;color:#1a1a1a;">[Tagesordnungspunkt 2]</span>
      </div>
      <div style="padding-left:56px;font-size:12px;font-weight:300;color:#555;line-height:1.75;">[Zusammenfassung der Diskussion zu diesem Punkt.]</div>
    </div>
  </div>

  <div style="height:1px;background:#e8e8e8;margin-bottom:48px;"></div>

  <div style="margin-bottom:52px;">
    <div style="font-size:8px;letter-spacing:0.22em;text-transform:uppercase;color:#aaa;margin-bottom:20px;">Beschlüsse</div>
    <div style="display:flex;align-items:baseline;gap:20px;padding:12px 0;border-bottom:1px solid #f2f2f2;">
      <span style="font-size:9px;letter-spacing:0.12em;color:#ccc;min-width:36px;">B–01</span>
      <span style="font-size:12px;font-weight:300;color:#333;line-height:1.6;">[Beschluss 1]</span>
    </div>
    <div style="display:flex;align-items:baseline;gap:20px;padding:12px 0;border-bottom:1px solid #f2f2f2;">
      <span style="font-size:9px;letter-spacing:0.12em;color:#ccc;min-width:36px;">B–02</span>
      <span style="font-size:12px;font-weight:300;color:#333;line-height:1.6;">[Beschluss 2]</span>
    </div>
  </div>

  <div style="margin-bottom:52px;">
    <div style="font-size:8px;letter-spacing:0.22em;text-transform:uppercase;color:#aaa;margin-bottom:20px;">Action Items</div>
    <div style="display:grid;grid-template-columns:36px 1fr 120px 100px;gap:8px;align-items:baseline;font-size:12px;">
      <div style="font-size:9px;letter-spacing:0.12em;color:#ccc;">Nr.</div>
      <div style="font-weight:500;color:#888;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;">Aufgabe</div>
      <div style="font-weight:500;color:#888;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;">Verantw.</div>
      <div style="font-weight:500;color:#888;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;">Frist</div>
      <div style="font-size:9px;color:#ccc;">A–01</div>
      <div style="font-weight:300;color:#333;">[Action Item 1]</div>
      <div style="font-weight:300;color:#333;">[Name]</div>
      <div style="font-weight:300;color:#333;">[Datum]</div>
      <div style="font-size:9px;color:#ccc;">A–02</div>
      <div style="font-weight:300;color:#333;">[Action Item 2]</div>
      <div style="font-weight:300;color:#333;">[Name]</div>
      <div style="font-weight:300;color:#333;">[Datum]</div>
    </div>
  </div>

  <div style="margin-top:60px;padding-top:16px;border-top:1px solid #e0e0e0;display:flex;justify-content:space-between;font-size:10px;color:#bbb;letter-spacing:0.05em;">
    <span>Erstellt mit Sophie · meet-sophie.com</span>
    <span>[Datum]</span>
  </div>
</div>`,


  // ── 3. ScoreCard v2 — Sales Pitch, 2 Gruppen (Content + Delivery) ──
  salespitch: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.6;">

  <div style="text-align:center;margin-bottom:36px;">
    <div style="display:inline-block;background:#111;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;">Score Card</div>
    <h1 style="font-size:26px;font-weight:700;color:#111;margin:8px 0 4px;letter-spacing:-0.02em;">[Pitch-Thema]</h1>
    <div style="font-size:14px;color:#888;">[Datum] · [Pitch-Typ] · Confidence: [high/medium/low]</div>
  </div>

  <div style="background:#f8f8f8;border-radius:16px;padding:28px;margin-bottom:28px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:800;color:#111;letter-spacing:-0.03em;">[3.8]</div>
      <div style="font-size:12px;color:#888;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;">Overall Score</div>
    </div>

    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:20px 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Content (60%)</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:24px;">
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Clarity</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Problem Sharpness</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Value Proposition</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Structure</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:60%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Differentiation</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Credibility</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Audience Fit</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
    </div>
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin-bottom:20px;">Content Score: [3.7] / 5.0</div>

    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Delivery (40%)</div>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Opening</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Closing</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:60%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Voice & Rhythm <span style="font-size:11px;color:#aaa;font-weight:400;">*</span></span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:60%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Rhetoric & Language</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Authenticity <span style="font-size:11px;color:#aaa;font-weight:400;">*</span></span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Persuasiveness</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
    </div>
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin-top:14px;">Delivery Score: [3.4] / 5.0</div>
    <div style="margin-top:8px;font-size:11px;color:#aaa;font-style:italic;">* Textbasiert — Confidence: low. Für vollständige Bewertung: Voice-Modus nutzen.</div>
  </div>

  <div style="margin-bottom:28px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">Stärken</h2>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#f0fdf4;border-radius:10px;border-left:3px solid #22c55e;font-size:14px;color:#333;">[Stärke 1 — was besonders gut war]</div>
      <div style="padding:12px 16px;background:#f0fdf4;border-radius:10px;border-left:3px solid #22c55e;font-size:14px;color:#333;">[Stärke 2 — ein weiterer positiver Aspekt]</div>
    </div>
  </div>

  <div style="margin-bottom:28px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">Verbesserungspotenzial</h2>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#fffbeb;border-radius:10px;border-left:3px solid #eab308;font-size:14px;color:#333;">[Verbesserung 1 — konkreter Vorschlag]</div>
      <div style="padding:12px 16px;background:#fffbeb;border-radius:10px;border-left:3px solid #eab308;font-size:14px;color:#333;">[Verbesserung 2 — weiterer Vorschlag]</div>
    </div>
  </div>

  <div style="background:#111;border-radius:14px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin-bottom:8px;">Empfehlung für den nächsten Versuch</div>
    <div style="font-size:16px;color:#fff;line-height:1.7;">[Konkrete Empfehlung, was beim nächsten Pitch anders gemacht werden sollte.]</div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">Erstellt mit Sophie · meet-sophie.com</div>
</div>`,

  // ── 4. Brainstorming — Ideen-Cluster, visuell gruppiert ──
  brainstorm: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.6;">

  <div style="margin-bottom:36px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;">Brainstorming</div>
    <h1 style="font-size:26px;font-weight:700;color:#111;margin:8px 0 4px;letter-spacing:-0.02em;">[Brainstorm-Thema]</h1>
    <div style="font-size:14px;color:#888;">[Datum] · [X] Ideen gesammelt · Verified by [X] AIs</div>
  </div>

  <div style="background:#faf5ff;border-radius:14px;padding:20px 24px;margin-bottom:32px;border:1px solid #e9d5ff;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8b5cf6;margin-bottom:8px;">Kernfrage</div>
    <div style="font-size:16px;color:#333;line-height:1.7;">[Die zentrale Fragestellung des Brainstormings]</div>
  </div>

  <div style="margin-bottom:36px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8b5cf6;margin:0 0 16px;">Ideen-Cluster</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="background:#f8f8f8;border-radius:12px;padding:18px;border:1px solid #eee;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:10px;">[Cluster 1]</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 1.1]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 1.2]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 1.3]</div>
        </div>
      </div>
      <div style="background:#f8f8f8;border-radius:12px;padding:18px;border:1px solid #eee;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:10px;">[Cluster 2]</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 2.1]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 2.2]</div>
        </div>
      </div>
      <div style="background:#f8f8f8;border-radius:12px;padding:18px;border:1px solid #eee;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:10px;">[Cluster 3]</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 3.1]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 3.2]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 3.3]</div>
        </div>
      </div>
      <div style="background:#f8f8f8;border-radius:12px;padding:18px;border:1px solid #eee;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:10px;">[Cluster 4]</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 4.1]</div>
          <div style="padding:8px 12px;background:#fff;border-radius:8px;font-size:13px;color:#333;border:1px solid #eee;">[Idee 4.2]</div>
        </div>
      </div>
    </div>
  </div>

  <div style="margin-bottom:32px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8b5cf6;margin:0 0 14px;">Top-Favoriten</h2>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:linear-gradient(135deg,#faf5ff,#f0e7ff);border-radius:10px;border:1px solid #e9d5ff;">
        <div style="font-size:20px;font-weight:800;color:#8b5cf6;">1</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#111;">[Favorit 1 — die vielversprechendste Idee]</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">[Warum diese Idee heraussticht]</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:#f8f8f8;border-radius:10px;border:1px solid #eee;">
        <div style="font-size:20px;font-weight:800;color:#888;">2</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#111;">[Favorit 2 — zweitbeste Idee]</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">[Warum diese Idee Potenzial hat]</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:#f8f8f8;border-radius:10px;border:1px solid #eee;">
        <div style="font-size:20px;font-weight:800;color:#bbb;">3</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#111;">[Favorit 3 — drittbeste Idee]</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">[Warum diese Idee interessant ist]</div>
        </div>
      </div>
    </div>
  </div>

  <div style="margin-bottom:32px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8b5cf6;margin:0 0 14px;">Nächste Schritte</h2>
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="padding:10px 16px;background:#f8f8f8;border-radius:8px;font-size:14px;color:#333;border-left:3px solid #8b5cf6;">[Nächster Schritt 1 — was konkret getan werden soll]</div>
      <div style="padding:10px 16px;background:#f8f8f8;border-radius:8px;font-size:14px;color:#333;border-left:3px solid #8b5cf6;">[Nächster Schritt 2 — weitere Aktion]</div>
    </div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">Erstellt mit Sophie · meet-sophie.com</div>
</div>`,
};
