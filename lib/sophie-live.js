// lib/sophie-live.js — Browser-Client fuer OpenAI GPT-Live (v1/live/sessions) via WebRTC.
//
// Transport-Schicht, die von Game Night (und spaeter Talk/"Dialog") genutzt wird.
// Unterschiede zur Realtime-API (talk/index.html), die hier gekapselt werden:
//   - Kein Ephemeral-Key: unser Server leitet das SDP-Offer an OpenAI weiter.
//   - Kein Turn-Detection/VAD-Setting: das Modell ist voll-duplex.
//   - Transkripte kommen als Deltas mit start_ms/end_ms ohne Item-ID -> wir
//     gruppieren sie selbst zu Turns.
//   - Tools laufen ueber Delegation: Backend-Events kommen als `response.event`
//     Huelle; fertige Function-Calls stecken in response.output_item.done.
//     Ergebnis zurueck per response.item.create + response.create.
//   - session.usage.updated liefert eine LAUFENDE Summe (ersetzen, nicht addieren).
//
// Muss in vercel.json (/lib/-Allowlist) freigegeben sein, sonst 404.

const TURN_GAP_MS = 1200;      // Luecke zwischen Deltas, ab der ein neuer Turn beginnt
const TURN_FLUSH_MS = 1600;    // Inaktivitaet, nach der ein offener Turn abgeschlossen wird
const ICE_TIMEOUT_MS = 10000;
const CLOSE_TIMEOUT_MS = 15000;

