// TEMPORAER — Testmodus "Erst-Gespraech simulieren" fuer interne Tests.
// Entfernen: diese Datei + alle Stellen mit isFirstSessionTest / _testFirstSession
// (api/session.js, api/memory-update.js, talk/index.html).
//
// Aktiv nur, wenn BEIDES zutrifft:
//   1. Request-Header  X-Sophie-Test-Mode: first-session   (setzt /talk?testfirst=1)
//   2. Eingeloggte E-Mail steht in TEST_MODE_EMAILS
// Dann behandelt /api/session den User wie einen brandneuen User (kein Name,
// kein Gedaechtnis, keine Historie) und /api/memory-update speichert nichts.

const TEST_MODE_EMAILS = ["michael@mmhammer.org"];

export function isFirstSessionTest(req, user) {
  const header = String(req?.headers?.["x-sophie-test-mode"] || "").toLowerCase();
  if (header !== "first-session") return false;
  return TEST_MODE_EMAILS.includes(String(user?.email || "").toLowerCase());
}

export function testModeLanguage(req) {
  const lang = String(req?.headers?.["x-sophie-test-lang"] || "").toLowerCase();
  return ["de", "en", "fr"].includes(lang) ? lang : null;
}
