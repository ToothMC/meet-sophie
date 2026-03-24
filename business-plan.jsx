import { useState } from "react";
const SCENARIOS = {
  conservative: {
    label: "Vorsichtig",
    color: "#6B7280",
    mix: { assistant: 75, friend: 20, partner: 5 },
    topupRate: 18, topupAvg: 10,
    arpu: 21.95, contribution: 15.86, margin: 72.2,
    years: [
      { y: 1, users: 120, revenue: 31608, cb: 22833, fix: 21600, profit: 1233 },
      { y: 2, users: 300, revenue: 79020, cb: 57096, fix: 36000, profit: 21096 },
      { y: 3, users: 500, revenue: 131700, cb: 95136, fix: 54000, profit: 41136 },
      { y: 4, users: 900, revenue: 237060, cb: 171245, fix: 84000, profit: 87245 },
      { y: 5, users: 1400, revenue: 368760, cb: 266381, fix: 120000, profit: 146381 },
    ]
  },
  realistic: {
    label: "Realistisch",
    color: "#3B82F6",
    mix: { assistant: 65, friend: 25, partner: 10 },
    topupRate: 22, topupAvg: 10,
    arpu: 25.35, contribution: 18.20, margin: 71.8,
    years: [
      { y: 1, users: 250, revenue: 76050, cb: 54596, fix: 26400, profit: 28196 },
      { y: 2, users: 700, revenue: 212940, cb: 152890, fix: 48000, profit: 104890 },
      { y: 3, users: 1400, revenue: 425880, cb: 305735, fix: 78000, profit: 227735 },
      { y: 4, users: 2800, revenue: 851760, cb: 611470, fix: 144000, profit: 467470 },
      { y: 5, users: 4200, revenue: 1277640, cb: 917204, fix: 216000, profit: 701204 },
    ]
  },
  strong: {
    label: "Stark",
    color: "#10B981",
    mix: { assistant: 50, friend: 32, partner: 18 },
    topupRate: 28, topupAvg: 12,
    arpu: 31.16, contribution: 22.21, margin: 71.3,
    years: [
      { y: 1, users: 500, revenue: 186960, cb: 133255, fix: 36000, profit: 97255 },
      { y: 2, users: 1500, revenue: 560880, cb: 399766, fix: 72000, profit: 327766 },
      { y: 3, users: 3000, revenue: 1121760, cb: 799531, fix: 120000, profit: 679531 },
      { y: 4, users: 5500, revenue: 2056560, cb: 1465807, fix: 228000, profit: 1237807 },
      { y: 5, users: 9000, revenue: 3365280, cb: 2398594, fix: 360000, profit: 2038594 },
    ]
  }
};
const TIERS = [
  { name: "Free", price: "€0", priceNum: 0, color: "#94A3B8", voiceCost: 0, cb: 0, desc: "Kennenlernen", minutes: "~2 min", features: ["Chat + Voice (limitiert)", "Erstes Gespräch", "Einfache Zusammenfassung"] },
  { name: "Assistant", price: "€14.90", priceNum: 14.90, color: "#6366F1", voiceCost: 4.07, cb: 10.83, desc: "Klarheit & Nutzen", minutes: "~68 min", features: ["Chat & Voice", "Session Summaries", "Brainstorming & Ideen", "Meeting-Vorbereitung", "Sales Pitch Übung"] },
  { name: "Friend", price: "€29.90", priceNum: 29.90, color: "#8B5CF6", voiceCost: 7.90, cb: 22.00, desc: "Persönlich & Kontinuierlich", minutes: "~132 min", features: ["Alles aus Assistant", "Persönlichere Sophie", "Stärkere Kontinuität", "Zugang zu vergangenen Sessions", "Tieferes Kontextverständnis"] },
  { name: "Partner", price: "€59.90", priceNum: 59.90, color: "#A855F7", voiceCost: 19.15, cb: 40.75, desc: "Tiefste Bindung", minutes: "~319 min", features: ["Alles aus Friend", "Stärkste Kontinuität", "Priority Access", "Meeting Mode", "Early Access Features"] },
];

