/**
 * sophie-report-overlay.js — Gemeinsame Report-Detail-Ansicht
 *
 * Verwendet von Settings + Verlauf.
 * Rendert Overlay mit Export-Bar via SophieExport.mountExportBar().
 *
 * Voraussetzung: sophie-export.js muss vorher geladen sein.
 */

// ── Overlay öffnen ───────────────────────────────────────

/**
 * Öffnet ein Fullscreen-Overlay mit Report-Details und Export-Leiste.
 *
 * @param {Object} reportData — Kanonisches Report-Objekt (siehe sophie-export.js)
 * @param {Object} options
 * @param {Function} [options.onContinue] — Custom Continue-Handler
 * @param {Function} [options.onSaveTemplate] — Custom Template-Handler
 * @param {Function} [options.onDelete] — Löschen-Handler (optional)
 * @param {string} [options.lang] — Sprache ("de"|"en"|"fr"), default "de"
 */
function openReportOverlay(reportData, options = {}) {
  const { onContinue, onSaveTemplate, onDelete, lang = "de" } = options;

  // Bestehende Overlay entfernen wenn vorhanden
  closeReportOverlay();

  // Overlay DOM erstellen
  const overlay = document.createElement("div");
  overlay.id = "sophieReportOverlay";
  overlay.className = "sophie-report-overlay";

  // Typ-Badge Farbe
  const typeBadgeColors = {
    talk: "#6b9080",
    brainstorm: "#7c6fb0",
    salespitch: "#c07830",
    meeting: "#3080a0",
    chat: "#888",
  };
  const badgeColor = typeBadgeColors[reportData.type] || "#888";
  const typeLabel = _resolveTypeLabel(reportData.type, lang);
  const dateStr = _formatDate(reportData.createdAt, lang);

  overlay.innerHTML = `
    <div class="sro-container">
      <div class="sro-header">
        <div class="sro-meta">
          <span class="sro-badge" style="background:${badgeColor}">${typeLabel}</span>
          <span class="sro-date">${dateStr}</span>
        </div>
        <div class="sro-title-row">
          <h2 class="sro-title">${_escapeHtml(reportData.title || "Report")}</h2>
          <button class="sro-close" aria-label="${lang === "de" ? "Schließen" : lang === "fr" ? "Fermer" : "Close"}">&times;</button>
        </div>
      </div>
      <div class="sro-content"></div>
      <div class="sro-export-bar"></div>
      ${onDelete ? '<div class="sro-delete-row"><button class="sro-delete-btn">' + (lang === "de" ? "Löschen" : lang === "fr" ? "Supprimer" : "Delete") + '</button></div>' : ''}
    </div>
  `;

  document.body.appendChild(overlay);

  // Report-HTML in Content-Container rendern (kein iframe)
  const contentEl = overlay.querySelector(".sro-content");
  if (reportData.html) {
    contentEl.innerHTML = reportData.html;
  } else if (reportData.plainText) {
    contentEl.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;line-height:1.75;color:#444;">${_escapeHtml(reportData.plainText)}</pre>`;
  } else {
    contentEl.innerHTML = `<p style="color:#999;text-align:center;padding:40px 0;">${lang === "de" ? "Kein Report vorhanden." : lang === "fr" ? "Aucun rapport disponible." : "No report available."}</p>`;
  }

  // Export-Bar via SophieExport mounten
  const exportBarEl = overlay.querySelector(".sro-export-bar");
  let exportBarInstance = null;
  if (typeof window.SophieExport !== "undefined") {
    exportBarInstance = window.SophieExport.mountExportBar(
      exportBarEl,
      reportData,
      {
        onContinue: onContinue || null,
        onSaveTemplate: onSaveTemplate || null,
        onToggleTranscript: reportData.hasTranscript
          ? (active) => {
              const transcriptEl = overlay.querySelector(".sro-transcript");
              if (transcriptEl) {
                transcriptEl.style.display = active ? "block" : "none";
              }
            }
          : null,
      }
    );
  }

  // Transkript-Container (hidden by default)
  if (reportData.hasTranscript && reportData.transcriptHtml) {
    const transcriptDiv = document.createElement("div");
    transcriptDiv.className = "sro-transcript";
    transcriptDiv.style.display = "none";
    transcriptDiv.innerHTML = `
      <div style="margin-top:16px;padding:16px;background:#f9f7f5;border-radius:12px;border:1px solid #ede8e2;">
        <h4 style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#a09080;margin:0 0 12px;">
          ${lang === "de" ? "Transkript" : lang === "fr" ? "Transcription" : "Transcript"}
        </h4>
        <div style="font-size:14px;line-height:1.75;color:#444;white-space:pre-wrap;word-break:break-word;">
          ${reportData.transcriptHtml}
        </div>
      </div>
    `;
    contentEl.after(transcriptDiv);
  }

  // Event Handlers
  overlay.querySelector(".sro-close").addEventListener("click", closeReportOverlay);

  // Escape-Taste
  const escHandler = (e) => {
    if (e.key === "Escape") closeReportOverlay();
  };
  document.addEventListener("keydown", escHandler);

  // Delete-Handler
  if (onDelete) {
    const deleteBtn = overlay.querySelector(".sro-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        const confirmMsg = lang === "de" ? "Report wirklich löschen?" : lang === "fr" ? "Vraiment supprimer ce rapport ?" : "Really delete this report?";
        if (confirm(confirmMsg)) {
          await onDelete(reportData);
          closeReportOverlay();
        }
      });
    }
  }

  // Body Scroll sperren
  document.body.style.overflow = "hidden";

  // Cleanup-Referenz speichern
  overlay._cleanup = () => {
    document.removeEventListener("keydown", escHandler);
    if (exportBarInstance) exportBarInstance.destroy();
    document.body.style.overflow = "";
  };

  // Scroll nach oben
  overlay.scrollTop = 0;
}

