/*
 * Sophie Face Visualizer
 *
 * Pure Canvas 2D face renderer. No React, no dependencies.
 * Attaches `window.SophieFaceVisualizer.create(canvas)` → instance with:
 *   - setEmotion(key)   → string (neutral|happy|laughing|sad|surprised|angry|skeptical|wink|thinking)
 *   - setActive(bool)   → true while Sophie is speaking (animates mouth bars)
 *   - stop()            → cancels RAF loop (call on cleanup)
 *
 * Design: two round eyes, two short eyebrow strokes (angled per emotion),
 * mouth as small bar visualizer (curvature per emotion, pulses when active).
 * Color palette matches the Knight Rider bars (hsl 218°).
 */
(function () {
  "use strict";

  var FACE = {
    width:   320,
    height:  140,
    eyeY:     58,
    eyeGap:   74,
    eyeR:      9,
    browY:    34,
    browW:    30,
    browH:     4,
    mouthY:  104,
    mouthBarCount: 9,
    mouthBarW: 5,
    mouthBarGap: 6,
    mouthMaxH: 20,
    mouthMinH: 3
  };

  // Brow offset table (dy per end-point, relative to browY, px).
  // { L/R: { i: innerDy, o: outerDy } }  — positive dy = lower on screen.
  var BROWS = {
    neutral:   { L: { i:  0, o:  0 }, R: { i:  0, o:  0 } },
    happy:     { L: { i:  3, o: -4 }, R: { i:  3, o: -4 } },
    laughing:  { L: { i:  5, o: -7 }, R: { i:  5, o: -7 } },
    sad:       { L: { i: -7, o:  3 }, R: { i: -7, o:  3 } },
    surprised: { L: { i: -9, o: -9 }, R: { i: -9, o: -9 } },
    angry:     { L: { i:  6, o: -4 }, R: { i:  6, o: -4 } },
    skeptical: { L: { i:  0, o:  0 }, R: { i: -7, o:  5 } },
    wink:      { L: { i:  0, o:  0 }, R: { i: -8, o: -4 } },
    thinking:  { L: { i:  0, o:  0 }, R: { i: -8, o: -11 } }
  };

  // Mouth curvature: +1 = big smile, 0 = flat, -1 = frown.
  var MOUTH_CURVE = {
    neutral:    0,
    happy:      0.5,
    laughing:   0.65,
    sad:       -0.45,
    surprised:  0,
    angry:     -0.3,
    skeptical:  0.1,
    wink:       0.3,
    thinking:   0
  };

  function drawEye(ctx, x, y, emotion, side) {
    var r = FACE.eyeR;

    if (emotion === "wink" && side === "R") {
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.stroke();
      return;
    }

    if (emotion === "laughing") {
      // upside-down U for "^^" smile eyes
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(x, y + r * 0.4, r, Math.PI * 1.1, Math.PI * 1.9, false);
      ctx.stroke();
      return;
    }

    if (emotion === "angry") {
      // narrow ellipse
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (emotion === "surprised") {
      ctx.beginPath();
      ctx.arc(x, y, r * 1.25, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // default round eye
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBrow(ctx, eyeX, baseY, offs, side) {
    var w = FACE.browW, h = FACE.browH;
    // inner end is towards face center: for left eye inner = +x, for right inner = -x
    var innerDir = (side === "L") ? 1 : -1;
    var innerX = eyeX + innerDir * (w / 2);
    var outerX = eyeX - innerDir * (w / 2);
    var innerY = baseY + offs.i;
    var outerY = baseY + offs.o;

    ctx.lineWidth = h;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(outerX, outerY);
    ctx.lineTo(innerX, innerY);
    ctx.stroke();
  }

  function drawMouth(ctx, cx, cy, emotion, isActive, phase) {
    // "surprised" gets an open O
    if (emotion === "surprised") {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy + 4, 11, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    var curve = MOUTH_CURVE[emotion];
    if (typeof curve !== "number") curve = 0;

    var N     = FACE.mouthBarCount;
    var barW  = FACE.mouthBarW;
    var gap   = FACE.mouthBarGap;
    var maxH  = FACE.mouthMaxH;
    var minH  = FACE.mouthMinH;
    var totalW = N * barW + (N - 1) * gap;
    var startX = cx - totalW / 2 + barW / 2;

    for (var i = 0; i < N; i++) {
      var t = (i - (N - 1) / 2) / ((N - 1) / 2); // -1..+1
      var yShift = curve * (1 - t * t) * 10;     // parabolic — smile lifts center
      var level;
      if (isActive) {
        // pseudo-speech animation: each bar a phase-shifted sine
        level = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(phase + i * 0.85));
      } else {
        level = 0.22;
      }
      var h = minH + (maxH - minH) * level;
      var x = startX + i * (barW + gap) - barW / 2;
      var yTop = (cy - yShift) - h / 2;
      // rounded bar via fillRect (fast)
      ctx.fillRect(x, yTop, barW, h);
    }
  }

  function renderFrame(ctx, state) {
    var W = FACE.width, H = FACE.height;
    ctx.clearRect(0, 0, W, H);

    var cx = W / 2;
    var eyeLx = cx - FACE.eyeGap / 2;
    var eyeRx = cx + FACE.eyeGap / 2;

    ctx.save();
    ctx.fillStyle   = "hsl(218, 88%, 68%)";
    ctx.strokeStyle = "hsl(218, 88%, 68%)";
    ctx.shadowColor = "hsla(218, 92%, 70%, 0.35)";
    ctx.shadowBlur  = 10;

    var emo = state.emotion;
    drawEye(ctx, eyeLx, FACE.eyeY, emo, "L");
    drawEye(ctx, eyeRx, FACE.eyeY, emo, "R");

    var b = BROWS[emo] || BROWS.neutral;
    drawBrow(ctx, eyeLx, FACE.browY, b.L, "L");
    drawBrow(ctx, eyeRx, FACE.browY, b.R, "R");

    drawMouth(ctx, cx, FACE.mouthY, emo, state.isActive, state.phase);

    ctx.restore();
  }

  function create(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext("2d");
    var dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width  = FACE.width  * dpr;
    canvas.height = FACE.height * dpr;
    canvas.style.width  = FACE.width  + "px";
    canvas.style.height = FACE.height + "px";
    ctx.scale(dpr, dpr);

    var state = {
      emotion:   "neutral",
      isActive:  false,
      phase:     0,
      running:   false,
      rafId:     null,
      lastFrame: 0
    };

    function loop(now) {
      if (!state.running) return;
      // throttle to ~30fps
      if (now - state.lastFrame < 33) {
        state.rafId = requestAnimationFrame(loop);
        return;
      }
      state.lastFrame = now;
      state.phase += 0.28;
      renderFrame(ctx, state);
      state.rafId = requestAnimationFrame(loop);
    }

    // paint an initial idle frame so the face is visible before anyone speaks
    renderFrame(ctx, state);

    return {
      setEmotion: function (e) {
        state.emotion = e || "neutral";
        if (!state.running) renderFrame(ctx, state);
      },
      setActive: function (a) {
        var on = !!a;
        if (on === state.isActive) return;
        state.isActive = on;
        if (on && !state.running) {
          state.running = true;
          state.rafId = requestAnimationFrame(loop);
        } else if (!on && state.running) {
          state.running = false;
          if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
          renderFrame(ctx, state);
        }
      },
      stop: function () {
        state.running = false;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
      }
    };
  }

  window.SophieFaceVisualizer = { create: create };
})();
