// lib/report-templates.js — Default report templates for new users
// Each template uses placeholder content to demonstrate the layout.
// The AI replaces placeholders with real content from the conversation.

export const DEFAULT_TEMPLATES = {

  // ── 1. Talk mit Sophie — modern, clean, luftig ──
  default: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.7;">

  <div style="margin-bottom:40px;">
    <div style="font-size:11px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:#6366f1;margin-bottom:8px;">Session Report</div>
    <h1 style="font-size:28px;font-weight:700;color:#111;margin:0 0 6px;letter-spacing:-0.02em;">[Titel des Gesprächs]</h1>
    <div style="font-size:14px;color:#888;">[Datum] · Verified by [X] AIs</div>
  </div>

  <div style="height:1px;background:linear-gradient(to right,#6366f1,transparent);margin-bottom:36px;"></div>

  <div style="margin-bottom:36px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6366f1;margin:0 0 12px;">Zusammenfassung</h2>
    <p style="font-size:16px;color:#333;margin:0;line-height:1.8;">[Hier steht die Zusammenfassung des Gesprächs. Alle wesentlichen Punkte kompakt auf den Punkt gebracht.]</p>
  </div>

  <div style="margin-bottom:36px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6366f1;margin:0 0 14px;">Wichtige Erkenntnisse</h2>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="min-width:6px;height:6px;border-radius:50%;background:#6366f1;margin-top:8px;"></div>
        <div style="font-size:15px;color:#333;">[Erkenntnis 1 — ein wichtiger Punkt aus dem Gespräch]</div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="min-width:6px;height:6px;border-radius:50%;background:#6366f1;margin-top:8px;"></div>
        <div style="font-size:15px;color:#333;">[Erkenntnis 2 — ein weiterer relevanter Aspekt]</div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="min-width:6px;height:6px;border-radius:50%;background:#6366f1;margin-top:8px;"></div>
        <div style="font-size:15px;color:#333;">[Erkenntnis 3 — noch ein wichtiger Takeaway]</div>
      </div>
    </div>
  </div>

  <div style="margin-bottom:36px;">
    <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6366f1;margin:0 0 14px;">Nächste Schritte</h2>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#f8f7ff;border-radius:10px;border-left:3px solid #6366f1;">
        <div style="font-size:14px;font-weight:600;color:#111;">[Action Item 1]</div>
        <div style="font-size:13px;color:#666;margin-top:2px;">[Details und Verantwortlicher]</div>
      </div>
      <div style="padding:12px 16px;background:#f8f7ff;border-radius:10px;border-left:3px solid #6366f1;">
        <div style="font-size:14px;font-weight:600;color:#111;">[Action Item 2]</div>
        <div style="font-size:13px;color:#666;margin-top:2px;">[Details und Verantwortlicher]</div>
      </div>
    </div>
  </div>

  <div style="margin-top:48px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">Erstellt mit Sophie · meet-sophie.com</div>
</div>`,


  // ── 2. Meeting Report — formal, schwarz-weiß, DIN A4 Stil ──
  meeting: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:780px;margin:0 auto;padding:60px 72px;color:#1a1a1a;line-height:1.6;background:#fff;box-sizing:border-box;">

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


  // ── 3. ScoreCard — Sales Pitch + Brainstorming, visuell mit Balken ──
  salespitch: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.6;">

  <div style="text-align:center;margin-bottom:36px;">
    <div style="display:inline-block;background:#111;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;">Score Card</div>
    <h1 style="font-size:26px;font-weight:700;color:#111;margin:8px 0 4px;letter-spacing:-0.02em;">[Pitch-Thema / Brainstorm-Titel]</h1>
    <div style="font-size:14px;color:#888;">[Datum] · Analyse von [X] AIs</div>
  </div>

  <div style="background:#f8f8f8;border-radius:16px;padding:28px;margin-bottom:28px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:800;color:#111;letter-spacing:-0.03em;">[4.2]</div>
      <div style="font-size:12px;color:#888;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;">Overall Score</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Clarity</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:90%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Problem Sharpness</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Value Proposition</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Differentiation</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:60%;background:#eab308;border-radius:4px;"></div>
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
          <span style="font-size:13px;font-weight:700;color:#111;">[4.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:90%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Objection Handling</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[3.5] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:70%;background:#eab308;border-radius:4px;"></div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:500;color:#333;">Persuasiveness</span>
          <span style="font-size:13px;font-weight:700;color:#111;">[4.0] / 5</span>
        </div>
        <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:80%;background:#22c55e;border-radius:4px;"></div>
        </div>
      </div>
    </div>
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
    <div style="font-size:16px;color:#fff;line-height:1.7;">[Konkrete Empfehlung, was beim nächsten Pitch/Brainstorm anders gemacht werden sollte.]</div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">Erstellt mit Sophie · meet-sophie.com</div>
</div>`,

};

// Brainstorm uses the same scorecard template
DEFAULT_TEMPLATES.brainstorm = DEFAULT_TEMPLATES.salespitch;