// ── Overlay schließen ────────────────────────────────────

function closeReportOverlay() {
  const overlay = document.getElementById("sophieReportOverlay");
  if (!overlay) return;
  if (overlay._cleanup) overlay._cleanup();
  overlay.remove();
}

// ── Hilfsfunktionen ──────────────────────────────────────

function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function _resolveTypeLabel(type, lang) {
  if (lang === "de") {
    const map = {
      talk: "Gespräch",
      brainstorm: "Brainstorming",
      salespitch: "Sales Pitch",
      meeting: "Meeting",
      chat: "Chat",
    };
    return map[type] || "Dokument";
  }
  const map = {
    talk: "Conversation",
    brainstorm: "Brainstorming",
    salespitch: "Sales Pitch",
    meeting: "Meeting",
    chat: "Chat",
  };
  return map[type] || "Document";
}

function _formatDate(dateStr, lang) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const locale = lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : "en-US";
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ── Styles ───────────────────────────────────────────────

function _injectOverlayStyles() {
  if (document.getElementById("sophie-report-overlay-styles")) return;
  const style = document.createElement("style");
  style.id = "sophie-report-overlay-styles";
  style.textContent = `
    .sophie-report-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: #faf9f6;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 20px;
      padding-top: max(20px, calc(env(safe-area-inset-top, 0px) + 20px));
      padding-bottom: max(20px, calc(env(safe-area-inset-bottom, 0px) + 20px));
    }
    .sro-container {
      max-width: 640px;
      margin: 0 auto;
    }
    .sro-header {
      margin-bottom: 16px;
    }
    .sro-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .sro-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .02em;
    }
    .sro-date {
      font-size: 13px;
      color: #a09080;
    }
    .sro-title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .sro-title {
      font-size: 20px;
      font-weight: 700;
      color: #2a2420;
      margin: 0;
      line-height: 1.3;
      flex: 1;
    }
    .sro-close {
      background: none;
      border: none;
      color: #2a2420;
      font-size: 28px;
      cursor: pointer;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border-radius: 50%;
      transition: background 0.15s;
    }
    .sro-close:hover {
      background: rgba(0,0,0,0.05);
    }
    .sro-content {
      background: #fff;
      border: 1px solid #ede8e2;
      border-radius: 12px;
      padding: 20px;
      overflow: hidden;
      color: #1a1a1a;
      line-height: 1.7;
      font-size: 15px;
    }
    .sro-content h1, .sro-content h2, .sro-content h3, .sro-content h4 {
      color: #2a2420;
    }
    .sro-content img {
      max-width: 100%;
      height: auto;
    }
    .sro-export-bar {
      margin-top: 16px;
    }
    .sro-delete-row {
      margin-top: 16px;
      text-align: center;
    }
    .sro-delete-btn {
      background: none;
      border: 1px solid #e0c0c0;
      border-radius: 20px;
      color: #a05050;
      padding: 8px 24px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .sro-delete-btn:hover {
      background: #fde8e8;
      color: #8b3030;
    }
    @media (max-width: 480px) {
      .sophie-report-overlay {
        padding: 12px;
        padding-top: max(12px, calc(env(safe-area-inset-top, 0px) + 12px));
      }
      .sro-title {
        font-size: 17px;
      }
      .sro-content {
        padding: 14px;
        font-size: 14px;
      }
    }
    @media print {
      .sophie-report-overlay {
        position: static;
        background: #fff;
        padding: 0;
      }
      .sro-close, .sro-export-bar, .sro-delete-row {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

// Styles beim Laden injizieren
_injectOverlayStyles();

// ── Public API ───────────────────────────────────────────

window.SophieReportOverlay = {
  open: openReportOverlay,
  close: closeReportOverlay,
};