// ============================================================
// SPRINT STATUS — Letzte Aktualisierung: 24. März 2026
// Basierend auf Codebase-Analyse (api/, talk/, index.html, lib/)
// ============================================================
const SPRINT_STATUS = {
  overall: 85, // vorher 77%
  packages: [
    {
      name: "Voice-Hauptflow stabilisieren",
      progress: 90, // vorher 80%
      status: "Fast fertig",
      statusColor: "#22C55E",
      details: "OpenAI Realtime voll integriert. Retry (3 Attempts + Backoff), VAD, Session-Lock (acquire_realtime_lock), Soft-End-Warning. Offen: mobile Safari Edge Cases.",
      updated: "2026-03-24"
    },
    {
      name: "Auth / Magic Link sauber",
      progress: 95, // vorher 90%
      status: "Fertig",
      statusColor: "#10B981",
      details: "PKCE Callback, Bearer-Token in allen Endpoints, Login + Callback Pages komplett. Nur Kosmetik offen.",
      updated: "2026-03-24"
    },
    {
      name: "Realtime-Session-Fehler beseitigen",
      progress: 85, // vorher 70%
      status: "Fast fertig",
      statusColor: "#22C55E",
      details: "acquire_realtime_lock() mit TTL, 429/402 Error-Codes, Daily Free Cap, Retry-Logik (3 Attempts). Offen: Session-Timeout UX mobile, Audio-Permissions.",
      updated: "2026-03-24"
    },
    {
      name: "Session-Ende + Insights",
      progress: 95, // vorher 90%
      status: "Fertig",
      statusColor: "#10B981",
      details: "Backend: structured JSON via Claude API → conversation_outputs. Frontend: Panel mit Summary/Insights/Next Steps Tabs + Transcript-Tab. Export (Copy/Share/Download). Nur Polish.",
      updated: "2026-03-24"
    },
    {
      name: "Memory Chat↔Voice konsistent",
      progress: 75, // vorher 55%
      status: "In Arbeit",
      statusColor: "#F59E0B",
      details: "Text-Chat existiert (index.html), Voice-Offer + VOICE_CONFIRMED Mechanismus, x-sophie-handover für Chat→Voice Kontext, shared user_profile/user_relationship. sophie-core.js noch Stub ('not yet implemented').",
      updated: "2026-03-24"
    },
  ],
  nextSteps: [
    { prio: "Kritisch", task: "Fremden Tester durchschicken", desc: "Done-Kriterium für Sprint 1. Reconnect-Verhalten, Audio-Permissions, Browser-Kompatibilität prüfen.", status: "Offen" },
    { prio: "Kritisch", task: "Mobile Safari + langsame Verbindungen", desc: "WebSocket-Reconnect, Audio-Permissions-Handling, Timeout-UX auf mobilen Geräten.", status: "Offen" },
    { prio: "Hoch", task: "sophie-core.js implementieren", desc: "Prompt-Building aus chat.js und session.js extrahieren. Aktuell inline + TODO-Kommentar.", status: "Offen" },
    { prio: "Hoch", task: "Stripe 4-Tier vorbereiten", desc: "Code hat noch starter/plus. Migration zu free/assistant/friend/partner → Sprint 2.", status: "Sprint 2" },
    { prio: "Mittel", task: "Insights-Panel Polish", desc: "Panel existiert und funktioniert. Feinschliff an Layout und Animationen.", status: "Offen" },
  ],
  codebaseStats: {
    apiEndpoints: 9,
    dbTables: "8+",
    rlsActive: true,
    deployment: "Vercel",
    currentBranch: "fix/memory-short-long-term",
    stripeModel: "2-Tier (starter/plus) — 4-Tier geplant für Sprint 2",
  }
};

const SPRINTS = [
  {
    id: 1, name: "Produktkern", weeks: "W1–W3", prio: "P0", color: "#EF4444",
    progress: SPRINT_STATUS.overall,
    packages: SPRINT_STATUS.packages.map(p => `${p.name} (${p.progress}%)`),
    deps: "—",
    done: "Fremder Tester kommt ohne Hilfe durch",
    doneReached: false,
    notes: "Backend stark, Frontend Voice-UI + Insights komplett. Blocker: externer Nutzertest."
  },
  {
    id: 2, name: "Monetarisierung", weeks: "W4–W6", prio: "P0", color: "#F97316",
    progress: 25,
    packages: [
      "4-Tier Migration: starter/plus → free/assistant/friend/partner",
      "Stripe Checkout erweitern (3 Sub-Preise + 3 Top-ups)",
      "includedSecondsForPlan() auf 4 Tiers erweitern",
      "Usage-Tracking & Limits pro Tier",
      "Legal + Checkboxen (bereits teilweise vorhanden)"
    ],
    deps: "Sprint 1",
    done: "User kann kaufen + nutzen ohne Support",
    doneReached: false,
    notes: "Stripe Checkout/Portal/Webhook bereits implementiert für 2 Tiers. Migration auf 4 Tiers ist Hauptarbeit."
  },
  {
    id: 3, name: "Conversion", weeks: "W7–W9", prio: "P1", color: "#EAB308",
    progress: 10,
    packages: ["Landing Page Pricing-Cards", "Onboarding/Erstgespräch optimieren", "Upgrade-Momente einbauen", "Post-Session Insights stärken"],
    deps: "Sprint 2",
    done: "User versteht Produkt + Nutzen sofort",
    doneReached: false,
    notes: "Landing Page mit Pricing-Cards existiert bereits. Onboarding-Flow + Upgrade-Nudges fehlen."
  },
  {
    id: 4, name: "Retention", weeks: "W10–W12", prio: "P1", color: "#22C55E",
    progress: 5,
    packages: ["Relationship Layer implementieren", "Chat als Ergänzung", "History/vergangene Insights", "Behavior Sliders System", "Memory-Scope je Tier"],
    deps: "Sprint 3",
    done: "Plausiblen Grund wiederzukommen",
    doneReached: false,
    notes: "Memory-Grundstruktur (user_profile, user_relationship) existiert. Behavior Sliders + Tier-Scope fehlen."
  },
  {
    id: 5, name: "Wachstum", weeks: "W13–W16", prio: "P2", color: "#3B82F6",
    progress: 0,
    packages: ["Social Hooks / Sophie Says", "Content / Shorts / Ads", "Funnel-Tracking", "Conversion-Messung", "Pricing-Experimente"],
    deps: "Sprint 4",
    done: "Traffic → User → Zahler Pipeline steht",
    doneReached: false,
    notes: "Noch nicht gestartet."
  },
];

