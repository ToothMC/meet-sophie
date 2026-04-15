/*
 * Sophie Face Visualizer
 *
 * Pure Canvas 2D face. No eyes-as-circles — face is built from:
 *   - two eyebrows (rotated, angled per emotion)
 *   - mirrored speech-bars forming the mouth (top half + bottom half)
 * The mouth envelope (tEnv/bEnv) shapes the bars into a smile, frown, open O,
 * or neutral — while each bar also animates on its own sine phase so the
 * mouth "talks" while Sophie speaks.
 *
 * Color hue + saturation shift per emotion (happy=yellow, angry=red,
 * sad=desaturated blue, surprised=purple, etc.) and lerp smoothly.
 *
 * Attaches `window.SophieFaceVisualizer.create(canvas)` → instance with:
 *   - setEmotion(key)  → neutral|happy|laughing|sad|surprised|angry|skeptical|wink|thinking
 *   - setActive(bool)  → true while Sophie speaks (mouth bars animate lively)
 *   - stop()           → cancel RAF loop
 */
(function () {
  "use strict";

  var CANVAS_W = 340;
  var CANVAS_H = 280;

  // Mouth geometry
  var N = 20;
  var BAR_W = 9;
  var BAR_GAP = 4;
  var TOTAL_W = N * (BAR_W + BAR_GAP) - BAR_GAP;
  var START_X = (CANVAS_W - TOTAL_W) / 2;
  var MID_Y = 200;
  var TOP_MAX = 28;
  var BOT_MAX = 46;

  // Brow geometry
  var BROW_BASE_Y = 128;
  var BROW_L_X = CANVAS_W * 0.28;
  var BROW_R_X = CANVAS_W * 0.72;
  var BROW_W = 54;
  var BROW_H = 5;

  // Emotion definitions (match reference design):
  //   hue/sat: base HSL for bars + brows
  //   speedM:  mouth-bar animation multiplier
  //   mouth:   'smile' | 'frown' | 'open' | 'neutral'
  //   bL/bR:   brow angle (deg), baseline y-offset, width multiplier
  //   op:      brow opacity
  //   wink:    draw right "brow" as closed-eye arc
  var EMO = {
    neutral:   { hue:218, sat:80, speedM:0.8,  mouth:'neutral',   bL:{a:0,   y:0,   w:1.0}, bR:{a:0,   y:0,   w:1.0}, op:0.45, wink:false },
    happy:     { hue:45,  sat:90, speedM:1.2,  mouth:'smile',     bL:{a:-8,  y:-8,  w:1.0}, bR:{a:8,   y:-8,  w:1.0}, op:0.72, wink:false },
    laughing:  { hue:30,  sat:92, speedM:2.2,  mouth:'smile',     bL:{a:-12, y:-14, w:1.1}, bR:{a:12,  y:-14, w:1.1}, op:0.85, wink:false },
    sad:       { hue:220, sat:30, speedM:0.3,  mouth:'frown',     bL:{a:-22, y:-4,  w:0.82}, bR:{a:22,  y:-4,  w:0.82}, op:0.68, wink:false },
    surprised: { hue:280, sat:70, speedM:1.5,  mouth:'open',      bL:{a:0,   y:-20, w:1.1}, bR:{a:0,   y:-20, w:1.1}, op:0.90, wink:false },
    angry:     { hue:0,   sat:85, speedM:0.4,  mouth:'frown',     bL:{a:22,  y:8,   w:1.0}, bR:{a:-22, y:8,   w:1.0}, op:0.95, wink:false },
    skeptical: { hue:160, sat:60, speedM:0.7,  mouth:'neutral',   bL:{a:-14, y:-14, w:1.0}, bR:{a:3,   y:2,   w:1.0}, op:0.75, wink:false },
    wink:      { hue:45,  sat:90, speedM:1.3,  mouth:'smile',     bL:{a:-10, y:-10, w:1.0}, bR:{a:4,   y:2,   w:1.0}, op:0.80, wink:true  },
    thinking:  { hue:55,  sat:75, speedM:0.5,  mouth:'neutral',   bL:{a:-2,  y:0,   w:1.0}, bR:{a:-12, y:-14, w:1.1}, op:0.65, wink:false }
  };

  // Top-half envelope per mouth shape.
  //   smile: high at edges, low in center (corners up).
  //   frown: reduced middle peak (slight dip).
  //   open:  Gaussian bump in middle.
  //   neutral: small Gaussian bump in middle.
  function tEnv(mouth, norm) {
    if (mouth === 'smile') {
      var c = Math.cos(norm * Math.PI);
      return 0.06 + Math.pow(Math.abs(c), 2.0) * 0.94;
    }
    if (mouth === 'frown') {
      var s = Math.sin(norm * Math.PI);
      var r = s * s;
      return (r > 0.15 ? (r - 0.15) / 0.85 : 0) * 0.55;
    }
    if (mouth === 'open') {
      var d = norm * 2 - 1;
      return 0.22 + Math.exp(-d * d * 3) * 0.55;
    }
    var dn = norm * 2 - 1;
    return Math.exp(-dn * dn * 5) * 0.68;
  }

  // Bottom-half envelope — mirror concept per shape.
  function bEnv(mouth, norm) {
    if (mouth === 'smile') {
      var s = Math.sin(norm * Math.PI);
      var r = s * s;
      return r > 0.15 ? (r - 0.15) / 0.85 : 0;
    }
    if (mouth === 'frown') {
      var c = Math.cos(norm * Math.PI);
      return (0.06 + Math.pow(Math.abs(c), 2.0) * 0.94) * 0.65;
    }
    if (mouth === 'open') {
      var d = norm * 2 - 1;
      return 0.22 + Math.exp(-d * d * 3) * 0.55;
    }
    var dn = norm * 2 - 1;
    return Math.exp(-dn * dn * 5) * 0.68;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function drawBrow(ctx, cx, cy, angle, width, hue, op, closed) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle * Math.PI / 180);
    if (closed) {
      // wink: closed-eye arc instead of brow stroke
      ctx.strokeStyle = 'hsla(' + hue + ',85%,55%,' + op + ')';
      ctx.lineWidth = BROW_H;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 4, 14, Math.PI, 0);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'hsla(' + hue + ',75%,52%,' + op + ')';
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(-width / 2, -BROW_H / 2, width, BROW_H, 2);
      } else {
        ctx.rect(-width / 2, -BROW_H / 2, width, BROW_H);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function create(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width  = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width  = CANVAS_W + 'px';
    canvas.style.height = CANVAS_H + 'px';
    ctx.scale(dpr, dpr);

    // Per-bar phase + speed (persistent between frames for continuous motion)
    var phases = new Array(N);
    var speeds = new Array(N);
    for (var i = 0; i < N; i++) {
      phases[i] = Math.random() * Math.PI * 2;
      var d = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
      speeds[i] = 0.05 + Math.random() * 0.04 + d * 0.02;
    }

    // Interpolated state (for smooth emotion transitions)
    var cur = { lA: 0, rA: 0, lY: 0, rY: 0, lW: 1, rW: 1, op: 0.45 };
    var curHue = 218;
    var curSat = 80;

    var state = {
      emotion:  'neutral',
      isActive: false,
      running:  false,
      rafId:    null
    };

    // Parent wrap is toggled so "neutral" means the face is completely
    // hidden — the existing Knight-Rider bars stand alone, unchanged.
    var wrap = canvas.parentElement;
    function applyVisibility() {
      if (!wrap) return;
      var visible = state.emotion !== 'neutral';
      wrap.style.display = visible ? 'flex' : 'none';
    }
    applyVisibility();

    function tick() {
      if (!state.running) return;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      var cfg = EMO[state.emotion] || EMO.neutral;
      var t = 0.055;

      // Idle multiplier: bars still "breathe" gently when Sophie isn't speaking
      var activityM = state.isActive ? 1.0 : 0.28;

      // Interpolate brow + color state
      cur.lA = lerp(cur.lA, cfg.bL.a, t);
      cur.rA = lerp(cur.rA, cfg.bR.a, t);
      cur.lY = lerp(cur.lY, cfg.bL.y, t);
      cur.rY = lerp(cur.rY, cfg.bR.y, t);
      cur.lW = lerp(cur.lW, cfg.bL.w, t);
      cur.rW = lerp(cur.rW, cfg.bR.w, t);
      cur.op = lerp(cur.op, cfg.op, t);
      curHue = lerp(curHue, cfg.hue, t);
      curSat = lerp(curSat, cfg.sat, t);

      // Brows (right brow may be a closed eye in wink)
      drawBrow(ctx, BROW_L_X, BROW_BASE_Y + cur.lY, cur.lA, BROW_W * cur.lW, curHue, cur.op, false);
      drawBrow(ctx, BROW_R_X, BROW_BASE_Y + cur.rY, cur.rA, BROW_W * cur.rW, curHue, cur.op, cfg.wink);

      // Mouth centerline
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(START_X, MID_Y, TOTAL_W, 1);

      // Mouth bars — mirrored top + bottom
      for (var j = 0; j < N; j++) {
        phases[j] += speeds[j] * cfg.speedM * activityM;

        var wave = (Math.sin(phases[j]) * 0.5 + 0.5) * 0.72
                 + (Math.sin(phases[j] * 2.1 + j * 0.5) * 0.5 + 0.5) * 0.28;

        var norm = j / (N - 1);
        var te = tEnv(cfg.mouth, norm);
        var be = bEnv(cfg.mouth, norm);

        // Keep expression shape steady: outer bars nearly frozen for smile/frown,
        // so the emotion reads clearly while inner bars animate with "speech".
        var waveT = wave, waveB = wave;
        if (cfg.mouth === 'smile') {
          waveT = 0.88 + wave * (1 - te) * 0.12;
          waveB = wave;
        } else if (cfg.mouth === 'frown') {
          waveT = wave;
          waveB = 0.88 + wave * (1 - be) * 0.12;
        }

        var hT = Math.max(2, TOP_MAX * waveT * te);
        var hB = Math.max(2, BOT_MAX * waveB * be);
        var x  = START_X + j * (BAR_W + BAR_GAP);

        var lightT = Math.round(28 + te * 32);
        ctx.fillStyle = 'hsl(' + curHue + ',' + curSat + '%,' + lightT + '%)';
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, MID_Y - hT, BAR_W, hT, [3, 3, 0, 0]);
        } else {
          ctx.rect(x, MID_Y - hT, BAR_W, hT);
        }
        ctx.fill();

        var lightB = Math.round(28 + be * 32);
        ctx.fillStyle = 'hsl(' + curHue + ',' + curSat + '%,' + lightB + '%)';
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, MID_Y, BAR_W, hB, [0, 0, 3, 3]);
        } else {
          ctx.rect(x, MID_Y, BAR_W, hB);
        }
        ctx.fill();
      }

      state.rafId = requestAnimationFrame(tick);
    }

    function start() {
      if (state.running) return;
      state.running = true;
      // Render one frame synchronously so the face is visible immediately
      // on emotion change (don't wait for the first RAF tick).
      tick();
    }
    function pause() {
      state.running = false;
      if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    }

    return {
      setEmotion: function (e) {
        var next = (e && EMO[e]) ? e : 'neutral';
        if (next === state.emotion) return;
        state.emotion = next;
        applyVisibility();
        if (next === 'neutral') {
          pause();       // hide face + free CPU, Knight-Rider bars unchanged
        } else {
          start();       // resume RAF for lerp + bar animation
        }
      },
      setActive: function (a) {
        state.isActive = !!a;
      },
      stop: function () {
        pause();
      }
    };
  }

  window.SophieFaceVisualizer = { create: create };
})();
