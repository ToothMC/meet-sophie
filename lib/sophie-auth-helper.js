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
  return isIOSStandalone();
}

/**
 * Send an auth email. Depending on platform, sends either:
 *   - Magic link (default) → user clicks link → /auth/callback handles session
 *   - OTP code (iOS PWA) → user receives 6-digit code → verify in-app
 *
 * @param {object} supabase - Supabase client
 * @param {string} email
 * @param {string} redirectUrl - Only used for magic link flow
 * @returns {Promise<{error: object|null, method: "magiclink"|"otp"}>}
 */
export async function sendAuthEmail(supabase, email, redirectUrl) {
  const useOTP = shouldUseOTP();

  if (useOTP) {
    // iOS standalone: send OTP code (Supabase uses {{ .Token }} template)
    // No emailRedirectTo — code is entered directly in the app
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      }
    });
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
