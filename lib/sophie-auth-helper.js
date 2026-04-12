/**
 * sophie-auth-helper.js
 *
 * Platform-aware auth flow:
 *   - Desktop / normal browser / Android: Magic Link (emailRedirectTo → /auth/callback)
 *   - iOS installed PWA (standalone): Email OTP (6-digit code entered in-app)
 *
 * OTP avoids the Safari ↔ PWA storage isolation problem on iOS.
 * Supabase signInWithOtp() supports both modes via the same endpoint.
 */

import { isIOSStandalone } from "/lib/sophie-tab-manager.js";

/**
 * Determine whether to use OTP code input instead of magic link.
 * Returns true for iOS standalone PWA where magic link would open in Safari
 * (isolated storage partition — session wouldn't reach the PWA).
 */
export function shouldUseOTP() {
  if (isIOSStandalone()) return true;
  // All mobile browsers: OTP avoids the magic link dual-tab problem
  // (in-app browser, tab isolation, token consumed in wrong context)
  if (typeof navigator !== "undefined") {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  return false;
}

// Global dedup: prevent multiple OTP sends for the same email within 30s.
// Each call to signInWithOtp generates a NEW code and invalidates the previous one.
// Multiple UI paths (inline capture, auth bar, resend) can trigger this for the same email.
let _lastOtpSend = { email: null, ts: 0 };

/**
 * Send an auth email. Depending on platform, sends either:
 *   - Magic link (default) → user clicks link → /auth/callback handles session
 *   - OTP code (iOS PWA) → user receives 6-digit code → verify in-app
 *
 * @param {object} supabase - Supabase client
 * @param {string} email
 * @param {string} redirectUrl - Only used for magic link flow
 * @param {object} [opts] - Options
 * @param {boolean} [opts.forceResend] - Skip dedup guard (explicit resend)
 * @returns {Promise<{error: object|null, method: "magiclink"|"otp"}>}
 */
export async function sendAuthEmail(supabase, email, redirectUrl, opts) {
  const useOTP = shouldUseOTP();
  const normalizedEmail = email.trim().toLowerCase();

  // DEBUG: trace every call to find double-send source
  console.warn("[sendAuthEmail] called for:", normalizedEmail, "method:", useOTP ? "otp" : "magiclink", "stack:", new Error().stack);

  // Dedup guard: skip if same email was sent within 30s (unless explicit resend)
  if (!opts?.forceResend && _lastOtpSend.email === normalizedEmail
      && Date.now() - _lastOtpSend.ts < 30000) {
    console.warn("[sendAuthEmail] BLOCKED — duplicate within 30s");
    return { error: null, method: useOTP ? "otp" : "magiclink" };
  }

  if (useOTP) {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      }
    });
    if (!error) _lastOtpSend = { email: normalizedEmail, ts: Date.now() };
    return { error, method: "otp" };
  }

  // Default: magic link
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectUrl,
      shouldCreateUser: true,
    }
  });
  if (!error) _lastOtpSend = { email: normalizedEmail, ts: Date.now() };
  return { error, method: "magiclink" };
}

/**
 * Verify an OTP code (iOS PWA flow).
 *
 * @param {object} supabase - Supabase client
 * @param {string} email
 * @param {string} token - 6-digit code from email
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
export async function verifyOTP(supabase, email, token) {
  // Try "email" first (pure OTP flow, no emailRedirectTo)
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email"
  });
  if (!error) return { data, error: null };

  // Fallback: try "magiclink" (token from a magic link email)
  const { data: data2, error: error2 } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "magiclink"
  });
  return { data: data2, error: error2 };
}

/* ── Auth-Guard Helpers ────────────────────────────────────────── */

const SB_STORAGE_KEY = "sb-ohzfojsbmzinpxhcynpt-auth-token";

/**
 * Synchronous check: does a Supabase session token exist in localStorage?
 * Use in <head> scripts for anti-flash redirects.
 * This does NOT validate the token — it only checks presence.
 */
export function hasStoredSession() {
  try {
    const stored = localStorage.getItem(SB_STORAGE_KEY);
    if (!stored) return false;
    const parsed = JSON.parse(stored);
    return !!(parsed?.access_token || parsed?.currentSession?.access_token);
  } catch {
    return false;
  }
}

/**
 * Async authoritative session check via Supabase client.
 * @param {object} supabase - Supabase client instance
 * @returns {Promise<object|null>} session object or null
 */
export async function getSessionOrNull(supabase) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ? session : null;
  } catch {
    return null;
  }
}

/**
 * Redirect authenticated users away (e.g. from Landing to /app).
 * @param {object} supabase - Supabase client instance
 * @param {string} target - URL to redirect to
 * @returns {Promise<boolean>} true if redirected
 */
export async function redirectIfAuthenticated(supabase, target) {
  const session = await getSessionOrNull(supabase);
  if (session) {
    window.location.replace(target);
    return true;
  }
  return false;
}

/**
 * Redirect anonymous users away (e.g. from /app to Landing).
 * @param {object} supabase - Supabase client instance
 * @param {string} target - URL to redirect to
 * @returns {Promise<boolean>} true if redirected
 */
export async function redirectIfAnonymous(supabase, target) {
  const session = await getSessionOrNull(supabase);
  if (!session) {
    window.location.replace(target);
    return true;
  }
  return false;
}

/**
 * OTP-related UI labels.
 */
export const OTP_LABELS = {
  en: {
    codeSent: (email) => `I sent a code to ${email}. Enter it here:`,
    codePlaceholder: "Code",
    verifyBtn: "Verify",
    verifying: "Verifying…",
    wrongCode: "Wrong code. Try again?",
    expired: "Code expired. Send a new one?",
    resend: "Resend code",
    resent: "New code sent!",
  },
  de: {
    codeSent: (email) => `Ich habe dir einen Code an ${email} geschickt. Gib ihn hier ein:`,
    codePlaceholder: "Code",
    verifyBtn: "Bestätigen",
    verifying: "Wird geprüft…",
    wrongCode: "Falscher Code. Nochmal versuchen?",
    expired: "Code abgelaufen. Neuen senden?",
    resend: "Code erneut senden",
    resent: "Neuer Code gesendet!",
  },
  fr: {
    codeSent: (email) => `Je t'ai envoyé un code à ${email}. Entre-le ici :`,
    codePlaceholder: "Code",
    verifyBtn: "Vérifier",
    verifying: "Vérification…",
    wrongCode: "Mauvais code. Réessayer ?",
    expired: "Code expiré. En envoyer un nouveau ?",
    resend: "Renvoyer le code",
    resent: "Nouveau code envoyé !",
  }
};
