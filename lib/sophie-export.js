/**
 * sophie-export.js — Unified Export Module
 *
 * Kanonisches Report-Objekt (reportData):
 * {
 *   id,              // session_id oder meeting_id
 *   type,            // "talk"|"brainstorm"|"salespitch"|"meeting"|"chat"
 *   source,          // Herkunftsseite: "talk"|"meeting"|"settings"|"reports"
 *   title,           // Report-Titel
 *   createdAt,       // ISO-String oder Date
 *   html,            // Vollständiges Report-HTML
 *   plainText,       // Klartext-Version (optional, wird aus html extrahiert wenn leer)
 *   hasTranscript,   // boolean
 *   transcriptHtml,  // Transkript-HTML (optional)
 *   continuePayload, // { sourceType, sourceId, resumeSessionId, targetMode, createdAt }
 * }
 */

// ── Dateiname ────────────────────────────────────────────

function resolveDocType({ type, source }) {
  const map = {
    talk: "Gespraech",
    brainstorm: "Brainstorming",
    salespitch: "Sales-Pitch",
    meeting: "Meeting",
    chat: "Chat",
  };
  return map[type] || map[source] || "Dokument";
}

function sanitizeTitle(title, maxLen = 60) {
  return (
    String(title || "Ohne-Titel")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Combining marks entfernen
      .replace(/[^a-zA-Z0-9\- ]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, maxLen) || "Ohne-Titel"
  );
}

function buildFilename(reportData, ext = "html") {
  const date = new Date(reportData.createdAt || Date.now())
    .toISOString()
    .slice(0, 10);
  const docType = resolveDocType(reportData);
  return `${date}_${docType}_${sanitizeTitle(reportData.title)}.${ext}`;
}

// ── Capabilities ─────────────────────────────────────────

function getCapabilities(reportData) {
  const { type, hasTranscript } = reportData;
  return {
    canCopy: true,
    canShare: true,
    canDownload: true,
    canPrint: true,
    canSaveTemplate: type === "meeting",
    canShowTranscript: !!hasTranscript && (type === "talk" || type === "meeting"),
    canContinue: true,
  };
}

// ── Telemetrie (Stub — Client-Analytics noch nicht implementiert) ──

function trackExport(action, reportData) {
  // Stub: wird später mit analytics_events befüllt
  try {
    if (typeof window !== "undefined" && window.__sophieTrackExport) {
      window.__sophieTrackExport({
        action,
        type: reportData.type,
        source: reportData.source,
        reportId: reportData.id,
        hasTranscript: reportData.hasTranscript,
      });
    }
  } catch (_) {
    /* non-fatal */
  }
}

// ── Hilfsfunktionen ──────────────────────────────────────

function _extractPlainText(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function _isIOS() {
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// ── Export-Aktionen ──────────────────────────────────────

/**
 * Kopiert Report als HTML + Plain Text ins Clipboard.
 * Fallback-Kette: ClipboardItem → writeText → execCommand
 */
async function copyReport(html, plain) {
  const plainText = plain || _extractPlainText(html);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
    return { ok: true, method: "clipboard" };
  } catch (_) {
    try {
      await navigator.clipboard.writeText(plainText);
      return { ok: true, method: "text" };
    } catch (__) {
      // execCommand fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = plainText;
        ta.style.cssText = "position:fixed;left:-9999px;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return { ok: true, method: "execCommand" };
      } catch (___) {
        return { ok: false };
      }
    }
  }
}

/**
 * Teilen-Funktion: Kopiert zuerst ins Clipboard (für Mail-Einfügen),
 * dann öffnet Share-Sheet wenn verfügbar.
 */
async function shareReport(html, plain, title) {
  const plainText = plain || _extractPlainText(html);

  // Zuerst ins Clipboard (für Mail-Einfügen)
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
  } catch (_) {
    try {
      await navigator.clipboard.writeText(plainText);
    } catch (__) {
      /* best-effort */
    }
  }

  // Share-Sheet öffnen
  if (navigator.share) {
    try {
      await navigator.share({ title: title || "Sophie Report", text: plainText });
      return { ok: true, method: "share" };
    } catch (_) {
      return { ok: true, method: "clipboard" };
    }
  }

  // Kein Share-Sheet (Desktop) — Report ist im Clipboard
  return { ok: true, method: "clipboard" };
}

/**
 * Herunterladen als HTML-Datei.
 * iOS: navigator.share mit File Fallback.
 */
function downloadReport(html, filename) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });

  // iOS: blob downloads via a.click() scheitern oft.
  // Web Share API mit file verwenden wenn verfügbar (iOS 15+)
  if (_isIOS() && navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: "text/html" });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: filename }).catch(() => {});
      return;
    }
  }

  // Standard: Blob download via a.click()
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Drucken / PDF: iframe (Mobile) → window.open (Desktop) → HTML-Download (Fallback)
 * Injiziert print-color-adjust damit Farben im PDF erhalten bleiben.
 */
