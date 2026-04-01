/**
 * sophie-tab-manager.js
 *
 * Single-primary-tab architecture for Sophie.
 *
 * Invariants:
 *   1. `sophie-primary` Web Lock = sole authority for who is primary.
 *   2. `sophie-realtime` Web Lock may only be held by the primary holder.
 *      Acquire order: primary → realtime.  Release order: realtime → primary.
 *   3. BroadcastChannel is trusted only within the same storage partition
 *      (normal browser tabs). NOT trusted across Safari ↔ iOS PWA boundary.
 *   4. localStorage heartbeat is visibility/UI only, never authority.
 *   5. Takeover is explicit: TAKEOVER_REQUEST → old primary releases → new primary acquires.
 *
 * Usage:
 *   import { SophieTabManager } from "/lib/sophie-tab-manager.js";
 *   const tabs = new SophieTabManager({
 *     onBecamePrimary:  () => { ... },
 *     onLostPrimary:    () => { ... },
 *     onAuthCompleted:  (userId) => { ... },
 *     onDuplicateTab:   () => { ... },  // another primary exists
 *   });
 *   await tabs.init();
 *
 *   // Before starting voice/realtime:
 *   const got = await tabs.acquireRealtime();  // true | false
 *
 *   // When user clicks "Take over here":
 *   const took = await tabs.requestTakeover();
 *
 *   // On page unload:
 *   tabs.destroy();
 */

const CHANNEL_NAME = "sophie-tabs";
const PRIMARY_LOCK = "sophie-primary";
const REALTIME_LOCK = "sophie-realtime";
const HEARTBEAT_KEY = "sophie-tab-heartbeat";
const HEARTBEAT_INTERVAL = 2000;   // ms
const HEARTBEAT_STALE    = 6000;   // ms — consider dead after this

// ── helpers ──────────────────────────────────────────────────────────

