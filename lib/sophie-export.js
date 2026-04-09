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
  container.className = "sophie-export-bar";

  const buttons = [];

  // Kopieren
  if (caps.canCopy) {
    buttons.push({
      icon: "\ud83d\udccb",
      label: "Kopieren",
      cls: "se-copy",
      action: async (btn) => {
        const result = await copyReport(html, plain);
        trackExport("copy", reportData);
        btn.textContent = result.ok ? "\u2713 Kopiert" : "\u2717 Fehler";
        setTimeout(() => {
          btn.textContent = "\ud83d\udccb Kopieren";
        }, 2000);
      },
    });
  }

  // Teilen
  if (caps.canShare) {
    buttons.push({
      icon: "\ud83d\udce4",
      label: "Teilen",
      cls: "se-share",
      action: async (btn) => {
        const result = await shareReport(html, plain, reportData.title);
        trackExport("share", reportData);
        if (result.method === "clipboard") {
          btn.textContent = "\u2713 Kopiert";
          setTimeout(() => {
            btn.textContent = "\ud83d\udce4 Teilen";
          }, 2000);
        }
      },
    });
  }

  // Herunterladen
  if (caps.canDownload) {
    buttons.push({
      icon: "\u2b07\ufe0f",
      label: "Herunterladen",
      cls: "se-download",
      action: () => {
        downloadReport(html, filename);
        trackExport("download", reportData);
      },
    });
  }

  // Drucken / PDF
  if (caps.canPrint) {
    buttons.push({
      icon: "\ud83d\udda8\ufe0f",
      label: "Drucken / PDF",
      cls: "se-print",
      action: () => {
        printReport(html);
        trackExport("print", reportData);
      },
    });
  }

  // Gesprächsverlauf (Transkript-Toggle)
  if (caps.canShowTranscript && handlers.onToggleTranscript) {
    buttons.push({
      icon: "\ud83d\udcdd",
      label: "Transkript",
      cls: "se-transcript",
      action: (btn) => {
        const active = btn.classList.toggle("active");
        handlers.onToggleTranscript(active);
      },
    });
  }

  // Als Vorlage (nur Meeting)
  if (caps.canSaveTemplate && handlers.onSaveTemplate) {
    buttons.push({
      icon: "\ud83d\udcbe",
      label: "Als Vorlage",
      cls: "se-template",
      action: async (btn) => {
        await handlers.onSaveTemplate();
        btn.textContent = "\u2713 Gespeichert";
        setTimeout(() => {
          btn.textContent = "\ud83d\udcbe Als Vorlage";
        }, 3000);
      },
    });
  }

  // Fortführen
  if (caps.canContinue && reportData.continuePayload) {
    buttons.push({
      icon: "\u25b6\ufe0f",
      label: "Fortführen",
      cls: "se-continue",
      action: () => {
        trackExport("continue", reportData);
        writeContinuePayload(reportData.continuePayload);
        if (handlers.onContinue) {
          handlers.onContinue(reportData.continuePayload);
        } else {
          // Default-Navigation basierend auf Typ
          const p = reportData.continuePayload;
          if (p.sourceType === "meeting") {
            window.location.href = `/meeting/?parentMeetingId=${encodeURIComponent(p.sourceId)}`;
          } else {
            const mode = p.targetMode;
            const url = mode ? `/talk/?mode=${encodeURIComponent(mode)}` : "/talk/";
            window.location.href = url;
          }
        }
      },
    });
  }

  // Buttons rendern
  buttons.forEach(({ icon, label, cls, action }) => {
    const btn = document.createElement("button");
    btn.className = `sophie-export-btn ${cls}`;
    btn.textContent = `${icon} ${label}`;
    btn.addEventListener("click", () => action(btn));
    container.appendChild(btn);
  });

  // Inline-Styles für Export-Bar (vermeidet externe CSS-Abhängigkeit)
  if (!document.getElementById("sophie-export-styles")) {
    const style = document.createElement("style");
    style.id = "sophie-export-styles";
    style.textContent = `
      .sophie-export-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 12px 0;
        justify-content: center;
      }
      .sophie-export-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 8px 14px;
        border: 1px solid #ddd;
        border-radius: 20px;
        background: #fff;
        color: #333;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        white-space: nowrap;
      }
      .sophie-export-btn:hover {
        background: #f5f5f5;
        border-color: #bbb;
      }
      .sophie-export-btn:active {
        background: #eee;
      }
      .sophie-export-btn.active {
        background: #e8f4e8;
        border-color: #4a8c5c;
        color: #2d5a3a;
      }
      .sophie-export-btn.se-continue {
        background: #f0ebe4;
        border-color: #c4b69c;
        color: #5c4a2a;
        font-weight: 600;
      }
      .sophie-export-btn.se-continue:hover {
        background: #e8e0d4;
      }
      @media (max-width: 480px) {
        .sophie-export-bar {
          gap: 6px;
        }
        .sophie-export-btn {
          padding: 7px 10px;
          font-size: 12px;
        }
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