export class SophieLive {
  /**
   * @param {object} opts
   * @param {string} opts.startUrl          Server-Endpoint, der {sdp,...} annimmt und {sdp, session_id} liefert
   * @param {() => Promise<string>|string} opts.getAuthToken  Supabase access token
   * @param {object} [opts.startBody]       Zusaetzliche Felder fuer den Start-Request (mode, lang, voice ...)
   * @param {(name:string, args:object, call:object) => Promise<any>} [opts.onToolCall]
   * @param {(turn:{role:'user'|'assistant', text:string, final:boolean}) => void} [opts.onTranscript]
   * @param {(seconds:number) => void} [opts.onUsage]
   * @param {(state:string, info?:any) => void} [opts.onState]   connecting|ready|closing|closed|error
   * @param {(err:any) => void} [opts.onError]
   * @param {boolean} [opts.suppressAcknowledgements=true]  Haltefloskeln bei Delegation unterdruecken
   */
  constructor(opts) {
    this.opts = { suppressAcknowledgements: true, ...opts };
    this.pc = null;
    this.dc = null;
    this.micStream = null;
    this.remoteStream = null;
    this.audioEl = null;
    this.sessionId = null;
    this.state = "idle";
    this.usageSeconds = 0;
    this.backendUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, responses: 0 };
    this._turns = { user: null, assistant: null };
    this._flushTimers = { user: null, assistant: null };
    this._closeResolve = null;
    this._seq = 0;
    this._handledCalls = new Set();
  }

  _setState(s, info) {
    this.state = s;
    try { this.opts.onState?.(s, info); } catch (e) { console.warn("[sophie-live] onState", e); }
  }

  _eventId(prefix) {
    this._seq += 1;
    return `${prefix}_${Date.now().toString(36)}_${this._seq}`;
  }

  send(evt) {
    if (!this.dc || this.dc.readyState !== "open") return false;
    try {
      this.dc.send(JSON.stringify(evt));
      return true;
    } catch (e) {
      console.warn("[sophie-live] send failed", evt?.type, e);
      return false;
    }
  }

  /** Startet Mikrofon + WebRTC + Server-Handshake. Wirft bei Fehlern. */
  async start() {
    if (this.state !== "idle" && this.state !== "closed") throw new Error("already_started");
    this._setState("connecting");

    // Mic zuerst (iOS: Permission-Prompt muss nah an der User-Geste liegen)
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
    });
    this.pc = pc;

    // Reihenfolge wie in talk/: Track VOR Data-Channel.
    for (const track of this.micStream.getAudioTracks()) pc.addTrack(track, this.micStream);

    // iOS braucht ein Audio-Element im DOM.
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    this.audioEl = audioEl;

    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0];
      audioEl.srcObject = e.streams[0];
      this.opts.onRemoteStream?.(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if ((s === "failed" || s === "disconnected") && this.state === "ready") {
        this.opts.onConnectionIssue?.(s);
      }
      if (s === "failed" && this.state !== "closed") this._teardown("connection_failed");
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => this._onMessage(e.data);
    dc.onclose = () => { if (this.state !== "closed") this._teardown("datachannel_closed"); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIce(pc);

    const token = typeof this.opts.getAuthToken === "function" ? await this.opts.getAuthToken() : this.opts.getAuthToken;
    const resp = await this._postWithRetry(this.opts.startUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...(this.opts.startBody || {}), sdp: pc.localDescription.sdp }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.sdp) {
      const err = new Error(data?.error || `start_failed_${resp.status}`);
      err.status = resp.status;
      err.data = data;
      this._teardown("start_failed");
      throw err;
    }
    this.sessionId = data.session_id || null;
    await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    return data;
  }

  async _postWithRetry(url, init, attempts = 3) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, init);
        if (r.status >= 500 && i < attempts - 1) { await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); continue; }
        return r;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
      }
    }
    throw lastErr || new Error("network_error");
  }

  _waitIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ICE_TIMEOUT_MS);
      function done() {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
      function check() { if (pc.iceGatheringState === "complete") done(); }
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg?.type;
    switch (type) {
      case "session.started":
        this._setState("ready", msg);
        break;
      case "session.input_transcript.delta":
        this._addDelta("user", msg);
        break;
      case "session.output_transcript.delta":
        this._addDelta("assistant", msg);
        break;
      case "session.delegation.created": {
        const id = msg?.delegation?.id ?? msg?.delegation_id ?? null;
        if (this.opts.suppressAcknowledgements && id) {
          this.send({ type: "session.thinking.append", event_id: this._eventId("ack"), delegation_id: id, content: "" });
        }
        this.opts.onDelegation?.(msg);
        break;
      }
      case "response.event":
        this._onBackendEvent(msg);
        break;
      case "session.usage.updated": {
        const s = Number(msg?.usage?.seconds);
        if (Number.isFinite(s)) {
          this.usageSeconds = s; // laufende Summe -> ersetzen
          this.opts.onUsage?.(s);
        }
        break;
      }
      case "session.closed": {
        const s = Number(msg?.usage?.seconds);
        if (Number.isFinite(s)) this.usageSeconds = s;
        this._teardown(msg?.reason || "closed");
        break;
      }
      case "error":
        console.warn("[sophie-live] error event", msg);
        this.opts.onError?.(msg);
        break;
      default:
        this.opts.onRawEvent?.(msg);
    }
  }

  async _onBackendEvent(envelope) {
    const ev = envelope?.event;
    if (!ev) return;
    // Backend-Usage einsammeln (Responses liefert sie am Ende einer Antwort).
    const usage = ev?.response?.usage;
    if (usage && (ev.type === "response.completed" || ev.type === "response.done" || ev.type === "response.incomplete")) {
      this.backendUsage.responses += 1;
      this.backendUsage.input_tokens += Number(usage.input_tokens) || 0;
      this.backendUsage.output_tokens += Number(usage.output_tokens) || 0;
      this.backendUsage.cached_tokens += Number(usage.input_tokens_details?.cached_tokens) || 0;
      this.backendUsage.reasoning_tokens += Number(usage.output_tokens_details?.reasoning_tokens) || 0;
    }
    if (ev.type !== "response.output_item.done") return;
    const item = ev.item;
    if (!item || item.type !== "function_call" || !item.call_id) return;
    if (this._handledCalls.has(item.call_id)) return; // Sideband/Replay-Schutz
    this._handledCalls.add(item.call_id);

    let args = {};
    try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = {}; }
    let result;
    try {
      result = this.opts.onToolCall ? await this.opts.onToolCall(item.name, args, item) : { ok: false, error: "no_handler" };
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    this.send({
      type: "response.item.create",
      event_id: this._eventId("tool"),
      item: { type: "function_call_output", call_id: item.call_id, output: typeof result === "string" ? result : JSON.stringify(result ?? { ok: true }) },
    });
    this.send({ type: "response.create", event_id: this._eventId("cont") });
  }

  _addDelta(role, msg) {
    const text = typeof msg?.delta === "string" ? msg.delta : "";
    if (!text) return;
    const start = Number(msg.start_ms);
    const end = Number(msg.end_ms);
    let turn = this._turns[role];
    // Rollenwechsel schliesst den Turn der anderen Rolle ab.
    const other = role === "user" ? "assistant" : "user";
    if (this._turns[other]) this._flush(other);
    if (turn && Number.isFinite(start) && Number.isFinite(turn.end) && start - turn.end > TURN_GAP_MS) {
      this._flush(role);
      turn = null;
    }
    if (!turn) {
      turn = { role, text: "", start: Number.isFinite(start) ? start : null, end: null };
      this._turns[role] = turn;
    }
    turn.text += text;
    if (Number.isFinite(end)) turn.end = end;
    this.opts.onTranscript?.({ role, text: turn.text, final: false });
    clearTimeout(this._flushTimers[role]);
    this._flushTimers[role] = setTimeout(() => this._flush(role), TURN_FLUSH_MS);
  }

  _flush(role) {
    clearTimeout(this._flushTimers[role]);
    const turn = this._turns[role];
    this._turns[role] = null;
    if (!turn || !turn.text.trim()) return;
    this.opts.onTranscript?.({ role, text: turn.text.trim(), final: true });
  }

  /** Stilles Kontextwissen fuer das Modell (max ~500 Tokens). */
  appendThinking(content, delegationId = null) {
    return this.send({ type: "session.thinking.append", event_id: this._eventId("think"), delegation_id: delegationId, content: String(content || "") });
  }
  /** Inhalt, den das Modell (paraphrasiert) aussprechen soll. */
  appendCommentary(content, delegationId = null) {
    return this.send({ type: "session.commentary.append", event_id: this._eventId("comm"), delegation_id: delegationId, content: String(content || "") });
  }
  /** Steuert das weitere Gespraech. */
  appendInstructions(content) {
    return this.send({ type: "session.instructions.append", event_id: this._eventId("instr"), delegation_id: null, content: String(content || "") });
  }
  mute() { return this.send({ type: "session.input_audio.mute", event_id: this._eventId("mute") }); }
  unmute() { return this.send({ type: "session.input_audio.unmute", event_id: this._eventId("unmute") }); }

  /** Sauber beenden: session.close senden, auf session.closed warten (max 15 s). */
  async close() {
    if (this.state === "closed" || this.state === "idle") return;
    this._setState("closing");
    const closed = new Promise((resolve) => { this._closeResolve = resolve; });
    const sent = this.send({ type: "session.close", event_id: this._eventId("close") });
    if (!sent) { this._teardown("close_without_channel"); return; }
    await Promise.race([closed, new Promise((ok) => setTimeout(ok, CLOSE_TIMEOUT_MS))]);
    if (this.state !== "closed") this._teardown("close_timeout");
  }

  _teardown(reason) {
    if (this.state === "closed") return;
    this._flush("user");
    this._flush("assistant");
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl.remove(); } } catch {}
    this.dc = null;
    this.pc = null;
    this._setState("closed", { reason, usageSeconds: this.usageSeconds });
    this._closeResolve?.();
    this._closeResolve = null;
  }

  getUsage() {
    return { seconds: this.usageSeconds, backend: { ...this.backendUsage } };
  }
}