function tabId() {
  // Unique per page load — survives no navigations
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

function hasWebLocks() {
  return typeof navigator !== "undefined" && "locks" in navigator;
}

function hasBroadcastChannel() {
  return typeof BroadcastChannel !== "undefined";
}

// ── iOS standalone detection ─────────────────────────────────────────

export function isIOSStandalone() {
  if (typeof window === "undefined") return false;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
                    || window.navigator.standalone === true;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
             || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isStandalone && isIOS;
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
}

// ── main class ───────────────────────────────────────────────────────

export class SophieTabManager {
  #id;
  #bc = null;
  #isPrimary = false;
  #hasRealtime = false;
  #heartbeatTimer = null;
  #primaryLockHeld = null;      // AbortController for the primary lock
  #realtimeLockHeld = null;     // AbortController for the realtime lock
  #destroyed = false;

  // callbacks
  #onBecamePrimary;
  #onLostPrimary;
  #onAuthCompleted;
  #onDuplicateTab;

  constructor(opts = {}) {
    this.#id = tabId();
    this.#onBecamePrimary = opts.onBecamePrimary  || (() => {});
    this.#onLostPrimary   = opts.onLostPrimary    || (() => {});
    this.#onAuthCompleted = opts.onAuthCompleted   || (() => {});
    this.#onDuplicateTab  = opts.onDuplicateTab   || (() => {});
  }

  get id()         { return this.#id; }
  get isPrimary()  { return this.#isPrimary; }
  get hasRealtime(){ return this.#hasRealtime; }

  // ── lifecycle ────────────────────────────────────────────────────

  async init() {
    // 1. Set up BroadcastChannel (same-partition tabs only)
    if (hasBroadcastChannel()) {
      this.#bc = new BroadcastChannel(CHANNEL_NAME);
      this.#bc.onmessage = (e) => this.#handleMessage(e.data);
    }

    // 2. Listen for cross-tab storage events (fallback for auth handover)
    window.addEventListener("storage", (e) => this.#handleStorageEvent(e));

    // 3. Try to become primary
    await this.#tryBecomePrimary();

    // 4. Page lifecycle
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.#isPrimary) {
        // Tab became visible — don't auto-steal, just check status
        this.#checkHeartbeat();
      }
    });

    window.addEventListener("beforeunload", () => this.destroy());
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;

    // Release order: realtime first, then primary
    this.#releaseRealtime();
    this.#releasePrimary();

    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }

    if (this.#bc) {
      try { this.#bc.close(); } catch {}
      this.#bc = null;
    }

    // Clear heartbeat from localStorage
    try { localStorage.removeItem(HEARTBEAT_KEY); } catch {}
  }

  // ── primary lock ─────────────────────────────────────────────────

  async #tryBecomePrimary() {
    if (!hasWebLocks()) {
      // Fallback: use localStorage lease
      return this.#tryBecomePrimaryFallback();
    }

    // Try non-blocking first: ifAvailable = true
    const granted = await new Promise((resolve) => {
      navigator.locks.request(PRIMARY_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          // Someone else holds primary
          resolve(false);
          return;  // release immediately
        }
        // We got it — hold it by returning a never-resolving promise
        // that resolves when our AbortController fires
        resolve(true);
        return new Promise((releaseLock) => {
          this.#primaryLockHeld = { release: releaseLock };
        });
      });
    });

    if (granted) {
      this.#becomePrimary();
    } else {
      this.#onDuplicateTab();
    }
  }

  #becomePrimary() {
    this.#isPrimary = true;
    this.#startHeartbeat();
    this.#broadcast({ type: "PRIMARY_ANNOUNCED", tabId: this.#id });
    this.#onBecamePrimary();
  }

  #releasePrimary() {
    if (this.#primaryLockHeld) {
      this.#primaryLockHeld.release();
      this.#primaryLockHeld = null;
    }
    if (this.#isPrimary) {
      this.#isPrimary = false;
      if (this.#heartbeatTimer) {
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = null;
      }
      this.#onLostPrimary();
    }
  }

  // ── fallback primary (no Web Locks) ──────────────────────────────

  async #tryBecomePrimaryFallback() {
    // Simple localStorage lease: write our id + timestamp, check if we win
    const now = Date.now();
    const existing = this.#readHeartbeat();

    if (existing && (now - existing.ts) < HEARTBEAT_STALE) {
      // Someone else is alive
      this.#onDuplicateTab();
      // Start polling to detect when they die
      this.#heartbeatTimer = setInterval(() => this.#checkHeartbeat(), HEARTBEAT_INTERVAL);
      return;
    }

    // No one alive — claim it
    this.#becomePrimary();
  }

  // ── realtime lock ────────────────────────────────────────────────

  /**
   * Acquire the realtime lock. Only call this when isPrimary === true.
   * Returns true if acquired, false if unavailable or not primary.
   * Uses ifAvailable: true — never blocks the UI.
   */
  async acquireRealtime() {
    if (!this.#isPrimary) return false;
    if (this.#hasRealtime) return true;

    if (!hasWebLocks()) {
      // Fallback: just grant it if we're primary (single-source-of-truth via heartbeat)
      this.#hasRealtime = true;
      return true;
    }

    const granted = await new Promise((resolve) => {
      navigator.locks.request(REALTIME_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        return new Promise((releaseLock) => {
          this.#realtimeLockHeld = { release: releaseLock };
        });
      });
    });

    if (granted) {
      this.#hasRealtime = true;
    }
    return granted;
  }

  #releaseRealtime() {
    if (this.#realtimeLockHeld) {
      this.#realtimeLockHeld.release();
      this.#realtimeLockHeld = null;
    }
    this.#hasRealtime = false;
  }

  // ── takeover protocol ────────────────────────────────────────────

  /**
   * Request takeover from the current primary.
   * Sends TAKEOVER_REQUEST, waits up to 3s for the old primary to release,
   * then tries to acquire.
   */
  async requestTakeover() {
    if (this.#isPrimary) return true;  // already primary

    // Step 1: Ask the current primary to release
    this.#broadcast({ type: "TAKEOVER_REQUEST", fromTabId: this.#id });

    // Step 2: Wait briefly, then try to grab the lock
    // The old primary should release within ~500ms of receiving the request.
    // We use a short timeout AbortController so the UI doesn't hang.
    if (!hasWebLocks()) {
      // Fallback: wait a beat, then try localStorage claim
      await new Promise(r => setTimeout(r, 800));
      return this.#tryBecomePrimaryFallback().then(() => this.#isPrimary);
    }

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 3000);

    try {
      const granted = await new Promise((resolve) => {
        navigator.locks.request(PRIMARY_LOCK, { signal: ac.signal }, (lock) => {
          if (!lock) { resolve(false); return; }
          resolve(true);
          return new Promise((releaseLock) => {
            this.#primaryLockHeld = { release: releaseLock };
          });
        }).catch(() => resolve(false));  // AbortError
      });

      clearTimeout(timeout);

      if (granted) {
        this.#becomePrimary();
        return true;
      }
    } catch {
      clearTimeout(timeout);
    }

    return false;
  }

  // ── auth broadcast ───────────────────────────────────────────────

  /**
   * Call from /auth/callback after successful token exchange.
   * Sends AUTH_COMPLETED to all tabs in the same storage partition.
   */
  broadcastAuthCompleted(userId) {
    this.#broadcast({ type: "AUTH_COMPLETED", userId });
    // Also write to localStorage for cross-tab fallback
    try {
      localStorage.setItem("sophie-auth-event", JSON.stringify({
        type: "AUTH_COMPLETED",
        userId,
        ts: Date.now()
      }));
    } catch {}
  }

  // ── heartbeat (visibility only) ──────────────────────────────────

  #startHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#writeHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#isPrimary) {
        this.#writeHeartbeat();
      }
    }, HEARTBEAT_INTERVAL);
  }

  #writeHeartbeat() {
    try {
      localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({
        tabId: this.#id,
        ts: Date.now()
      }));
    } catch {}
  }

  #readHeartbeat() {
    try {
      const raw = localStorage.getItem(HEARTBEAT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  #checkHeartbeat() {
    if (this.#isPrimary || this.#destroyed) return;

    // Only relevant as fallback when Web Locks aren't available
    if (hasWebLocks()) return;

    const hb = this.#readHeartbeat();
    if (!hb || (Date.now() - hb.ts) > HEARTBEAT_STALE) {
      // Old primary is dead — try to claim
      this.#tryBecomePrimaryFallback();
    }
  }

  // ── messaging ────────────────────────────────────────────────────

  #broadcast(msg) {
    if (this.#bc) {
      try { this.#bc.postMessage(msg); } catch {}
    }
  }

  #handleMessage(msg) {
    if (this.#destroyed) return;

    switch (msg.type) {
      case "TAKEOVER_REQUEST":
        if (this.#isPrimary && msg.fromTabId !== this.#id) {
          // Release in correct order: realtime first, then primary
          this.#releaseRealtime();
          this.#releasePrimary();
          // Notify this tab's UI that it lost primary
          this.#broadcast({ type: "PRIMARY_RELEASED", byTabId: this.#id });
        }
        break;

      case "PRIMARY_ANNOUNCED":
        if (!this.#isPrimary && msg.tabId !== this.#id) {
          // Another tab became primary — we are secondary
          this.#onDuplicateTab();
        }
        break;

      case "AUTH_COMPLETED":
        this.#onAuthCompleted(msg.userId);
        break;
    }
  }

  #handleStorageEvent(e) {
    if (this.#destroyed) return;

    // Fallback auth handover via localStorage
    if (e.key === "sophie-auth-event" && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        if (data.type === "AUTH_COMPLETED") {
          this.#onAuthCompleted(data.userId);
        }
      } catch {}
    }
  }
}
