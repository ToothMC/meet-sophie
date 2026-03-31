import { useState } from "react";
const SCENARIOS = {
  conservative: { label: "Vorsichtig", color: "#6B7280", mix: { starter: 70, plus: 22, pro: 8 }, topupRate: 18, topupAvg: 10, arpu: 16.85, contribution: 12.15, margin: 72.1, years: [{ y: 1, users: 120, revenue: 24264, cb: 17494, fix: 21600, profit: -4106 },{ y: 2, users: 300, revenue: 60660, cb: 43716, fix: 36000, profit: 7716 },{ y: 3, users: 500, revenue: 101100, cb: 72893, fix: 54000, profit: 18893 },{ y: 4, users: 900, revenue: 181980, cb: 131207, fix: 84000, profit: 47207 },{ y: 5, users: 1400, revenue: 283080, cb: 204060, fix: 120000, profit: 83060 }] },
  realistic: { label: "Realistisch", color: "#3B82F6", mix: { starter: 60, plus: 28, pro: 12 }, topupRate: 22, topupAvg: 10, arpu: 19.95, contribution: 14.36, margin: 72.0, years: [{ y: 1, users: 250, revenue: 59850, cb: 43092, fix: 26400, profit: 16692 },{ y: 2, users: 700, revenue: 167580, cb: 120658, fix: 48000, profit: 72658 },{ y: 3, users: 1400, revenue: 335160, cb: 241315, fix: 78000, profit: 163315 },{ y: 4, users: 2800, revenue: 670320, cb: 482630, fix: 144000, profit: 338630 },{ y: 5, users: 4200, revenue: 1005480, cb: 723946, fix: 216000, profit: 509946 }] },
  strong: { label: "Stark", color: "#10B981", mix: { starter: 45, plus: 35, pro: 20 }, topupRate: 28, topupAvg: 12, arpu: 24.10, contribution: 17.35, margin: 72.0, years: [{ y: 1, users: 500, revenue: 144600, cb: 104112, fix: 36000, profit: 68112 },{ y: 2, users: 1500, revenue: 433800, cb: 312336, fix: 72000, profit: 261336 },{ y: 3, users: 3000, revenue: 867600, cb: 624672, fix: 120000, profit: 624672 },{ y: 4, users: 5500, revenue: 1590600, cb: 1145232, fix: 228000, profit: 1145232 },{ y: 5, users: 9000, revenue: 2602800, cb: 1874016, fix: 360000, profit: 2242016 }] }
};
const MODES = [
  { name: "Explorer", icon: "✦", color: "#3f8cff", type: "auto", desc: "Ideen & Kreativität", detail: "Sophie expandiert Gedanken, verbindet unerwartete Winkel, öffnet Möglichkeitsräume." },
  { name: "Reflect", icon: "◎", color: "#a78bfa", type: "auto", desc: "Erfahrungen & Emotionen", detail: "Sophie spiegelt Beobachtungen, hilft beim Entpacken von Gedanken und Bedeutungen." },
  { name: "Decide", icon: "◈", color: "#f5c842", type: "auto", desc: "Entscheidungen & Klarheit", detail: "Sophie untersucht Trade-offs, klärt Prioritäten, testet Annahmen. Ruhig und scharf." },
  { name: "Relax", icon: "○", color: "#34d399", type: "auto", desc: "Wenn der User Pause braucht", detail: "Sophie wird menschlicher, lockerer, weniger Coach — Präsenz statt Druck." },
  { name: "Brainstorm", icon: "✦", color: "#f5c842", type: "session", desc: "Moderator + Sparring", detail: "Phase 1: Sammeln. Phase 2: Clustern. Phase 3: Challengen + eigene Ideen. Strukturierte Outputs erlaubt." },
  { name: "Meeting", icon: "◉", color: "#34c47a", type: "session", desc: "Zuhören & Protokoll", detail: "Live: Sophie hört zu, ist stumm, merkt Key Points. Post: Transkript → Entscheidungen, Action Items, offene Fragen." },
  { name: "Sales Pitch", icon: "▲", color: "#ff5252", type: "session", desc: "Training & Scoring", detail: "4 Phasen: Pitch → Einwände (Investor/Kunde/Manager/Kritischer Freund) → Score (X/50) → Retry. Brutal konkret." },
];
const TIERS = [
  { name: "Free", price: "€0", priceNum: 0, credits: 50, creditsLabel: "50 Credits (einmalig)", color: "#94A3B8", aiCost: 0, cb: 0, desc: "Kennenlernen", features: ["Chat + Voice (limitiert)", "Auto-Modes: Explorer, Reflect, Decide", "Kein Gedächtnis zwischen Sessions", "50 Credits zum Testen"] },
  { name: "Starter", price: "€9.90", priceNum: 9.90, credits: 500, creditsLabel: "500 Credits/Monat", color: "#6366F1", aiCost: 2.75, cb: 7.15, desc: "Klarheit & Nutzen", features: ["Alle Auto-Modes inkl. Guidance Layer", "Session-Modes: Brainstorm, Meeting, Sales Pitch", "Gedächtnis: 1 Session", "Session Summaries & Insights", "500 Credits/Monat"] },
  { name: "Plus", price: "€19.90", priceNum: 19.90, credits: 1500, creditsLabel: "1.500 Credits/Monat", color: "#8B5CF6", aiCost: 5.50, cb: 14.40, desc: "Persönlich & Kontinuierlich", features: ["Alles aus Starter", "Relax-Mode (Best Friend Persönlichkeit)", "Gedächtnis: 3 Sessions", "Tiefes Kontextverständnis", "1.500 Credits/Monat"] },
  { name: "Pro", price: "€39.90", priceNum: 39.90, credits: 5000, creditsLabel: "5.000 Credits/Monat", color: "#A855F7", aiCost: 11.00, cb: 28.90, desc: "Tiefste Bindung", features: ["Alles aus Plus", "Gedächtnis: 5 Sessions + Relationship-Daten", "Behavior Sliders (adaptiv)", "Priority Access + Early Features", "5.000 Credits/Monat", "Custom Reports"] },
];
const AI_PROVIDERS = [
  { name: "OpenAI", models: ["gpt-4o", "gpt-4o-mini", "gpt-4o-realtime"], color: "#10B981", role: "Voice (Realtime) + Chat Fallback", status: "live" },
  { name: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"], color: "#A855F7", role: "Insights, Reports, Analyse", status: "live" },
  { name: "Google", models: ["gemini-2.5-flash-lite", "gemini-2.5-flash"], color: "#3B82F6", role: "Budget-Chat, Fallback", status: "live" },
  { name: "Mistral", models: ["mistral-small", "mistral-large"], color: "#F59E0B", role: "EU-Compliance Fallback", status: "live" },
];
const SPRINT_STATUS = { overall: 95, packages: [
  { name: "Voice-Hauptflow stabilisieren", progress: 98, status: "Fertig", statusColor: "#10B981", details: "OpenAI Realtime voll integriert. Retry (3 Attempts + Backoff), VAD, Session-Lock, Soft-End-Warning. Mobile Safari stabil." },
  { name: "Auth / Magic Link sauber", progress: 100, status: "Fertig", statusColor: "#10B981", details: "PKCE Callback, Bearer-Token in allen Endpoints, Login + Callback Pages komplett." },
  { name: "Realtime-Session-Fehler beseitigen", progress: 95, status: "Fertig", statusColor: "#10B981", details: "acquire_realtime_lock() mit TTL, 429/402 Error-Codes, Daily Free Cap, Retry-Logik, Session-Timeout UX." },
  { name: "Session-Ende + Insights", progress: 100, status: "Fertig", statusColor: "#10B981", details: "Backend: structured JSON via Claude API → conversation_outputs. Frontend: Panel mit Summary/Insights/Next Steps + Transcript." },
  { name: "Memory Chat↔Voice konsistent", progress: 95, status: "Fertig", statusColor: "#10B981", details: "sophie-core.js implementiert (4-Layer modular, 7 Modi, ~700–1.300 Tokens). x-sophie-handover, shared user_profile/user_relationship fertig." },
  { name: "Multi-AI Router", progress: 90, status: "Fast fertig", statusColor: "#22C55E", details: "7-Dimensions-Klassifikation, 4 Provider, Fallback-Chains, Budget-Degradation, Health-System. Offen: Fine-tuning Routing-Regeln." },
  { name: "Sales Pitch Mode", progress: 95, status: "Fertig", statusColor: "#10B981", details: "4 Phasen: Pitch → Einwände → Score (X/50) → Retry. Scorecard-System komplett. Report-Generierung via Claude." },
  { name: "Meeting Mode", progress: 90, status: "Fast fertig", statusColor: "#22C55E", details: "Kontext-Upload, Live-Notizen, strukturiertes Summary (Entscheidungen, Action Items, offene Fragen). Offen: Paywall-Enforcement." },
], nextSteps: [
  { prio: "Kritisch", task: "Credits-System implementieren", desc: "Sekunden → Credits umbauen. Neue Stripe Products (3 Subs + 3 Top-ups). DB-Migration.", status: "Sprint 2" },
  { prio: "Kritisch", task: "4-Tier Stripe Migration", desc: "starter/plus → free/starter/plus/pro mit Credits. Bestehende User migrieren.", status: "Sprint 2" },
  { prio: "Hoch", task: "Meeting Paywall fixen", desc: "Meeting-Mode kann ohne Bezahlung gestartet werden.", status: "Sprint 2" },
  { prio: "Hoch", task: "Fremden Tester durchschicken", desc: "Done-Kriterium Sprint 1. End-to-End ohne Hilfe.", status: "Offen" },
  { prio: "Mittel", task: "Echtzeit-Tools (Function Calling)", desc: "Wetter, News, Börsenkurse via Tool Use. GPT + Claude native.", status: "Sprint 3" },
], codebaseStats: { apiEndpoints: 14, dbTables: "25+", currentBranch: "main", stripeModel: "2-Tier live → 4-Tier + Credits geplant", aiProviders: 4 } };
const WEBAPP = { must: [
  { id: 1, title: "Chat + Voice = eine Sophie", desc: "Kein Bruch. Gleiche Persona, gleicher Kontext, gleiche Memory. Wenn der User im Chat seinen Namen sagt, darf Voice nicht erneut fragen.", icon: "🧠", status: "mostly_done" },
  { id: 2, title: "Mobile UX kompromisslos", desc: "iPhone als Hauptreferenz. Große Touch-Zonen, Safe Areas, kein springendes Layout. Voice-Button dominiert. Keyboard darf nichts kaputtmachen.", icon: "📱", status: "mostly_done" },
  { id: 3, title: "Reentry brutal sauber", desc: "Nach Magic Link kein Chaos. Rückkehr zu /talk stabil. Offene Session erkennbar. Keine Redirect-Ketten, keine UI-Sackgassen.", icon: "🔄", status: "mostly_done" },
  { id: 4, title: "Voice-Start glasklar & robust", desc: "Eindeutige Zustände: bereit / hört zu / verbindet / spricht / beendet. Kein Hängenbleiben. Visuelles Feedback beim Listening.", icon: "🎙️", status: "done" },
  { id: 5, title: "Trial & Paywall natürlich", desc: "Session-Ende weich auffangen. Insights zeigen. Upgrade als logische Fortsetzung, nicht als Blockade. Kein Stress durch Timer.", icon: "💳", status: "partial" },
  { id: 6, title: "Auth zerstört nie die Illusion", desc: "Login erst wenn sinnvoll. Nach Auth direkt zurück in die Experience. Kein Gefühl von 'raus aus Sophie, rein in Technik'.", icon: "🔐", status: "done" },
  { id: 7, title: "Tracking als Steuerzentrale", desc: "landing_view → start_voice → auth → paywall → checkout → return_visit. Nach Sprache, Device, Source, Trial vs Paid.", icon: "📊", status: "partial" },
  { id: 8, title: "Installierbarkeit sauber", desc: "Web App Manifest, Icons, Splash. Sophie als Home Screen Icon = psychologischer Shift von 'Seite' zu 'Begleiter'.", icon: "⬇️", status: "todo" },
  { id: 9, title: "Performance: gefühlt sofort", desc: "Landing und /talk schnell. Keine schweren Assets im kritischen Pfad. State nicht verlieren. Ladezustände elegant.", icon: "⚡", status: "mostly_done" },
  { id: 10, title: "Ein klarer Core-Use-Case", desc: "Denken klären, Entscheidungen sortieren, reflektieren. Nicht 7 Modi gleichzeitig. Fokus schlägt Feature-Breite.", icon: "🎯", status: "done" },
], should: [
  { id: 1, title: "Install-Hinweis intelligent", desc: "Nicht sofort. Erst nach positiver Erfahrung. 'Keep Sophie close' statt technischer Text." },
  { id: 2, title: "Return-to-Sophie Moment", desc: "Wiederkehr wie Fortsetzung, nicht wie Neustart. Subtiler personalisierter Wiedereinstieg." },
  { id: 3, title: "Session-Ende als Produktmoment", desc: "Summary, Key Insights, Action Points. Klarer nächster Schritt. 'Weiter im Chat' oder 'später fortsetzen'." },
  { id: 4, title: "Chat ↔ Voice enger verzahnt", desc: "Wechsel ohne mentalen Neustart. Chat bereitet Voice vor. Voice setzt Chat fort." },
  { id: 5, title: "Klare UI-States", desc: "idle / ready / connecting / listening / speaking / reconnecting / ended / paywall — jeder State klar." },
  { id: 6, title: "Sprachumschaltung 100%", desc: "Landing, Chat, Voice, Buttons, Paywall, Summary — überall dieselbe Sprache." },
  { id: 7, title: "Vertrauensschicht", desc: "Datenschutz UX-seitig integriert. Vertrauen über Stabilität und Klarheit." },
  { id: 8, title: "Funnel je Quelle", desc: "Organisch vs. Paid vs. Social — je Quelle andere Erwartung und Einstieg." },
  { id: 9, title: "Payment-Varianten testbar", desc: "Monatsabo, Top-up, Einstiegsangebot. Pricing wird nicht auf Anhieb perfekt." },
  { id: 10, title: "App-Gefühl visuell", desc: "Icon, Motion, Übergänge. Ruhig, hochwertig, nicht techy." },
], later: [
  { title: "Native App", reason: "Erst wenn Retention da, Funnel stabil, Core klar." },
  { title: "Push-Strategie", reason: "Companion-Push kann schnell nerven oder creepy wirken." },
  { title: "Fortgeschrittene Personalisierung", reason: "Adaptive Opener, feinere Rückbezüge. Erst wenn Basis stabil." },
  { title: "Community / Sharing / viral", reason: "Aktuell nicht der Engpass." },
  { title: "Aufwendige visuelle Spielereien", reason: "Nur wenn Performance und Fokus nicht leiden." },
  { title: "Echtzeit-Tools", reason: "Function Calling für Wetter, News, Börsenkurse. Sprint 3+ Priorität." },
  { title: "Datenimport-System", reason: "ChatGPT/Claude/Gemini-Konversationen importieren. Infrastruktur gebaut, UX folgt." },
], blocks: [
  { name: "Core Experience", color: "#EF4444", items: ["Chat/Voice/Memory identisch", "Reentry stabil", "Voice-Start robust", "Mobile States sauber"] },
  { name: "Conversion", color: "#F97316", items: ["Trial-Ende natürlich", "Upgrade-Fluss sauber", "Auth ohne Bruch", "Paywall als Fortsetzung"] },
  { name: "App-Feeling", color: "#A855F7", items: ["Installierbarkeit", "Return-Momente", "App-artiges Produktgefühl", "Kein Browser-Gefühl"] },
  { name: "Steuerbarkeit", color: "#3B82F6", items: ["Event-Tracking komplett", "Funnel-Sicht", "Pricing-Tests", "Retention-Messung"] },
] };
const SPRINTS = [
  { id: 1, name: "Produktkern", weeks: "W1–W3", prio: "P0", color: "#EF4444", progress: 95, packages: SPRINT_STATUS.packages.filter(p => ["Voice","Auth","Realtime","Session-Ende","Memory"].some(k => p.name.includes(k))).map(p => `${p.name} (${p.progress}%)`), deps: "—", done: "Fremder Tester kommt ohne Hilfe durch", doneReached: false, notes: "Backend + Frontend stabil. Voice, Auth, Insights, Memory fertig. Multi-AI Router vorausgezogen. Blocker: externer Nutzertest steht noch aus." },
  { id: 2, name: "Monetarisierung", weeks: "W4–W6", prio: "P0", color: "#F97316", progress: 40, packages: ["Credits-System: Sekunden → Credits umbauen", "4-Tier Migration: free/starter/plus/pro", "Stripe Checkout (3 Subs + 3 Top-ups)", "Auto-Recharge + Budget-Cap", "Meeting Paywall fixen", "Legal + Checkboxen"], deps: "Sprint 1", done: "User kann kaufen + nutzen ohne Support", doneReached: false, notes: "Stripe 2-Tier live. AI-Kosten-Tracking fertig. Credits-Konzept definiert. Migration ist Hauptarbeit." },
  { id: 3, name: "Conversion", weeks: "W7–W9", prio: "P1", color: "#EAB308", progress: 15, packages: ["Landing Page Pricing-Cards mit Credits", "Onboarding/Erstgespräch optimieren", "Upgrade-Momente einbauen", "Post-Session Insights stärken", "Echtzeit-Tools (Function Calling)"], deps: "Sprint 2", done: "User versteht Produkt + Nutzen sofort", doneReached: false, notes: "Landing + Pricing Page existieren. Onboarding + Upgrade-Nudges + Echtzeit-Daten fehlen." },
  { id: 4, name: "Retention", weeks: "W10–W12", prio: "P1", color: "#22C55E", progress: 15, packages: ["Relationship Layer implementieren", "Chat als Ergänzung", "History/vergangene Insights", "Behavior Sliders System", "Memory-Scope je Tier", "Datenimport UX (ChatGPT/Claude/Gemini)"], deps: "Sprint 3", done: "Plausiblen Grund wiederzukommen", doneReached: false, notes: "Memory-System (5 Tabellen) gebaut. Import-Infrastruktur existiert. Behavior Sliders + Tier-Scope + Import-UX fehlen." },
  { id: 5, name: "Wachstum", weeks: "W13–W16", prio: "P2", color: "#3B82F6", progress: 0, packages: ["Social Hooks / Sophie Says", "Content / Shorts / Ads", "Funnel-Tracking", "Conversion-Messung", "Pricing-Experimente", "Sales Pitch v3 (Datei-Upload, Folien-Tracking)"], deps: "Sprint 4", done: "Traffic → User → Zahler Pipeline steht", doneReached: false, notes: "Noch nicht gestartet." },
];
const ARCH_LAYERS = [
  { name: "Identity Layer", desc: "Unveränderliche Kernpersona", color: "#8B5CF6", details: "Warm, intelligent, aufmerksam, natürlich. Ändert sich nie. ~200 Tokens." },
  { name: "Relationship & Guidance Layer", desc: "Beziehungstiefe je Tier", color: "#A855F7", details: "Free → Starter → Plus → Pro. Steuert Nähe, Initiative, Guidance-Tiefe. Nur ab Starter-Tier geladen." },
  { name: "Mode Layer", desc: "4 Auto-Modes + 3 Session-Modes", color: "#EC4899", details: "Auto: Explorer / Reflect / Decide / Relax — Sophie wählt automatisch, signalisiert via signal_mode Tool. Session: Brainstorm / Meeting / Sales Pitch — User wählt per UI. Session-Modes ersetzen Auto-Modes komplett → spart Tokens." },
  { name: "Memory & Context", desc: "Tier-scoped Kontextgrenzen", color: "#C084FC", details: "Free: kein Memory. Starter: 1 Session. Plus: 3 Sessions. Pro: 5 Sessions + Relationship-Daten. Gesamt: ~700–1.300 Tokens statt vorher ~4.000." },
  { name: "AI Router Layer", desc: "Multi-Provider Routing + Fallback", color: "#10B981", details: "NEU: 7-Dimensions-Klassifikation (Channel, Latenz, Risiko, Kontext, Tier, Datenklasse, Verifikation). 4 Provider (OpenAI, Claude, Gemini, Mistral). Automatische Fallback-Chains. Budget-Degradation bei Kosten-Überschreitung. Provider-Health-Tracking (healthy/degraded/down)." },
];
const CREDITS_SYSTEM = {
  concept: "1 Credit ≈ €0.01 AI-Kosten intern. Transparenter als Sekunden, da verschiedene AI-Modelle unterschiedlich kosten.",
  topups: [
    { credits: 200, price: 2, label: "200 Credits" },
    { credits: 500, price: 5, label: "500 Credits" },
    { credits: 1000, price: 10, label: "1.000 Credits" },
  ],
  rules: [
    "Credits verfallen am Monatsende (Abo-Credits)",
    "Top-up Credits bleiben bis verbraucht",
    "Auto-Recharge optional: Stripe lädt nach wenn < Schwelle",
    "Budget-Cap: User definiert Max-Ausgabe/Monat",
    "Jede AI-Action loggt Credits basierend auf echten Token-Kosten",
  ],
  migration: "Phase 1: Admin Dashboard (fertig). Phase 2: Backend Sekunden → Credits + neue Stripe Products. Phase 3: User-Migration.",
};
function fmt(n) { return n >= 1e6 ? `€${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `€${(n/1e3).toFixed(0)}k` : `€${n}`; }
function BarChart({data,dataKey,color}){const max=Math.max(...data.map(d=>d[dataKey]));return(<div style={{display:"flex",alignItems:"flex-end",gap:8,height:160,padding:"0 4px"}}>{data.map((d,i)=>{const h=max>0?(d[dataKey]/max)*140:0;return(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><span style={{fontSize:10,color:"#9CA3AF",fontWeight:600}}>{fmt(d[dataKey])}</span><div style={{width:"100%",height:h,background:`linear-gradient(180deg,${color},${color}88)`,borderRadius:"6px 6px 2px 2px",minHeight:2,transition:"height 0.5s ease"}}/><span style={{fontSize:11,color:"#6B7280",fontWeight:500}}>J{d.y}</span></div>);})}</div>);}
function ProgressBar({progress,color,height=8}){return(<div style={{width:"100%",height,background:"#2A2D37",borderRadius:height/2,overflow:"hidden"}}><div style={{width:`${progress}%`,height:"100%",background:`linear-gradient(90deg,${color},${color}CC)`,borderRadius:height/2,transition:"width 0.8s ease"}}/></div>);}
function MiniStat({label,value,sub,accent}){return(<div style={{textAlign:"center",padding:"12px 8px"}}><div style={{fontSize:11,color:"#9CA3AF",fontWeight:500,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{label}</div><div style={{fontSize:22,fontWeight:700,color:accent||"#F9FAFB"}}>{value}</div>{sub&&<div style={{fontSize:11,color:"#6B7280",marginTop:2}}>{sub}</div>}</div>);}
const si=s=>s==="done"?"✓":s==="mostly_done"?"◉":s==="in_progress"?"◐":s==="partial"?"◔":"○";
const sc2=s=>s==="done"?"#10B981":s==="mostly_done"?"#22C55E":s==="in_progress"?"#F59E0B":s==="partial"?"#F97316":"#6B7280";
const sl=s=>s==="done"?"Fertig":s==="mostly_done"?"Fast fertig":s==="in_progress"?"In Arbeit":s==="partial"?"Teilweise":"Offen";
export default function SophieBusinessPlan(){
  const[activeScenario,setActiveScenario]=useState("realistic");
  const[activeTab,setActiveTab]=useState("overview");
  const[expandedSprint,setExpandedSprint]=useState(null);
  const[expandedLayer,setExpandedLayer]=useState(null);
  const[wv,setWv]=useState("must");
  const sc=SCENARIOS[activeScenario];const y5=sc.years[4];
  const tabs=[{id:"overview",label:"Übersicht"},{id:"webapp",label:"📱 Web-App"},{id:"sprint",label:"Sprint Status"},{id:"pricing",label:"Pricing"},{id:"ai",label:"🤖 AI Router"},{id:"finance",label:"Finanzen"},{id:"architecture",label:"Architektur"},{id:"project",label:"Projektplan"},{id:"why",label:"Warum Sophie?"}];
  return(
    <div style={{fontFamily:"'DM Sans','Manrope',system-ui,sans-serif",background:"#0F1117",color:"#E5E7EB",minHeight:"100vh",padding:"24px 16px"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#374151;border-radius:3px}`}</style>
      <div style={{maxWidth:960,margin:"0 auto 32px",textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:500,color:"#A855F7",letterSpacing:"0.15em",textTransform:"uppercase",marginBottom:8}}>Business Plan 2026–2031 · Update März 2026</div>
        <h1 style={{fontSize:32,fontWeight:700,color:"#F9FAFB",lineHeight:1.2,marginBottom:8}}>Meet Sophie</h1>
        <p style={{fontSize:14,color:"#9CA3AF",maxWidth:520,margin:"0 auto"}}>Voice-AI Thinking & Training Partner — 4 AI-Provider, Credits-System, 7 Modi, Multi-Provider Routing</p>
      </div>
      <div style={{maxWidth:960,margin:"0 auto 24px",display:"flex",gap:3,flexWrap:"wrap",background:"#1A1D27",borderRadius:12,padding:4}}>
        {tabs.map(t=>(<button key={t.id} onClick={()=>setActiveTab(t.id)} style={{flex:1,minWidth:72,padding:"10px 6px",borderRadius:8,border:"none",cursor:"pointer",background:activeTab===t.id?(t.id==="webapp"?"#F97316":t.id==="ai"?"#10B981":"#A855F7"):"transparent",color:activeTab===t.id?"#FFF":"#9CA3AF",fontSize:11,fontWeight:600,fontFamily:"inherit",transition:"all 0.2s"}}>{t.label}</button>))}
      </div>
      <div style={{maxWidth:960,margin:"0 auto"}}>
{/* OVERVIEW */}
{activeTab==="overview"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{display:"flex",gap:8}}>{Object.entries(SCENARIOS).map(([k,v])=>(<button key={k} onClick={()=>setActiveScenario(k)} style={{flex:1,padding:"14px 12px",borderRadius:10,border:activeScenario===k?`2px solid ${v.color}`:"2px solid #2A2D37",background:activeScenario===k?`${v.color}15`:"#1A1D27",cursor:"pointer",color:activeScenario===k?v.color:"#9CA3AF",fontSize:13,fontWeight:600,fontFamily:"inherit"}}>{v.label}</button>))}</div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>{[{l:"ARPU/Mo",v:`€${sc.arpu}`,a:sc.color},{l:"DB-Marge",v:`${sc.margin}%`,a:"#10B981"},{l:"Umsatz J5",v:fmt(y5.revenue),a:"#F59E0B"},{l:"Gewinn J5",v:fmt(y5.profit),a:"#A855F7",s:"vor Steuern"},{l:"AI Provider",v:"4",a:"#3B82F6",s:"Multi-Router"}].map((m,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,border:"1px solid #2A2D37"}}><MiniStat label={m.l} value={m.v} accent={m.a} sub={m.s}/></div>))}</div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}><div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>UMSATZ / JAHR</div><BarChart data={sc.years} dataKey="revenue" color={sc.color}/></div><div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>OPERATIVER GEWINN / JAHR</div><BarChart data={sc.years} dataKey="profit" color="#10B981"/></div></div>
  {/* Key Changes Banner */}
  <div style={{background:"linear-gradient(135deg,#1A1D27,#0F2218)",borderRadius:14,padding:20,border:"1px solid #10B98140"}}>
    <div style={{fontSize:11,fontWeight:600,color:"#10B981",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Wesentliche Änderungen seit v1</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>{[
      {t:"Credits statt Minuten",d:"1 Credit ≈ €0.01 AI-Kosten. Verschiedene Modelle = verschiedene Preise. Credits sind ehrlicher."},
      {t:"4 AI-Provider live",d:"OpenAI + Claude + Gemini + Mistral. Intelligentes Routing mit 7-Dimensions-Klassifikation + Fallback-Chains."},
      {t:"Neue Pricing-Tiers",d:"Free/Starter/Plus/Pro statt Free/Assistant/Friend/Partner. Niedrigerer Einstieg (€9.90 statt €14.90)."},
    ].map((c,i)=>(<div key={i} style={{background:"#0F111766",borderRadius:10,padding:14}}><div style={{fontSize:13,fontWeight:600,color:"#F9FAFB",marginBottom:4}}>{c.t}</div><div style={{fontSize:12,color:"#9CA3AF",lineHeight:1.5}}>{c.d}</div></div>))}</div>
  </div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37",overflowX:"auto"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>DETAILANSICHT — {sc.label.toUpperCase()}</div><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr style={{color:"#6B7280",fontSize:11,textTransform:"uppercase"}}>{["Jahr","Paid User","Umsatz","DB","Fix","Gewinn"].map((h,i)=><th key={i} style={{padding:"8px 12px",textAlign:i===0?"left":"right"}}>{h}</th>)}</tr></thead><tbody>{sc.years.map((r,i)=>(<tr key={i} style={{borderTop:"1px solid #2A2D37"}}><td style={{padding:"10px 12px",fontWeight:600}}>Jahr {r.y}</td><td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>{r.users.toLocaleString()}</td><td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:sc.color}}>{fmt(r.revenue)}</td><td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>{fmt(r.cb)}</td><td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:"#EF4444"}}>{fmt(r.fix)}</td><td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:r.profit>0?"#10B981":"#EF4444",fontWeight:600}}>{fmt(r.profit)}</td></tr>))}</tbody></table></div>
</div>)}
{/* WEB-APP RICHTLINIE */}
{activeTab==="webapp"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#2A1A10)",borderRadius:14,padding:24,border:"1px solid #F9731640"}}>
    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
      <div style={{width:48,height:48,borderRadius:12,background:"#F9731625",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>📱</div>
      <div><div style={{fontSize:18,fontWeight:700,color:"#F9FAFB"}}>Mobile Web-App Richtlinie</div><div style={{fontSize:12,color:"#F97316"}}>100% Fokus: Browserbasierte Companion-App — keine klassische Website</div></div>
    </div>
    <div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.7}}>Sophie ist kein Tool mit Chatfunktion. Sophie ist eine <strong style={{color:"#F9FAFB"}}>App-Erfahrung im Browser</strong>. Der User öffnet Sophie und ist direkt in seiner Welt — Home Screen statt Bookmark, Session-Fortsetzung statt Neustart. <strong style={{color:"#F97316"}}>Mobile ist das Hauptprodukt. Desktop ist Bonus.</strong></div>
  </div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}>
    <div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12,textTransform:"uppercase",letterSpacing:"0.05em"}}>7 Leitprinzipien</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6}}>
      {[{w:"Installierbar",c:"#A855F7",s:"Home Screen = Begleiter"},{w:"Mobil perfekt",c:"#F97316",s:"iPhone als Referenz"},{w:"Schnell",c:"#EAB308",s:"Speed = Vertrauen"},{w:"Intim",c:"#EC4899",s:"Person, nicht System"},{w:"Reibungsarm",c:"#10B981",s:"Jede Reibung kostet"},{w:"Eigenes Payment",c:"#3B82F6",s:"Kein Store-Korsett"},{w:"Messbar",c:"#8B5CF6",s:"Funnel als Steuerpult"}].map((p,i)=>(<div key={i} style={{textAlign:"center",padding:"12px 4px",background:`${p.c}10`,borderRadius:10,border:`1px solid ${p.c}25`}}><div style={{fontSize:11,fontWeight:700,color:p.c,marginBottom:4}}>{p.w}</div><div style={{fontSize:9,color:"#9CA3AF",lineHeight:1.3}}>{p.s}</div></div>))}
    </div>
  </div>
  <div style={{display:"flex",gap:6}}>
    {[{id:"must",label:"Must Have",n:10,c:"#EF4444"},{id:"should",label:"Should Have",n:10,c:"#F59E0B"},{id:"later",label:"Later",n:7,c:"#6B7280"},{id:"blocks",label:"Umsetzung",n:4,c:"#A855F7"}].map(s=>(<button key={s.id} onClick={()=>setWv(s.id)} style={{flex:1,padding:"10px 8px",borderRadius:8,border:wv===s.id?`2px solid ${s.c}`:"2px solid #2A2D37",background:wv===s.id?`${s.c}15`:"#1A1D27",cursor:"pointer",color:wv===s.id?s.c:"#9CA3AF",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>{s.label} ({s.n})</button>))}
  </div>
  {wv==="must"&&(<div style={{display:"flex",flexDirection:"column",gap:10}}>
    <div style={{fontSize:11,color:"#EF4444",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Ohne diese Punkte baut Sophie auf wackligem Fundament</div>
    {WEBAPP.must.map((item,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37",display:"flex",gap:14,alignItems:"flex-start"}}><div style={{width:40,height:40,borderRadius:10,background:"#0F1117",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{item.icon}</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><span style={{fontSize:14,fontWeight:600,color:"#F9FAFB"}}>{item.id}. {item.title}</span><span style={{fontSize:10,fontWeight:600,color:sc2(item.status),background:`${sc2(item.status)}20`,padding:"2px 8px",borderRadius:8}}>{si(item.status)} {sl(item.status)}</span></div><div style={{fontSize:12,color:"#9CA3AF",lineHeight:1.5}}>{item.desc}</div></div></div>))}
    <div style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37"}}><div style={{display:"flex",gap:16,justifyContent:"center"}}>
      {["done","mostly_done","in_progress","partial","todo"].map(s=>{const c=WEBAPP.must.filter(m=>m.status===s).length;return c>0?(<div key={s} style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><span style={{color:sc2(s),fontWeight:700}}>{si(s)}</span><span style={{color:"#9CA3AF"}}>{sl(s)}: {c}</span></div>):null;})}
    </div></div>
  </div>)}
  {wv==="should"&&(<div style={{display:"flex",flexDirection:"column",gap:10}}>
    <div style={{fontSize:11,color:"#F59E0B",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Spürbar mehr Qualität — aber nicht der erste Engpass</div>
    {WEBAPP.should.map((item,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37"}}><div style={{fontSize:13,fontWeight:600,color:"#F9FAFB",marginBottom:4}}>{item.id}. {item.title}</div><div style={{fontSize:12,color:"#9CA3AF",lineHeight:1.5}}>{item.desc}</div></div>))}
  </div>)}
  {wv==="later"&&(<div style={{display:"flex",flexDirection:"column",gap:10}}>
    <div style={{fontSize:11,color:"#6B7280",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Nett, wertvoll, aber jetzt noch nicht der Hebel</div>
    {WEBAPP.later.map((item,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:14,border:"1px solid #2A2D37",display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{fontSize:13,fontWeight:600,color:"#D1D5DB"}}>{item.title}</div><div style={{fontSize:11,color:"#6B7280",textAlign:"right",maxWidth:300}}>{item.reason}</div></div>))}
  </div>)}
  {wv==="blocks"&&(<div style={{display:"flex",flexDirection:"column",gap:16}}>
    <div style={{fontSize:11,color:"#A855F7",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Operative Reihenfolge — Block 1 zuerst</div>
    {WEBAPP.blocks.map((block,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:20,border:`1px solid ${block.color}30`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}><div style={{width:32,height:32,borderRadius:8,background:`${block.color}25`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:block.color}}>{i+1}</div><div style={{fontSize:15,fontWeight:700,color:"#F9FAFB"}}>Block {i+1}: {block.name}</div></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>{block.items.map((item,j)=>(<div key={j} style={{fontSize:12,color:"#D1D5DB",padding:"8px 12px",background:"#0F111788",borderRadius:8,borderLeft:`3px solid ${block.color}`}}>{item}</div>))}</div>
    </div>))}
    <div style={{background:"linear-gradient(135deg,#1A1D27,#1A0F0F)",borderRadius:14,padding:20,border:"1px solid #EF444440",textAlign:"center"}}>
      <div style={{fontSize:14,fontWeight:700,color:"#F9FAFB",marginBottom:8}}>Größtes Risiko</div>
      <div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.6}}>Nicht: „Wir haben noch keine native App."<br/>Sondern: <strong style={{color:"#EF4444"}}>Das Produkt wirkt in wichtigen Momenten noch wie Technik statt wie Sophie.</strong></div>
    </div>
  </div>)}
</div>)}
{/* SPRINT STATUS */}
{activeTab==="sprint"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase"}}>Sprint 1 — Produktkern (W1–W3)</div><div style={{fontSize:11,color:"#6B7280",marginTop:4}}>Done: Fremder Tester ohne Hilfe — <span style={{color:"#F59E0B"}}>Tester noch ausstehend</span></div></div><div style={{fontSize:28,fontWeight:700,color:"#10B981"}}>{SPRINT_STATUS.overall}%</div></div><ProgressBar progress={SPRINT_STATUS.overall} color="#10B981" height={10}/></div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>{[{l:"Sprint 1",v:`~${SPRINT_STATUS.overall}%`,s:"Produktkern",a:"#10B981"},{l:"AI Provider",v:SPRINT_STATUS.codebaseStats.aiProviders,s:"Multi-Router live",a:"#A855F7"},{l:"API-Endpoints",v:SPRINT_STATUS.codebaseStats.apiEndpoints,s:"Live auf Vercel",a:"#3B82F6"},{l:"DB-Tabellen",v:SPRINT_STATUS.codebaseStats.dbTables,s:"RLS aktiv",a:"#10B981"},{l:"Stripe",v:"2-Tier",s:"→ 4-Tier S2",a:"#F59E0B"}].map((m,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,border:"1px solid #2A2D37"}}><MiniStat label={m.l} value={m.v} sub={m.s} accent={m.a}/></div>))}</div>
  <div style={{display:"flex",flexDirection:"column",gap:10}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase"}}>Arbeitspakete</div>{SPRINT_STATUS.packages.map((pkg,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><div style={{fontSize:14,fontWeight:600,color:"#F9FAFB"}}>{i+1}. {pkg.name}</div><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:11,fontWeight:600,color:pkg.statusColor,background:`${pkg.statusColor}20`,padding:"3px 10px",borderRadius:10}}>{pkg.status}</span><span style={{fontSize:16,fontWeight:700,color:pkg.statusColor}}>{pkg.progress}%</span></div></div><ProgressBar progress={pkg.progress} color={pkg.statusColor}/><div style={{fontSize:12,color:"#9CA3AF",marginTop:8,lineHeight:1.5}}>{pkg.details}</div></div>))}</div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16,textTransform:"uppercase"}}>Nächste Schritte</div><div style={{display:"flex",flexDirection:"column",gap:8}}>{SPRINT_STATUS.nextSteps.map((step,i)=>{const pc=step.prio==="Kritisch"?"#EF4444":step.prio==="Hoch"?"#F59E0B":"#3B82F6";return(<div key={i} style={{display:"flex",gap:12,padding:"12px 14px",background:"#0F111788",borderRadius:10}}><span style={{fontSize:14,fontWeight:700,color:"#6B7280",minWidth:28,textAlign:"center"}}>{i+1}</span><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><span style={{fontSize:13,fontWeight:600,color:"#F9FAFB"}}>{step.task}</span><span style={{fontSize:10,fontWeight:600,color:pc,background:`${pc}20`,padding:"2px 8px",borderRadius:8}}>{step.prio}</span></div><div style={{fontSize:12,color:"#9CA3AF"}}>{step.desc}</div></div><div style={{fontSize:11,color:step.status==="Offen"?"#F59E0B":"#6B7280",fontWeight:500,whiteSpace:"nowrap"}}>{step.status}</div></div>);})}</div></div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37",fontSize:11,color:"#6B7280"}}>Stand: 31. März 2026 · Branch: <span style={{color:"#A855F7",fontFamily:"'JetBrains Mono',monospace"}}>{SPRINT_STATUS.codebaseStats.currentBranch}</span> · Stripe: {SPRINT_STATUS.codebaseStats.stripeModel}</div>
</div>)}
{/* PRICING */}
{activeTab==="pricing"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#1A1830)",borderRadius:14,padding:20,border:"1px solid #A855F740"}}>
    <div style={{fontSize:11,fontWeight:600,color:"#A855F7",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Umstellung: Minuten → Credits</div>
    <div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.7}}>{CREDITS_SYSTEM.concept}</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginTop:16}}>
      {CREDITS_SYSTEM.topups.map((t,i)=>(<div key={i} style={{background:"#0F1117",borderRadius:10,padding:16,textAlign:"center"}}>
        <div style={{fontSize:20,fontWeight:700,color:"#F9FAFB"}}>€{t.price}</div>
        <div style={{fontSize:11,color:"#6B7280",margin:"4px 0"}}>{t.label}</div>
        <div style={{fontSize:13,fontWeight:700,color:"#10B981",marginTop:6}}>Top-up</div>
      </div>))}
    </div>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>{TIERS.map((t,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:14,padding:20,border:i===3?`2px solid ${t.color}`:"1px solid #2A2D37",display:"flex",flexDirection:"column",gap:12,position:"relative",boxShadow:i===3?`0 0 30px ${t.color}20`:"none"}}>{i===3&&<div style={{position:"absolute",top:-10,right:16,background:t.color,color:"#FFF",fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:20}}>PREMIUM</div>}<div style={{fontSize:11,color:t.color,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.name}</div><div style={{fontSize:24,fontWeight:700,color:"#F9FAFB"}}>{t.price}<span style={{fontSize:12,color:"#6B7280",fontWeight:400}}>{t.priceNum>0?" /mo":""}</span></div><div style={{fontSize:12,color:"#9CA3AF"}}>{t.desc}</div><div style={{fontSize:11,fontWeight:700,color:t.color,background:`${t.color}15`,padding:"6px 10px",borderRadius:8,textAlign:"center"}}>{t.creditsLabel}</div><div style={{borderTop:"1px solid #2A2D37",paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>{t.features.map((f,j)=>(<div key={j} style={{fontSize:11,color:"#D1D5DB",display:"flex",gap:6}}><span style={{color:t.color,fontSize:14,lineHeight:1}}>✓</span><span>{f}</span></div>))}</div></div>))}</div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>UNIT ECONOMICS PRO PAID USER / MONAT</div><div style={{display:"flex",flexDirection:"column",gap:8}}>{TIERS.filter(t=>t.priceNum>0).map((t,i)=>{const pct=(t.cb/t.priceNum)*100;return(<div key={i} style={{display:"flex",alignItems:"center",gap:12}}><div style={{width:80,fontSize:12,fontWeight:600,color:t.color}}>{t.name}</div><div style={{flex:1,height:28,background:"#2A2D37",borderRadius:6,overflow:"hidden",position:"relative"}}><div style={{width:`${pct}%`,height:"100%",background:`linear-gradient(90deg,${t.color},${t.color}99)`,borderRadius:6}}/><div style={{position:"absolute",top:0,left:0,right:0,bottom:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 10px",fontSize:11,fontWeight:600}}><span>DB: €{t.cb.toFixed(2)}</span><span style={{color:"#9CA3AF"}}>AI-Kosten: €{t.aiCost.toFixed(2)}</span></div></div><div style={{width:50,fontSize:12,fontWeight:700,color:"#10B981",textAlign:"right"}}>{pct.toFixed(0)}%</div></div>);})}</div></div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>CREDITS-REGELN</div><div style={{display:"flex",flexDirection:"column",gap:6}}>{CREDITS_SYSTEM.rules.map((r,i)=>(<div key={i} style={{fontSize:12,color:"#D1D5DB",padding:"6px 12px",background:"#0F111788",borderRadius:8,borderLeft:"3px solid #A855F7"}}>→ {r}</div>))}</div><div style={{marginTop:12,fontSize:11,color:"#6B7280",fontStyle:"italic"}}>{CREDITS_SYSTEM.migration}</div></div>
</div>)}
{/* AI ROUTER */}
{activeTab==="ai"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#0F2218)",borderRadius:14,padding:24,border:"1px solid #10B98140"}}>
    <div style={{fontSize:11,fontWeight:600,color:"#10B981",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Multi-AI Router — USP</div>
    <div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.7}}>Sophie nutzt <strong style={{color:"#F9FAFB"}}>4 AI-Provider gleichzeitig</strong> und routet jede Anfrage intelligent zum optimalen Modell. Der Router klassifiziert in <strong style={{color:"#10B981"}}>7 Dimensionen</strong> und wählt automatisch Fallbacks bei Ausfällen oder Budget-Limits.</div>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
    {AI_PROVIDERS.map((p,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:14,padding:20,border:`1px solid ${p.color}30`}}>
      <div style={{fontSize:11,color:p.color,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8}}>{p.name}</div>
      <div style={{fontSize:12,color:"#F9FAFB",fontWeight:600,marginBottom:8}}>{p.role}</div>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>{p.models.map((m,j)=>(<div key={j} style={{fontSize:11,color:"#9CA3AF",fontFamily:"'JetBrains Mono',monospace"}}>• {m}</div>))}</div>
      <div style={{marginTop:10}}><span style={{fontSize:10,fontWeight:600,color:"#10B981",background:"#10B98120",padding:"2px 8px",borderRadius:8}}>LIVE</span></div>
    </div>))}
  </div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}>
    <div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>ROUTING-PIPELINE (7 SCHRITTE)</div>
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      {[
        {n:"1. Classify",d:"7 Dimensionen: Channel, Latenz, Risiko, Kontext-Länge, User-Tier, Datenklasse, Verifikation",c:"#3B82F6"},
        {n:"2. Route",d:"Regelbasierte Entscheidung → Primary + Fallback-Modell auswählen",c:"#A855F7"},
        {n:"3. Budget Check",d:"Daily-Spend prüfen. Bei Überschreitung: degradieren zu günstigerem Modell",c:"#F59E0B"},
        {n:"4. Execute",d:"Timeout-geschützter Call. Bei Fehler: automatisch Fallback-Provider",c:"#10B981"},
        {n:"5. Normalize",d:"Provider-spezifische Quirks entfernen. Einheitliches Response-Format",c:"#EC4899"},
        {n:"6. Track",d:"Kosten, Latenz, Routing-Grund loggen → ai_request_log + ai_cost_daily",c:"#6366F1"},
        {n:"7. Return",d:"Response + Metadata (Provider, Modell, Kosten, Latenz) zurückgeben",c:"#8B5CF6"},
      ].map((s,i)=>(<div key={i} style={{display:"flex",gap:12,padding:"10px 14px",background:"#0F111788",borderRadius:10,borderLeft:`3px solid ${s.c}`}}>
        <div style={{fontSize:13,fontWeight:700,color:s.c,minWidth:100}}>{s.n}</div>
        <div style={{fontSize:12,color:"#D1D5DB"}}>{s.d}</div>
      </div>))}
    </div>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
    <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}>
      <div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>FALLBACK-CHAINS</div>
      {[
        {primary:"OpenAI",chain:["Google","Anthropic"],c:"#10B981"},
        {primary:"Anthropic",chain:["OpenAI","Google"],c:"#A855F7"},
        {primary:"Google",chain:["OpenAI","Mistral"],c:"#3B82F6"},
        {primary:"Mistral",chain:["Google","OpenAI"],c:"#F59E0B"},
      ].map((f,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",borderBottom:i<3?"1px solid #2A2D37":"none"}}>
        <span style={{fontSize:12,fontWeight:700,color:f.c,minWidth:80}}>{f.primary}</span>
        <span style={{color:"#6B7280",fontSize:12}}>→</span>
        {f.chain.map((c,j)=>(<span key={j} style={{fontSize:11,color:"#9CA3AF"}}>{c}{j<f.chain.length-1?" → ":""}</span>))}
      </div>))}
    </div>
    <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}>
      <div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>HEALTH-SYSTEM</div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {[
          {status:"Healthy",desc:"Provider antwortet normal. Standard-Routing.",c:"#10B981"},
          {status:"Degraded",desc:"Erhöhte Latenz oder Fehler. Fallback bevorzugt.",c:"#F59E0B"},
          {status:"Down",desc:"Provider nicht erreichbar. Sofort Fallback.",c:"#EF4444"},
        ].map((h,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:10,height:10,borderRadius:5,background:h.c}}/>
          <div><div style={{fontSize:12,fontWeight:600,color:h.c}}>{h.status}</div><div style={{fontSize:11,color:"#9CA3AF"}}>{h.desc}</div></div>
        </div>))}
      </div>
    </div>
  </div>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#1A1830)",borderRadius:14,padding:20,border:"1px solid #6366F140"}}>
    <div style={{fontSize:11,fontWeight:600,color:"#6366F1",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Zukunft: AI Router v2 (Sprint 6+)</div>
    <div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.7}}>Meta-AI-Layer: Ein kleines Modell (GPT-4o-mini) entscheidet bei <strong style={{color:"#F9FAFB"}}>unbekannten Anfragen</strong> dynamisch welche Engine, welches Modell, welche Tools. Standard-Workflows (Talk, Chat, Meeting, Pitch) bleiben als kostenoptimierte Presets. Freestyle-Modus kombiniert frei aus 4 KIs + Echtzeit-Daten.</div>
  </div>
</div>)}
{/* FINANCE */}
{activeTab==="finance"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>SZENARIO-VERGLEICH — UMSATZ</div><div style={{display:"flex",alignItems:"flex-end",gap:16,height:200,padding:"0 8px"}}>{[0,1,2,3,4].map(yi=>{const mx=SCENARIOS.strong.years[4].revenue;return(<div key={yi} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><div style={{display:"flex",gap:3,alignItems:"flex-end",width:"100%",justifyContent:"center",height:170}}>{Object.entries(SCENARIOS).map(([k,v])=>{const h=(v.years[yi].revenue/mx)*160;return<div key={k} style={{width:18,height:Math.max(2,h),background:v.color,borderRadius:"4px 4px 1px 1px",opacity:0.85}}/>;})}</div><span style={{fontSize:11,color:"#6B7280"}}>J{yi+1}</span></div>);})}</div><div style={{display:"flex",justifyContent:"center",gap:20,marginTop:12}}>{Object.entries(SCENARIOS).map(([k,v])=>(<div key={k} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#9CA3AF"}}><div style={{width:10,height:10,borderRadius:2,background:v.color}}/>{v.label}</div>))}</div></div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>{[{l:"Break-Even",s:[{s:"Vorsichtig",v:"~J2"},{s:"Realistisch",v:"J1 (solide)"},{s:"Stark",v:"J1"}]},{l:"€100k Gewinn/J",s:[{s:"Vorsichtig",v:"nie (5J)"},{s:"Realistisch",v:"~J3"},{s:"Stark",v:"~J2"}]},{l:"€1M+ Umsatz/J",s:[{s:"Vorsichtig",v:"nie (5J)"},{s:"Realistisch",v:"~J5"},{s:"Stark",v:"~J3"}]}].map((m,i)=>(<div key={i} style={{background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37"}}><div style={{fontSize:11,fontWeight:600,color:"#A855F7",marginBottom:10,textTransform:"uppercase"}}>{m.l}</div>{m.s.map((s,j)=>(<div key={j} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",color:"#D1D5DB"}}><span style={{color:"#9CA3AF"}}>{s.s}:</span><span style={{fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{s.v}</span></div>))}</div>))}</div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>KOSTEN-VORTEIL: MULTI-PROVIDER ROUTING</div><div style={{fontSize:13,color:"#D1D5DB",lineHeight:1.7}}><strong style={{color:"#F9FAFB"}}>Budget-Degradation senkt AI-Kosten um ~40% bei gleicher Qualität.</strong> Wenn Daily-Spend-Limit erreicht: automatisch von GPT-4o (€0.005/1k) auf Gemini-2.5-Flash-Lite (€0.0001/1k). Fallback-Chains verhindern Ausfälle. Marge steigt mit jedem günstigeren Modell das Google/Mistral liefern.</div></div>
</div>)}
{/* ARCHITECTURE */}
{activeTab==="architecture"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>SOPHIE 5-LAYER PROMPT ARCHITEKTUR</div><div style={{display:"flex",flexDirection:"column",gap:8}}>{ARCH_LAYERS.map((l,i)=>(<div key={i} onClick={()=>setExpandedLayer(expandedLayer===i?null:i)} style={{cursor:"pointer",background:expandedLayer===i?`${l.color}15`:"#0F1117",borderRadius:10,padding:"14px 16px",border:`1px solid ${expandedLayer===i?l.color:"#2A2D37"}`}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:36,height:36,borderRadius:8,background:`${l.color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:l.color}}>{i+1}</div><div style={{flex:1}}><div style={{fontSize:14,fontWeight:600,color:"#F9FAFB"}}>{l.name}</div><div style={{fontSize:11,color:"#9CA3AF"}}>{l.desc}</div></div><span style={{color:"#6B7280",fontSize:12}}>{expandedLayer===i?"▲":"▼"}</span></div>{expandedLayer===i&&<div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${l.color}30`,fontSize:12,color:"#D1D5DB",lineHeight:1.6}}>{l.details}</div>}</div>))}</div></div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}>
    <div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>7 MODI — AUTO-MODES + SESSION-MODES</div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div style={{fontSize:11,color:"#6B7280",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Auto-Modes — Sophie wählt automatisch, signalisiert via signal_mode</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>{MODES.filter(m=>m.type==="auto").map((m,i)=>(<div key={i} style={{background:`${m.color}12`,borderRadius:10,padding:"12px 10px",border:`1px solid ${m.color}30`,textAlign:"center"}}><div style={{fontSize:16,marginBottom:4}}>{m.icon}</div><div style={{fontSize:13,fontWeight:700,color:m.color}}>{m.name}</div><div style={{fontSize:10,color:"#9CA3AF",marginTop:2}}>{m.desc}</div></div>))}</div>
      <div style={{fontSize:11,color:"#6B7280",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Session-Modes — User wählt per UI, ersetzt Auto-Modes komplett</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>{MODES.filter(m=>m.type==="session").map((m,i)=>(<div key={i} style={{background:`${m.color}12`,borderRadius:10,padding:"12px 10px",border:`1px solid ${m.color}30`,textAlign:"center"}}><div style={{fontSize:16,marginBottom:4}}>{m.icon}</div><div style={{fontSize:13,fontWeight:700,color:m.color}}>{m.name}</div><div style={{fontSize:10,color:"#9CA3AF",marginTop:2}}>{m.desc}</div><div style={{fontSize:9,color:"#6B7280",marginTop:4,lineHeight:1.4}}>{m.detail}</div></div>))}</div>
    </div>
  </div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>TECH STACK</div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>{[{cat:"Frontend",items:["Vanilla HTML/JS","Vercel Hosting","PWA-fähig"],v:"Lean & schnell",c:"#3B82F6"},{cat:"Backend",items:["Vercel Serverless (14 Endpoints)","Node.js / Stripe SDK","Multi-AI Router (4 Provider)","OpenAI Realtime API"],v:"Pay-per-use",c:"#10B981"},{cat:"Daten/Auth",items:["Supabase (Postgres + Auth)","25+ Tabellen, RLS aktiv","Magic Link","AI Cost Tracking"],v:"Kostenlos bis ~50k MAU",c:"#A855F7"}].map((s,i)=>(<div key={i} style={{background:"#0F1117",borderRadius:10,padding:16}}><div style={{fontSize:11,fontWeight:600,color:s.c,marginBottom:8,textTransform:"uppercase"}}>{s.cat}</div>{s.items.map((it,j)=><div key={j} style={{fontSize:12,color:"#D1D5DB",padding:"3px 0"}}>• {it}</div>)}<div style={{marginTop:8,fontSize:11,fontWeight:600,color:"#9CA3AF",borderTop:"1px solid #2A2D37",paddingTop:8}}>{s.v}</div></div>))}</div></div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:12}}>DATENBANK-ÜBERSICHT (25+ TABELLEN)</div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>{[
    {cat:"User & Auth",tables:["user_profile","user_subscriptions","user_usage","user_relationship","legal_acceptances"],c:"#6366F1"},
    {cat:"Konversation",tables:["user_sessions","conversation_messages","conversation_outputs","chat_sessions"],c:"#3B82F6"},
    {cat:"Session-Modes",tables:["meetings","meeting_context","meeting_notes","meeting_summary"],c:"#10B981"},
    {cat:"Sophie Memory",tables:["sophie_short_term_memory","sophie_long_term_memory","sophie_meeting_memory","sophie_brainstorm_memory","sophie_pitch_memory"],c:"#A855F7"},
    {cat:"AI Router",tables:["ai_provider_health","ai_request_log","ai_cost_daily"],c:"#F59E0B"},
    {cat:"Import & Analytics",tables:["source_connections","source_items","source_permissions","analytics_events"],c:"#EC4899"},
  ].map((g,i)=>(<div key={i} style={{background:"#0F1117",borderRadius:10,padding:14}}>
    <div style={{fontSize:11,fontWeight:600,color:g.c,marginBottom:6,textTransform:"uppercase"}}>{g.cat}</div>
    {g.tables.map((t,j)=>(<div key={j} style={{fontSize:10,color:"#9CA3AF",fontFamily:"'JetBrains Mono',monospace",padding:"2px 0"}}>• {t}</div>))}
  </div>))}</div></div>
</div>)}
{/* PROJECT */}
{activeTab==="project"&&(<div style={{display:"flex",flexDirection:"column",gap:16}}>
  <div style={{fontSize:13,color:"#9CA3AF",background:"#1A1D27",borderRadius:12,padding:16,border:"1px solid #2A2D37"}}><strong style={{color:"#F9FAFB"}}>Umsetzung mit Claude Code (Max Plan)</strong> — 16 Wochen bis Go-to-Market. 4 AI-Provider, Credits-System, 7 Modi.</div>
  <div style={{background:"#1A1D27",borderRadius:12,padding:20,border:"1px solid #2A2D37"}}><div style={{fontSize:12,fontWeight:600,color:"#9CA3AF",marginBottom:16}}>SPRINT-ÜBERSICHT</div><div style={{display:"flex",flexDirection:"column"}}><div style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:12,marginBottom:8}}><div/><div style={{display:"grid",gridTemplateColumns:"repeat(16,1fr)",gap:1}}>{Array.from({length:16},(_,i)=><div key={i} style={{fontSize:9,color:"#4B5563",textAlign:"center"}}>W{i+1}</div>)}</div></div>{SPRINTS.map((sp,i)=>{const sw=parseInt(sp.weeks.split("–")[0].replace("W",""))-1;const ew=parseInt(sp.weeks.split("–")[1].replace("W",""));return(<div key={i} style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:12,marginBottom:4,cursor:"pointer"}} onClick={()=>setExpandedSprint(expandedSprint===i?null:i)}><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:10,fontWeight:700,color:sp.color,background:`${sp.color}20`,padding:"2px 6px",borderRadius:4}}>{sp.prio}</span><span style={{fontSize:12,fontWeight:600,color:"#D1D5DB"}}>{sp.name}</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(16,1fr)",gap:1,alignItems:"center"}}>{Array.from({length:16},(_,wi)=>(<div key={wi} style={{height:24,background:wi>=sw&&wi<ew?sp.color:"#1F2233",borderRadius:wi===sw?"4px 0 0 4px":wi===ew-1?"0 4px 4px 0":0,opacity:wi>=sw&&wi<ew?0.8:0.3}}/>))}</div></div>);})}</div><div style={{fontSize:11,color:"#F59E0B",marginTop:8}}>▎ Heute: Ende W4 (Sprint 2 aktiv)</div></div>
  {SPRINTS.map((sp,i)=>(<div key={i} onClick={()=>setExpandedSprint(expandedSprint===i?null:i)} style={{background:"#1A1D27",borderRadius:12,padding:16,border:expandedSprint===i?`2px solid ${sp.color}`:"1px solid #2A2D37",cursor:"pointer"}}><div style={{display:"flex",alignItems:"center",gap:12}}><div style={{width:32,height:32,borderRadius:8,background:`${sp.color}25`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:sp.color}}>{sp.id}</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:14,fontWeight:600,color:"#F9FAFB"}}>Sprint {sp.id}: {sp.name}</span><span style={{fontSize:10,fontWeight:600,color:sp.color,background:`${sp.color}20`,padding:"2px 8px",borderRadius:10}}>{sp.prio}</span>{sp.progress>0&&<span style={{fontSize:10,color:"#9CA3AF"}}>{sp.progress}%</span>}</div><div style={{fontSize:11,color:"#6B7280"}}>{sp.weeks} · Dep: {sp.deps}</div></div><span style={{color:"#6B7280",fontSize:12}}>{expandedSprint===i?"▲":"▼"}</span></div>{sp.progress>0&&<div style={{marginTop:8}}><ProgressBar progress={sp.progress} color={sp.color}/></div>}{expandedSprint===i&&(<div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #2A2D37"}}><div style={{fontSize:11,fontWeight:600,color:"#9CA3AF",marginBottom:8}}>ARBEITSPAKETE</div>{sp.packages.map((p,j)=><div key={j} style={{fontSize:12,color:"#D1D5DB",padding:"4px 8px",background:"#0F111788",borderRadius:6,marginBottom:4}}>→ {p}</div>)}{sp.notes&&<div style={{marginTop:8,fontSize:11,color:"#6B7280",fontStyle:"italic"}}>{sp.notes}</div>}<div style={{marginTop:10,fontSize:11,color:sp.doneReached?"#10B981":"#F59E0B"}}><strong>Done:</strong> {sp.done} — {sp.doneReached?"✓":"Offen"}</div></div>)}</div>))}
</div>)}
{/* WHY */}
{activeTab==="why"&&(<div style={{display:"flex",flexDirection:"column",gap:20}}>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#1E1530)",borderRadius:14,padding:24,border:"1px solid #A855F740"}}><div style={{fontSize:11,fontWeight:600,color:"#A855F7",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Warum Kunden es lieben</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>{[{t:"Sprechen statt Tippen",d:"Voice-first fühlt sich natürlicher und intimer an."},{t:"Eine Person, nicht ein Tool",d:"Stabiler Charakter — Sophie ist immer Sophie."},{t:"Kontinuität erzeugt Bindung",d:"Sophie erinnert sich. Wie eine Vertraute."},{t:"Klarheit nach jedem Gespräch",d:"Session Insights, Key Takeaways, Action Plans."},{t:"Kein Urteil, kein Zeitdruck",d:"Immer da, immer aufmerksam."},{t:"Sales Pitch trainieren",d:"\"Wenn du Sophie überzeugst, überzeugst du jeden.\" 4 Personas, X/50 Score, brutal ehrlich."},{t:"Brainstorm auf Profi-Level",d:"Moderator + Sparring: Ideen clustern, priorisieren, challengen — in Echtzeit."},{t:"4 KIs, eine Sophie",d:"Multi-Provider Routing: beste Qualität, niedrigste Kosten, null Ausfälle."}].map((c,i)=>(<div key={i} style={{background:"#0F111766",borderRadius:10,padding:14}}><div style={{fontSize:13,fontWeight:600,color:"#F9FAFB",marginBottom:4}}>{c.t}</div><div style={{fontSize:12,color:"#9CA3AF",lineHeight:1.5}}>{c.d}</div></div>))}</div></div>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#0F2218)",borderRadius:14,padding:24,border:"1px solid #10B98140"}}><div style={{fontSize:11,fontWeight:600,color:"#10B981",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Warum wir Geld verdienen</div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>{[{m:"72%",l:"DB-Marge",s:"stabil"},{m:"€20+",l:"ARPU/Mo",s:"steigt mit Mix"},{m:"€0",l:"Server-Fix",s:"Serverless"},{m:"4",l:"AI Provider",s:"Kostenoptimierung"},{m:"~85%",l:"Top-up Marge",s:"€10 Paket"},{m:"∞",l:"Emotional Lock-in",s:"kein Vergleich"}].map((m,i)=>(<div key={i} style={{textAlign:"center",padding:12}}><div style={{fontSize:22,fontWeight:700,color:"#10B981"}}>{m.m}</div><div style={{fontSize:12,fontWeight:600,color:"#F9FAFB",marginTop:4}}>{m.l}</div><div style={{fontSize:11,color:"#6B7280"}}>{m.s}</div></div>))}</div></div>
  <div style={{background:"linear-gradient(135deg,#1A1D27,#1A1830)",borderRadius:14,padding:24,border:"1px solid #6366F140"}}><div style={{fontSize:11,fontWeight:600,color:"#6366F1",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>Zukunftsmodell</div><div style={{display:"flex",flexDirection:"column",gap:12}}>{[{t:"AI Voice wird billiger",d:"Marge steigt automatisch. Multi-Provider Routing optimiert Kosten pro Request."},{t:"Thinking & Training AI ist die nächste Kategorie",d:"Denkpartner + Trainingspartner. Nicht Ersatzpartner — Kraftverstärker."},{t:"Voice-first = Moat",d:"Switching-Kosten sind emotional, nicht technisch."},{t:"Credits = transparente Abrechnung",d:"1 Credit ≈ €0.01 AI-Kosten. User versteht was er bezahlt. Kein Minuten-Vergleich mehr."},{t:"Skalierbar ohne Team",d:"Serverless + Supabase + 4 AI Provider = keine Ops. Budget-Degradation verhindert Kostenexplosion."}].map((c,i)=>(<div key={i} style={{display:"flex",gap:14,padding:"10px 0",borderBottom:i<4?"1px solid #2A2D37":"none"}}><div style={{width:28,height:28,borderRadius:6,background:"#6366F125",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#6366F1",flexShrink:0}}>{i+1}</div><div><div style={{fontSize:13,fontWeight:600,color:"#F9FAFB"}}>{c.t}</div><div style={{fontSize:12,color:"#9CA3AF",lineHeight:1.5,marginTop:2}}>{c.d}</div></div></div>))}</div></div>
  <div style={{background:"#1A1D27",borderRadius:14,padding:24,border:"1px solid #2A2D37",textAlign:"center"}}><div style={{fontSize:18,fontWeight:700,color:"#F9FAFB",marginBottom:12}}>Ehrliches Gesamturteil</div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:16}}>{[{y:"Jahr 1",v:"Fragil, aber tragfähig",c:"#F59E0B"},{y:"Jahr 3",v:"Gutes Geschäft",c:"#3B82F6"},{y:"Jahr 5",v:"Sehr attraktiv",c:"#10B981"}].map((m,i)=>(<div key={i} style={{padding:12,background:`${m.c}15`,borderRadius:10,border:`1px solid ${m.c}30`}}><div style={{fontSize:14,fontWeight:700,color:m.c}}>{m.y}</div><div style={{fontSize:12,color:"#D1D5DB",marginTop:4}}>{m.v}</div></div>))}</div><div style={{fontSize:14,color:"#A855F7",fontWeight:600,fontStyle:"italic"}}>Die wichtigste Zahl: Wie viele zahlende Nutzer werden mit der Zeit profitabler?</div></div>
</div>)}
      </div>
    </div>
  );
}