function printReport(html) {
  // Print-Farben sichern: color-adjust injizieren wenn nicht vorhanden
  let printHtml = html;
  if (!printHtml.includes("print-color-adjust")) {
    const colorRule = "<style>@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important;}}</style>";
    if (printHtml.includes("</head>")) {
      printHtml = printHtml.replace("</head>", colorRule + "</head>");
    } else if (printHtml.includes("<body")) {
      printHtml = printHtml.replace("<body", colorRule + "<body");
    } else {
      printHtml = colorRule + printHtml;
    }
  }
  const printReady = printHtml;

  const isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile) {
    // Mobile: window.open wird von iOS blockiert. Hidden iframe verwenden.
    let printFrame = document.getElementById("_sophiePrintFrame");
    if (!printFrame) {
      printFrame = document.createElement("iframe");
      printFrame.id = "_sophiePrintFrame";
      printFrame.style.cssText =
        "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none;";
      document.body.appendChild(printFrame);
    }
    const doc =
      printFrame.contentDocument || printFrame.contentWindow.document;
    doc.open();
    doc.write(printReady);
    doc.close();
    setTimeout(() => {
      try {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
      } catch (_) {
        // iframe print fehlgeschlagen → HTML-Download als letzter Fallback
        const blob = new Blob([printReady], { type: "text/html;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `report-${new Date().toISOString().slice(0, 10)}.html`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    }, 600);
  } else {
    // Desktop: neues Fenster für Print-Dialog
    const printWin = window.open("", "_blank");
    if (!printWin) {
      // Popup-Blocker aktiv → HTML-Download
      const blob = new Blob([printReady], { type: "text/html;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `report-${new Date().toISOString().slice(0, 10)}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    printWin.document.write(printReady);
    printWin.document.close();
    printWin.onload = () => {
      printWin.focus();
      printWin.print();
    };
    setTimeout(() => {
      try {
        printWin.focus();
        printWin.print();
      } catch (_) {}
    }, 500);
  }
}

// ── Continue / Fortführen ────────────────────────────────

const CONTINUE_KEY = "sophie_continue";
const CONTINUE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Schreibt Continue-Payload in sessionStorage.
 */
function writeContinuePayload(payload) {
  if (!payload) return;
  const data = { ...payload, createdAt: Date.now() };
  try {
    sessionStorage.setItem(CONTINUE_KEY, JSON.stringify(data));
  } catch (_) {
    /* non-fatal */
  }
}

/**
 * Liest Continue-Payload aus sessionStorage.
 * Löscht sofort nach Lesen. Ignoriert stale Payloads (>24h).
 */
function readContinuePayload() {
  try {
    const raw = sessionStorage.getItem(CONTINUE_KEY);
    sessionStorage.removeItem(CONTINUE_KEY); // sofort löschen
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data.createdAt || 0) > CONTINUE_MAX_AGE_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// ── UI: mountExportBar ───────────────────────────────────

/**
 * Rendert Export-Leiste in Container und bindet Events direkt.
 *
 * @param {HTMLElement} container — Ziel-Container
 * @param {Object} reportData — Kanonisches Report-Objekt
 * @param {Object} handlers — { onContinue, onSaveTemplate, onToggleTranscript }
 * @returns {{ destroy: Function }} — Cleanup
 */
function mountExportBar(container, reportData, handlers = {}) {
  const caps = getCapabilities(reportData);
  const html = reportData.html || "";
  const plain = reportData.plainText || _extractPlainText(html);
  const filename = buildFilename(reportData);

  container.innerHTML = "";

  // ── SVG Icons (Lucide-style, 15×15) ──
  const ICONS = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
    share: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
    download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    printer: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    bookmark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
    play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    transcript: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  };

  function _makeBtn(iconKey, label, cls) {
    const btn = document.createElement("button");
    btn.className = `se-btn ${cls}`;
    btn.innerHTML = `${ICONS[iconKey] || ""}<span>${label}</span>`;
    return btn;
  }

  function _makeSectionLine(title) {
    const line = document.createElement("div");
    line.className = "se-section-line";
    line.innerHTML = `<div class="se-section-title">${title}</div>`;
    return line;
  }

  // ── Export-Gruppe ──
  container.appendChild(_makeSectionLine("Export"));

  const exportRow = document.createElement("div");
  exportRow.className = "se-row";

  // Kopieren
  if (caps.canCopy) {
    const btn = _makeBtn("copy", "Kopieren", "se-copy");
    btn.addEventListener("click", async () => {
      const result = await copyReport(html, plain);
      trackExport("copy", reportData);
      const span = btn.querySelector("span");
      span.textContent = result.ok ? "\u2713 Kopiert" : "\u2717 Fehler";
      setTimeout(() => { span.textContent = "Kopieren"; }, 2000);
    });
    exportRow.appendChild(btn);
  }

  // Teilen
  if (caps.canShare) {
    const btn = _makeBtn("share", "Teilen", "se-share");
    btn.addEventListener("click", async () => {
      const result = await shareReport(html, plain, reportData.title);
      trackExport("share", reportData);
      if (result.method === "clipboard") {
        const span = btn.querySelector("span");
        span.textContent = "\u2713 Kopiert";
        setTimeout(() => { span.textContent = "Teilen"; }, 2000);
      }
    });
    exportRow.appendChild(btn);
  }

  // Herunterladen
  if (caps.canDownload) {
    const btn = _makeBtn("download", "Herunterladen", "se-download");
    btn.addEventListener("click", () => {
      downloadReport(html, filename);
      trackExport("download", reportData);
    });
    exportRow.appendChild(btn);
  }

  // Drucken / PDF
  if (caps.canPrint) {
    const btn = _makeBtn("printer", "Drucken / PDF", "se-print");
    btn.addEventListener("click", () => {
      printReport(html);
      trackExport("print", reportData);
    });
    exportRow.appendChild(btn);
  }

  container.appendChild(exportRow);

  // ── Layout-Gruppe (Vorlage, Transkript) ──
  const hasLayoutButtons = (caps.canSaveTemplate && handlers.onSaveTemplate) ||
    (caps.canShowTranscript && handlers.onToggleTranscript);

  if (hasLayoutButtons) {
    container.appendChild(_makeSectionLine("Layout"));
    const layoutRow = document.createElement("div");
    layoutRow.className = "se-row";

    if (caps.canSaveTemplate && handlers.onSaveTemplate) {
      const btn = _makeBtn("bookmark", "Als Vorlage", "se-template");
      btn.addEventListener("click", async () => {
        await handlers.onSaveTemplate();
        const span = btn.querySelector("span");
        span.textContent = "\u2713 Gespeichert";
        setTimeout(() => { span.textContent = "Als Vorlage"; }, 3000);
      });
      layoutRow.appendChild(btn);
    }

    if (caps.canShowTranscript && handlers.onToggleTranscript) {
      const btn = _makeBtn("transcript", "Transkript", "se-transcript");
      btn.addEventListener("click", () => {
        const active = btn.classList.toggle("active");
        handlers.onToggleTranscript(active);
      });
      layoutRow.appendChild(btn);
    }

    container.appendChild(layoutRow);
  }

  // ── Fortführen ──
  if (caps.canContinue && reportData.continuePayload) {
    const continueRow = document.createElement("div");
    continueRow.className = "se-row";
    continueRow.style.marginTop = "12px";

    const btn = _makeBtn("play", "Fortführen", "se-continue");
    btn.addEventListener("click", () => {
      trackExport("continue", reportData);
      writeContinuePayload(reportData.continuePayload);
      if (handlers.onContinue) {
        handlers.onContinue(reportData.continuePayload);
      } else {
        const p = reportData.continuePayload;
        if (p.sourceType === "meeting") {
          window.location.href = `/meeting/?parentMeetingId=${encodeURIComponent(p.sourceId)}`;
        } else {
          const mode = p.targetMode;
          const url = mode ? `/talk/?mode=${encodeURIComponent(mode)}` : "/talk/";
          window.location.href = url;
        }
      }
    });
    continueRow.appendChild(btn);
    container.appendChild(continueRow);
  }

  // ── Styles (matching Talk page design) ──
  if (!document.getElementById("sophie-export-styles")) {
    const style = document.createElement("style");
    style.id = "sophie-export-styles";
    style.textContent = `
      .se-section-line {
        display: flex;
        align-items: center;
        gap: 16px;
        margin: 0 0 12px;
      }
      .se-section-line::before,
      .se-section-line::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #ede8e2;
      }
      .se-section-title {
        font-size: 12px;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #b0a090;
        font-weight: 600;
      }
      .se-row {
        display: flex;
        gap: 10px;
        justify-content: center;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .se-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 10px 18px;
        border-radius: 20px;
        background: none;
        border: 1px solid #ddd6cc;
        color: #6a5a50;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: all .18s ease;
        white-space: nowrap;
      }
      .se-btn:hover {
        background: #f0ece6;
        border-color: #c4a882;
        color: #2c2420;
      }
      .se-btn:active {
        background: #e8e2da;
      }
      .se-btn svg {
        opacity: .9;
        flex-shrink: 0;
      }
      .se-btn span {
        font-size: 13px;
        font-weight: 600;
      }
      .se-btn.active {
        background: #e8f4e8;
        border-color: #4a8c5c;
        color: #2d5a3a;
      }
      .se-btn.se-continue {
        background: #f0ebe4;
        border-color: #c4b69c;
        color: #5c4a2a;
      }
      .se-btn.se-continue:hover {
        background: #e8e0d4;
        border-color: #b0986c;
      }
      @media (max-width: 480px) {
        .se-row { gap: 6px; }
        .se-btn { padding: 8px 12px; font-size: 12px; }
        .se-btn span { font-size: 12px; }
      }
    `;
    document.head.appendChild(style);
  }

  return {
    destroy() {
      container.innerHTML = "";
    },
  };
}

// ── Public API ───────────────────────────────────────────

window.SophieExport = {
  // Dateiname
  buildFilename,
  sanitizeTitle,
  resolveDocType,

  // Export-Aktionen
  copyReport,
  shareReport,
  downloadReport,
  printReport,

  // Capabilities
  getCapabilities,

  // UI
  mountExportBar,

  // Continue / Fortführen
  writeContinuePayload,
  readContinuePayload,
  CONTINUE_KEY,
};