const ARCH_LAYERS = [
  { name: "Identity Layer", desc: "Unveränderliche Kernpersona", color: "#8B5CF6", details: "Warm, intelligent, aufmerksam, natürlich. Ändert sich nie — unabhängig von Tier oder Stimmung." },
  { name: "Relationship Layer", desc: "Beziehungstiefe je Tier", color: "#A855F7", details: "Free → Assistant → Friend → Partner. Steuert Nähe, Initiative, Erinnerungstiefe, Exklusivität." },
  { name: "Behavior Layer", desc: "Dynamische Verhaltenswerte", color: "#C084FC", details: "warmth, structure, reflection, assertiveness, energy, playfulness — pro Turn angepasst." },
  { name: "Memory & Permission", desc: "Kontext- & Datengrenzen", color: "#DDD6FE", details: "Was gespeichert wird, wie tief, wie lange. Definiert Beziehungsgefühl vs. Creepiness-Grenze." },
];

function fmt(n) {
  if (n >= 1000000) return `€${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `€${(n / 1000).toFixed(0)}k`;
  return `€${n}`;
}

function BarChart({ data, dataKey, label, color, maxVal }) {
  const max = maxVal || Math.max(...data.map(d => d[dataKey]));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 160, padding: "0 4px" }}>
      {data.map((d, i) => {
        const h = max > 0 ? (d[dataKey] / max) * 140 : 0;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600 }}>{fmt(d[dataKey])}</span>
            <div style={{ width: "100%", height: h, background: `linear-gradient(180deg, ${color}, ${color}88)`, borderRadius: "6px 6px 2px 2px", minHeight: 2, transition: "height 0.5s ease" }} />
            <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 500 }}>J{d.y}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProgressBar({ progress, color, height = 8 }) {
  return (
    <div style={{ width: "100%", height, background: "#2A2D37", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg, ${color}, ${color}CC)`, borderRadius: height / 2, transition: "width 0.8s ease" }} />
    </div>
  );
}

