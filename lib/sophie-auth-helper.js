/**
 * sophie-auth-helper.js
 *
 * Auth flow: Email OTP only (no magic links).
 * User receives a code via email, enters it in-app.
 * Works reliably on all platforms: desktop, mobile, PWA.
 */

/**
 * Always true — OTP-only flow for all platforms.
 * Magic links removed: they caused Gmail forwarding issues,
 * dual-tab problems, iOS PWA storage isolation, and token consumption by link scanners.
 */
export function shouldUseOTP() {
  return true;
}

// Global dedup: prevent multiple OTP sends for the same email within 30s.
// Each call to signInWithOtp generates a NEW code and invalidates the previous one.
// Multiple UI paths (inline capture, auth bar, resend) can trigger this for the same email.
let _lastOtpSend = { email: null, ts: 0 };

/**
 * Send an OTP code email. No magic link, no emailRedirectTo.
 *
 * @param {object} supabase - Supabase client
 * @param {string} email
 * @param {string} [_redirectUrl] - Ignored (kept for API compat)
 * @param {object} [opts] - Options
 * @param {boolean} [opts.forceResend] - Skip dedup guard (explicit resend)
 * @returns {Promise<{error: object|null, method: "otp"}>}
 */
export async function sendAuthEmail(supabase, email, _redirectUrl, opts) {
  const normalizedEmail = email.trim().toLowerCase();

  // Dedup guard: skip if same email was sent within 30s (unless explicit resend)
  if (!opts?.forceResend && _lastOtpSend.email === normalizedEmail
      && Date.now() - _lastOtpSend.ts < 30000) {
    return { error: null, method: "otp" };
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (!error) _lastOtpSend = { email: normalizedEmail, ts: Date.now() };
  return { error, method: "otp" };
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
  // Strip whitespace and non-digit chars (copy-paste from styled emails can add spaces)
  const cleanToken = token.replace(/\D/g, "");

  // Supabase stores the OTP in recovery_token for existing users (action: user_recovery_requested).
  // Try all applicable verify types until one succeeds.
  for (const type of ["email", "magiclink", "recovery"]) {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: cleanToken,
      type,
    });
    if (!error) return { data, error: null };
    // If this type returned a non-token error (e.g. rate limit), return immediately
    if (!/expired|invalid|not found/i.test(error.message || "")) {
      return { data: null, error };
    }
  }
  // All types failed
  return { data: null, error: { message: "Code expired or invalid" } };
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