function MiniStat({ label, value, sub, accent }) {
  return (
    <div style={{ textAlign: "center", padding: "12px 8px" }}>
      <div style={{ fontSize: 11, color: "#9CA3AF", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#F9FAFB" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function SophieBusinessPlan() {
  const [activeScenario, setActiveScenario] = useState("realistic");
  const [activeTab, setActiveTab] = useState("overview");
  const [expandedSprint, setExpandedSprint] = useState(null);
  const [expandedLayer, setExpandedLayer] = useState(null);
  const sc = SCENARIOS[activeScenario];
  const y5 = sc.years[4];
  const tabs = [
    { id: "overview", label: "Übersicht" },
    { id: "sprint", label: "Sprint Status" },
    { id: "pricing", label: "Pricing" },
    { id: "finance", label: "Finanzen" },
    { id: "architecture", label: "Architektur" },
    { id: "project", label: "Projektplan" },
    { id: "why", label: "Warum Sophie?" },
  ];
  return (
    <div style={{ fontFamily: "'DM Sans', 'Manrope', system-ui, sans-serif", background: "#0F1117", color: "#E5E7EB", minHeight: "100vh", padding: "24px 16px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
      `}</style>
      {/* Header */}
      <div style={{ maxWidth: 960, margin: "0 auto 32px", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: "#A855F7", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>Business Plan 2026–2031</div>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "#F9FAFB", lineHeight: 1.2, marginBottom: 8 }}>Meet Sophie</h1>
        <p style={{ fontSize: 14, color: "#9CA3AF", maxWidth: 520, margin: "0 auto" }}>Premium Voice-AI Relationship Subscription — Geschäftsmodell, Pricing, Architektur & Roadmap</p>
      </div>
      {/* Tabs */}
      <div style={{ maxWidth: 960, margin: "0 auto 24px", display: "flex", gap: 4, flexWrap: "wrap", background: "#1A1D27", borderRadius: 12, padding: 4 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            flex: 1, minWidth: 80, padding: "10px 8px", borderRadius: 8, border: "none", cursor: "pointer",
            background: activeTab === t.id ? "#A855F7" : "transparent",
            color: activeTab === t.id ? "#FFF" : "#9CA3AF",
            fontSize: 11, fontWeight: 600, fontFamily: "inherit", transition: "all 0.2s"
          }}>{t.label}</button>
        ))}
      </div>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        {/* ===== OVERVIEW TAB ===== */}
        {activeTab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Scenario Selector */}
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(SCENARIOS).map(([k, v]) => (
                <button key={k} onClick={() => setActiveScenario(k)} style={{
                  flex: 1, padding: "14px 12px", borderRadius: 10, border: activeScenario === k ? `2px solid ${v.color}` : "2px solid #2A2D37",
                  background: activeScenario === k ? `${v.color}15` : "#1A1D27", cursor: "pointer",
                  color: activeScenario === k ? v.color : "#9CA3AF", fontSize: 13, fontWeight: 600, fontFamily: "inherit"
                }}>{v.label}</button>
              ))}
            </div>
            {/* Key Metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="ARPU / Monat" value={`€${sc.arpu}`} accent={sc.color} />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="DB-Marge" value={`${sc.margin}%`} accent="#10B981" />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="Umsatz J5" value={fmt(y5.revenue)} accent="#F59E0B" />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="Gewinn J5" value={fmt(y5.profit)} accent="#A855F7" sub="vor Steuern" />
              </div>
            </div>
            {/* Revenue + Profit Charts */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>UMSATZ / JAHR</div>
                <BarChart data={sc.years} dataKey="revenue" color={sc.color} />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>OPERATIVER GEWINN / JAHR</div>
                <BarChart data={sc.years} dataKey="profit" color="#10B981" />
              </div>
            </div>
            {/* Growth Table */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37", overflowX: "auto" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>DETAILANSICHT — {sc.label.toUpperCase()}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    <th style={{ padding: "8px 12px", textAlign: "left" }}>Jahr</th>
                    <th style={{ padding: "8px 12px", textAlign: "right" }}>Paid User</th>
                    <th style={{ padding: "8px 12px", textAlign: "right" }}>Umsatz</th>
                    <th style={{ padding: "8px 12px", textAlign: "right" }}>DB</th>
                    <th style={{ padding: "8px 12px", textAlign: "right" }}>Fix</th>
                    <th style={{ padding: "8px 12px", textAlign: "right" }}>Gewinn</th>
                  </tr>
                </thead>
                <tbody>
                  {sc.years.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #2A2D37" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 600 }}>Jahr {r.y}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{r.users.toLocaleString()}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: sc.color }}>{fmt(r.revenue)}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{fmt(r.cb)}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#EF4444" }}>{fmt(r.fix)}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: r.profit > 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>{fmt(r.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* ===== SPRINT STATUS TAB ===== */}
        {activeTab === "sprint" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Overall Progress */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: "0.05em" }}>Sprint 1 — Produktkern (W1–W3)</div>
                  <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>Done-Kriterium: Fremder Tester kommt ohne Hilfe durch — <span style={{ color: "#F59E0B" }}>Noch nicht erreicht</span></div>
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#A855F7" }}>{SPRINT_STATUS.overall}%</div>
              </div>
              <ProgressBar progress={SPRINT_STATUS.overall} color="#A855F7" height={10} />
            </div>
            {/* Top Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="Sprint 1 gesamt" value={`~${SPRINT_STATUS.overall}%`} sub="Produktkern" accent="#A855F7" />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="Zeitplan" value="W3/3" sub="Ende diese Woche" accent="#F59E0B" />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="API-Endpoints" value={SPRINT_STATUS.codebaseStats.apiEndpoints} sub="Live auf Vercel" accent="#3B82F6" />
              </div>
              <div style={{ background: "#1A1D27", borderRadius: 12, border: "1px solid #2A2D37" }}>
                <MiniStat label="DB-Tabellen" value={SPRINT_STATUS.codebaseStats.dbTables} sub="RLS aktiv" accent="#10B981" />
              </div>
            </div>
            {/* Work Packages */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: "0.05em" }}>Arbeitspakete — Detail</div>
              {SPRINT_STATUS.packages.map((pkg, i) => (
                <div key={i} style={{ background: "#1A1D27", borderRadius: 12, padding: 16, border: "1px solid #2A2D37" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#F9FAFB" }}>{i + 1}. {pkg.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: pkg.statusColor, background: `${pkg.statusColor}20`, padding: "3px 10px", borderRadius: 10 }}>{pkg.status}</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: pkg.statusColor }}>{pkg.progress}%</span>
                    </div>
                  </div>
                  <ProgressBar progress={pkg.progress} color={pkg.statusColor} />
                  <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 8, lineHeight: 1.5 }}>{pkg.details}</div>
                </div>
              ))}
            </div>
            {/* Next Steps */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.05em" }}>Nächste Schritte — KW13</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {SPRINT_STATUS.nextSteps.map((step, i) => {
                  const prioColor = step.prio === "Kritisch" ? "#EF4444" : step.prio === "Hoch" ? "#F59E0B" : "#3B82F6";
                  return (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "12px 14px", background: "#0F111788", borderRadius: 10, border: "1px solid #2A2D3744" }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 28 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#6B7280" }}>{i + 1}</span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#F9FAFB" }}>{step.task}</span>
                          <span style={{ fontSize: 10, fontWeight: 600, color: prioColor, background: `${prioColor}20`, padding: "2px 8px", borderRadius: 8 }}>{step.prio}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "#9CA3AF", lineHeight: 1.4 }}>{step.desc}</div>
                      </div>
                      <div style={{ fontSize: 11, color: step.status === "Offen" ? "#F59E0B" : "#6B7280", fontWeight: 500, whiteSpace: "nowrap" }}>{step.status}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Codebase Info */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 16, border: "1px solid #2A2D37", fontSize: 11, color: "#6B7280" }}>
              Stand: 24. März 2026 · Branch: <span style={{ color: "#A855F7", fontFamily: "'JetBrains Mono', monospace" }}>{SPRINT_STATUS.codebaseStats.currentBranch}</span> · Stripe: {SPRINT_STATUS.codebaseStats.stripeModel}
            </div>
          </div>
        )}
        {/* ===== PRICING TAB ===== */}
        {activeTab === "pricing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Pricing Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {TIERS.map((t, i) => (
                <div key={i} style={{
                  background: "#1A1D27", borderRadius: 14, padding: 20, border: i === 3 ? `2px solid ${t.color}` : "1px solid #2A2D37",
                  display: "flex", flexDirection: "column", gap: 12, position: "relative",
                  boxShadow: i === 3 ? `0 0 30px ${t.color}20` : "none"
                }}>
                  {i === 3 && <div style={{ position: "absolute", top: -10, right: 16, background: t.color, color: "#FFF", fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20 }}>PREMIUM</div>}
                  <div style={{ fontSize: 11, color: t.color, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em" }}>{t.name}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#F9FAFB" }}>{t.price}<span style={{ fontSize: 12, color: "#6B7280", fontWeight: 400 }}>{t.priceNum > 0 ? " /mo" : ""}</span></div>
                  <div style={{ fontSize: 12, color: "#9CA3AF" }}>{t.desc}</div>
                  <div style={{ borderTop: "1px solid #2A2D37", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    {t.features.map((f, j) => (
                      <div key={j} style={{ fontSize: 11, color: "#D1D5DB", display: "flex", gap: 6, alignItems: "flex-start" }}>
                        <span style={{ color: t.color, fontSize: 14, lineHeight: 1 }}>✓</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* Unit Economics */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>UNIT ECONOMICS PRO PAID USER / MONAT</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {TIERS.filter(t => t.priceNum > 0).map((t, i) => {
                  const pct = (t.cb / t.priceNum) * 100;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 80, fontSize: 12, fontWeight: 600, color: t.color }}>{t.name}</div>
                      <div style={{ flex: 1, height: 28, background: "#2A2D37", borderRadius: 6, overflow: "hidden", position: "relative" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${t.color}, ${t.color}99)`, borderRadius: 6, transition: "width 0.8s ease" }} />
                        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", fontSize: 11, fontWeight: 600 }}>
                          <span>DB: €{t.cb.toFixed(2)}</span>
                          <span style={{ color: "#9CA3AF" }}>Kosten: €{t.voiceCost.toFixed(2)}</span>
                        </div>
                      </div>
                      <div style={{ width: 50, fontSize: 12, fontWeight: 700, color: "#10B981", textAlign: "right" }}>{pct.toFixed(0)}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Pricing Evaluation */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>BEWERTUNG DER PREISSTRUKTUR</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#10B981", marginBottom: 8 }}>✓ Stärken</div>
                  {["Emotionale Staffelung statt Feature-Listen", "Keine sichtbaren Minuten — kein Taxi-Meter-Gefühl", "Top-ups ergänzen ohne Plan zu entwerten", "Partner fühlt sich Premium an, nicht nur 'mehr'", "72% DB-Marge über alle Szenarien stabil", "Upgrade-Logik: Bindung verkauft, nicht Volumen"].map((s, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#D1D5DB", padding: "4px 0", borderBottom: "1px solid #2A2D3722" }}>{s}</div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#F59E0B", marginBottom: 8 }}>⚠ Risiken & Watchpoints</div>
                  {["Partner darf nicht zu 'unlimited voice' werden", "Friend muss mehr Wert statt mehr Minuten bieten", "Free darf echte Nutzung nicht subventionieren", "Top-ups zu fair → Upgrades kannibalisiert", "Tier-Wechsel muss UX-seitig reibungslos sein", "Stripe-Gebühren bei kleinen Top-ups spürbar (~8%)"].map((s, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#D1D5DB", padding: "4px 0", borderBottom: "1px solid #2A2D3722" }}>{s}</div>
                  ))}
                </div>
              </div>
            </div>
            {/* Top-ups */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>TOP-UP ECONOMICS</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {[{ amount: 5, min: 5, stripe: 0.33 }, { amount: 10, min: 10, stripe: 0.40 }, { amount: 20, min: 20, stripe: 0.55 }].map((t, i) => (
                  <div key={i} style={{ background: "#0F1117", borderRadius: 10, padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#F9FAFB" }}>€{t.amount}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", margin: "4px 0" }}>~{t.min} Min Voice</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Stripe: €{t.stripe.toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Voice: €{(t.min * 0.06).toFixed(2)}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#10B981", marginTop: 6 }}>Marge: {(((t.amount - t.stripe - t.min * 0.06) / t.amount) * 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* ===== FINANCE TAB ===== */}
        {activeTab === "finance" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* All 3 scenarios compared */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>SZENARIO-VERGLEICH — UMSATZ</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 16, height: 200, padding: "0 8px" }}>
                {[0, 1, 2, 3, 4].map(yi => {
                  const maxRev = SCENARIOS.strong.years[4].revenue;
                  return (
                    <div key={yi} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <div style={{ display: "flex", gap: 3, alignItems: "flex-end", width: "100%", justifyContent: "center", height: 170 }}>
                        {Object.entries(SCENARIOS).map(([k, v]) => {
                          const h = (v.years[yi].revenue / maxRev) * 160;
                          return <div key={k} style={{ width: 18, height: Math.max(2, h), background: v.color, borderRadius: "4px 4px 1px 1px", opacity: 0.85 }} />;
                        })}
                      </div>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>J{yi + 1}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 12 }}>
                {Object.entries(SCENARIOS).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9CA3AF" }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: v.color }} />
                    {v.label}
                  </div>
                ))}
              </div>
            </div>
            {/* Key milestones */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {[
                { label: "Break-Even", scenarios: [{ s: "Vorsichtig", v: "~J1 (knapp)" }, { s: "Realistisch", v: "J1 (solide)" }, { s: "Stark", v: "J1 (stark)" }] },
                { label: "€100k Gewinn/Jahr", scenarios: [{ s: "Vorsichtig", v: "~J4" }, { s: "Realistisch", v: "~J2" }, { s: "Stark", v: "J1" }] },
                { label: "€1M+ Umsatz/Jahr", scenarios: [{ s: "Vorsichtig", v: "nie (in 5J)" }, { s: "Realistisch", v: "~J5" }, { s: "Stark", v: "~J3" }] },
              ].map((m, i) => (
                <div key={i} style={{ background: "#1A1D27", borderRadius: 12, padding: 16, border: "1px solid #2A2D37" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#A855F7", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</div>
                  {m.scenarios.map((s, j) => (
                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", color: "#D1D5DB" }}>
                      <span style={{ color: "#9CA3AF" }}>{s.s}:</span>
                      <span style={{ fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {/* Mix Impact */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>TIER-MIX IMPACT AUF PROFITABILITÄT</div>
              <div style={{ fontSize: 13, color: "#D1D5DB", lineHeight: 1.7 }}>
                Die zentrale Erkenntnis: <strong style={{ color: "#F9FAFB" }}>Nicht der Einstiegsplan macht das Geschäft attraktiv — der Mix macht es.</strong> Ein Shift von 5% Partner-Anteil auf 18% erhöht den ARPU von €21.95 auf €31.16 (+42%) bei nahezu identischer Marge. Das bedeutet: Jede UX-Verbesserung, die Nutzer tiefer bindet, ist direkte Margensteigerung. Friend ist der wichtigste Margenplan — nicht zu billig, nicht zu feature-arm. Partner muss sich premium anfühlen, nicht wie ein großer Verbrauchstarif.
              </div>
            </div>
            {/* Cost structure */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>KOSTENSTRUKTUR</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#D1D5DB", marginBottom: 8 }}>Variable Kosten (pro Minute)</div>
                  {[{ l: "OpenAI Realtime Audio", v: "~€0.05" }, { l: "Transcription (gpt-4o-mini)", v: "~€0.005" }, { l: "Memory/Summary Post-Processing", v: "~€0.005" }, { l: "Gesamt pro Minute", v: "~€0.06", bold: true }].map((c, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #2A2D3744", color: c.bold ? "#F9FAFB" : "#9CA3AF", fontWeight: c.bold ? 700 : 400 }}>
                      <span>{c.l}</span><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{c.v}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#D1D5DB", marginBottom: 8 }}>Fixkosten (monatlich, lean)</div>
                  {[{ l: "Vercel Hosting", v: "~€20" }, { l: "Supabase", v: "~€25" }, { l: "Domain + SSL", v: "~€5" }, { l: "Tools / Analytics", v: "~€50" }, { l: "Marketing (skaliert)", v: "variabel" }, { l: "Gesamt J1", v: "~€1.800–2.200/mo", bold: true }].map((c, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #2A2D3744", color: c.bold ? "#F9FAFB" : "#9CA3AF", fontWeight: c.bold ? 700 : 400 }}>
                      <span>{c.l}</span><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{c.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* ===== ARCHITECTURE TAB ===== */}
        {activeTab === "architecture" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* 4-Layer Architecture */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>SOPHIE 4-LAYER ARCHITEKTUR</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ARCH_LAYERS.map((l, i) => (
                  <div key={i} onClick={() => setExpandedLayer(expandedLayer === i ? null : i)} style={{ cursor: "pointer", background: expandedLayer === i ? `${l.color}15` : "#0F1117", borderRadius: 10, padding: "14px 16px", border: `1px solid ${expandedLayer === i ? l.color : "#2A2D37"}`, transition: "all 0.3s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: `${l.color}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: l.color }}>{i + 1}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#F9FAFB" }}>{l.name}</div>
                        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{l.desc}</div>
                      </div>
                      <span style={{ color: "#6B7280", fontSize: 12 }}>{expandedLayer === i ? "▲" : "▼"}</span>
                    </div>
                    {expandedLayer === i && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${l.color}30`, fontSize: 12, color: "#D1D5DB", lineHeight: 1.6 }}>{l.details}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* Tech Stack */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>TECH STACK — KOSTENOPTIMIERT</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {[
                  { cat: "Frontend", items: ["Vanilla HTML/JS (kein Framework)", "Vercel Hosting", "PWA-fähig"], verdict: "Lean & schnell", color: "#3B82F6" },
                  { cat: "Backend / API", items: ["Vercel Serverless Functions", "Node.js / Stripe SDK", "OpenAI Realtime API"], verdict: "Pay-per-use, keine Server", color: "#10B981" },
                  { cat: "Daten / Auth", items: ["Supabase (Postgres + Auth)", "RLS Policies", "Magic Link Auth"], verdict: "Kostenlos bis ~50k MAU", color: "#A855F7" },
                ].map((s, i) => (
                  <div key={i} style={{ background: "#0F1117", borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: s.color, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.cat}</div>
                    {s.items.map((it, j) => <div key={j} style={{ fontSize: 12, color: "#D1D5DB", padding: "3px 0" }}>• {it}</div>)}
                    <div style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: "#9CA3AF", borderTop: "1px solid #2A2D37", paddingTop: 8 }}>{s.verdict}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Architecture Assessment */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 12 }}>ARCHITEKTUR-BEWERTUNG</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#10B981", marginBottom: 8 }}>✓ Stärken der aktuellen Architektur</div>
                  {[
                    "Serverless = keine Fixkosten für Infrastruktur",
                    "Supabase RLS = Security auf Datenbankebene",
                    "Session-Lock verhindert Doppel-Sessions",
                    "Daily Free Budget Cap schützt vor Missbrauch",
                    "Prompt Composer: Core + Overlay + Memory = kompakt",
                    "Conversation Data Model sauber normalisiert",
                  ].map((s, i) => <div key={i} style={{ fontSize: 12, color: "#D1D5DB", padding: "4px 0" }}>{s}</div>)}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#F59E0B", marginBottom: 8 }}>⚠ Anpassungen für 4-Tier-Modell nötig</div>
                  {[
                    "Plan-Logik: starter/plus → free/assistant/friend/partner",
                    "includedSecondsForPlan() erweitern",
                    "Relationship-Layer als Tier-abhängige Config",
                    "Behavior Sliders als Runtime-Parameter",
                    "Memory Scope je Tier in Prompt Composer",
                    "Stripe: 3 Subscription-Preise + 3 Top-ups",
                  ].map((s, i) => <div key={i} style={{ fontSize: 12, color: "#D1D5DB", padding: "4px 0" }}>{s}</div>)}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* ===== PROJECT TAB ===== */}
        {activeTab === "project" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 13, color: "#9CA3AF", background: "#1A1D27", borderRadius: 12, padding: 16, border: "1px solid #2A2D37" }}>
              <strong style={{ color: "#F9FAFB" }}>Umsetzung mit Claude (Max Plan)</strong> — Jeder Sprint ist als eigenständiges Arbeitspaket konzipiert. Abhängigkeiten sind strikt sequenziell. Zeitrahmen: ~16 Wochen bis Go-to-Market.
            </div>
            {/* Gantt-like Sprint View */}
            <div style={{ background: "#1A1D27", borderRadius: 12, padding: 20, border: "1px solid #2A2D37" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginBottom: 16 }}>SPRINT-ÜBERSICHT — 16 WOCHEN BIS MARKTREIFE</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {/* Week headers */}
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, marginBottom: 8 }}>
                  <div />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 1 }}>
                    {Array.from({ length: 16 }, (_, i) => (
                      <div key={i} style={{ fontSize: 9, color: "#4B5563", textAlign: "center" }}>W{i + 1}</div>
                    ))}
                  </div>
                </div>
                {SPRINTS.map((sp, i) => {
                  const startW = parseInt(sp.weeks.split("–")[0].replace("W", "")) - 1;
                  const endW = parseInt(sp.weeks.split("–")[1].replace("W", ""));
                  return (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, marginBottom: 4, cursor: "pointer" }} onClick={() => setExpandedSprint(expandedSprint === i ? null : i)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: sp.color, background: `${sp.color}20`, padding: "2px 6px", borderRadius: 4 }}>{sp.prio}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#D1D5DB" }}>{sp.name}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 1, alignItems: "center" }}>
                        {Array.from({ length: 16 }, (_, wi) => (
                          <div key={wi} style={{
                            height: 24,
                            background: wi >= startW && wi < endW ? sp.color : "#1F2233",
                            borderRadius: wi === startW ? "4px 0 0 4px" : wi === endW - 1 ? "0 4px 4px 0" : 0,
                            opacity: wi >= startW && wi < endW ? 0.8 : 0.3
                          }} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Current position marker */}
              <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 8 }}>▎ Heute: Ende W3 — Sprint 1 Deadline</div>
            </div>
            {/* Sprint Details */}
            {SPRINTS.map((sp, i) => (
              <div key={i} onClick={() => setExpandedSprint(expandedSprint === i ? null : i)} style={{
                background: "#1A1D27", borderRadius: 12, padding: 16, border: expandedSprint === i ? `2px solid ${sp.color}` : "1px solid #2A2D37",
                cursor: "pointer", transition: "all 0.2s"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: `${sp.color}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: sp.color }}>{sp.id}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#F9FAFB" }}>Sprint {sp.id}: {sp.name}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: sp.color, background: `${sp.color}20`, padding: "2px 8px", borderRadius: 10 }}>{sp.prio}</span>
                      {sp.progress > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF" }}>{sp.progress}%</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>{sp.weeks} · Abhängigkeit: {sp.deps}</div>
                  </div>
                  <span style={{ color: "#6B7280", fontSize: 12 }}>{expandedSprint === i ? "▲" : "▼"}</span>
                </div>
                {sp.progress > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <ProgressBar progress={sp.progress} color={sp.color} />
                  </div>
                )}
                {expandedSprint === i && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid #2A2D37` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#9CA3AF", marginBottom: 8 }}>ARBEITSPAKETE</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {sp.packages.map((p, j) => (
                        <div key={j} style={{ fontSize: 12, color: "#D1D5DB", padding: "4px 8px", background: "#0F111788", borderRadius: 6 }}>→ {p}</div>
                      ))}
                    </div>
                    {sp.notes && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#6B7280", fontStyle: "italic" }}>{sp.notes}</div>
                    )}
                    <div style={{ marginTop: 10, fontSize: 11, color: sp.doneReached ? "#10B981" : "#F59E0B" }}>
                      <strong>Done-Kriterium:</strong> {sp.done} — {sp.doneReached ? "✓ Erreicht" : "Noch nicht erreicht"}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {/* ===== WHY TAB ===== */}
        {activeTab === "why" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Why customers love it */}
            <div style={{ background: "linear-gradient(135deg, #1A1D27, #1E1530)", borderRadius: 14, padding: 24, border: "1px solid #A855F740" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#A855F7", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Warum Kunden es lieben werden</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[
                  { title: "Sprechen statt Tippen", desc: "Voice-first fühlt sich natürlicher, schneller und intimer an als jeder Chatbot. Die Hemmschwelle sinkt, die Gesprächstiefe steigt." },
                  { title: "Eine Person, nicht ein Tool", desc: "Sophie hat einen stabilen Charakter — keine Modi-Auswahl, kein Prompt-Engineering. Man redet einfach." },
                  { title: "Kontinuität erzeugt Bindung", desc: "Sophie erinnert sich. Nicht creepy, sondern wie eine Vertraute: 'Letzte Woche hast du doch gesagt...' Das gibt es sonst nirgends." },
                  { title: "Klarheit nach jedem Gespräch", desc: "Session Insights, Key Takeaways, Action Plans. Man geht mit mehr raus als man reingegangen ist." },
                  { title: "Kein Urteil, kein Zeitdruck", desc: "Kein Therapeut mit Stundentakt. Keine Freundin, die müde ist. Sophie ist immer da, immer gleich aufmerksam." },
                  { title: "Premium ≠ mehr Features, sondern mehr Tiefe", desc: "Upgrade heißt: Sophie kennt dich besser, reagiert feiner, ist proaktiver. Das fühlt sich real an." },
                ].map((c, i) => (
                  <div key={i} style={{ background: "#0F111766", borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#F9FAFB", marginBottom: 4 }}>{c.title}</div>
                    <div style={{ fontSize: 12, color: "#9CA3AF", lineHeight: 1.5 }}>{c.desc}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Why it makes money */}
            <div style={{ background: "linear-gradient(135deg, #1A1D27, #0F2218)", borderRadius: 14, padding: 24, border: "1px solid #10B98140" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#10B981", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Warum wir damit Geld verdienen</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[
                  { metric: "72%", label: "Deckungsbeitragsmarge", sub: "über alle Szenarien stabil" },
                  { metric: "€25+", label: "ARPU / Monat", sub: "steigt mit Tier-Mix" },
                  { metric: "€0", label: "Server-Fixkosten", sub: "Serverless = Pay-per-Use" },
                  { metric: "~90%", label: "Top-up Marge (€20)", sub: "nach Stripe + Voice" },
                  { metric: "4:1", label: "Revenue/Fix Ratio J3", sub: "sehr gesunde Struktur" },
                  { metric: "∞", label: "Emotional Lock-in", sub: "kein Feature-Vergleich möglich" },
                ].map((m, i) => (
                  <div key={i} style={{ textAlign: "center", padding: 12 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#10B981" }}>{m.metric}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#F9FAFB", marginTop: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>{m.sub}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Why it's future-proof */}
            <div style={{ background: "linear-gradient(135deg, #1A1D27, #1A1830)", borderRadius: 14, padding: 24, border: "1px solid #6366F140" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6366F1", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Warum es ein Zukunftsmodell ist</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {[
                  { title: "AI Voice wird billiger — die Marge steigt", desc: "OpenAI senkt Realtime-Preise kontinuierlich. Bei gleichem Pricing steigt die Marge automatisch. Prompt Caching senkt Input-Kosten zusätzlich." },
                  { title: "Relationship AI ist die nächste Kategorie", desc: "Der Markt für AI-Companions wächst explosiv. Sophie positioniert sich als intelligente, reflektierte Variante — nicht als Ersatzpartner, sondern als Denkpartner." },
                  { title: "Voice-first = natürliches Moat", desc: "Text-Chatbots sind austauschbar. Eine Stimme, die sich merkt und entwickelt, ist es nicht. Die Switching-Kosten sind emotional, nicht technisch." },
                  { title: "Subscription + Emotional Lock-in = Retention", desc: "Die stärkste Retention im SaaS ist nicht Feature-basiert — sie ist beziehungsbasiert. Sophie monetarisiert genau das: wachsende Vertrautheit." },
                  { title: "Skalierbar ohne Teamaufbau", desc: "Serverless + Supabase + OpenAI = keine Ops-Kosten. Ein Solopreneur oder kleines Team kann Tausende User bedienen." },
                ].map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 14, padding: "10px 0", borderBottom: i < 4 ? "1px solid #2A2D37" : "none" }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "#6366F125", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#6366F1", flexShrink: 0 }}>{i + 1}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#F9FAFB" }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "#9CA3AF", lineHeight: 1.5, marginTop: 2 }}>{c.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Final Verdict */}
            <div style={{ background: "#1A1D27", borderRadius: 14, padding: 24, border: "1px solid #2A2D37", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#F9FAFB", marginBottom: 12 }}>Ehrliches Gesamturteil</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 16 }}>
                <div style={{ padding: 12, background: "#F59E0B15", borderRadius: 10, border: "1px solid #F59E0B30" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>Jahr 1</div>
                  <div style={{ fontSize: 12, color: "#D1D5DB", marginTop: 4 }}>Fragil, aber tragfähig</div>
                </div>
                <div style={{ padding: 12, background: "#3B82F615", borderRadius: 10, border: "1px solid #3B82F630" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#3B82F6" }}>Jahr 3</div>
                  <div style={{ fontSize: 12, color: "#D1D5DB", marginTop: 4 }}>Gutes Geschäft</div>
                </div>
                <div style={{ padding: 12, background: "#10B98115", borderRadius: 10, border: "1px solid #10B98130" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#10B981" }}>Jahr 5</div>
                  <div style={{ fontSize: 12, color: "#D1D5DB", marginTop: 4 }}>Sehr attraktiv</div>
                </div>
              </div>
              <div style={{ fontSize: 14, color: "#A855F7", fontWeight: 600, fontStyle: "italic" }}>
                Die wichtigste Zahl ist nicht Umsatz. Die wichtigste Zahl ist: Wie viele zahlende Nutzer werden mit der Zeit profitabler?
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
