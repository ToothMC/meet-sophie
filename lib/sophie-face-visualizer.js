/*
 * Sophie Emotion Style Controller
 *
 * Provides per-frame interpolated style (hue/sat, per-bar envelope,
 * brow angles/opacity) for the Knight-Rider visualizer in talk/index.html.
 *
 * The visualizer draws its OWN canvas; this module only holds state +
 * interpolation. The bars keep reacting to the real audio analyser —
 * emotion only shapes how bars are distributed (mouth shape) and what
 * color they are, and whether brows appear on top.
 *
 * Neutral mode: tShape/bShape = 1 everywhere, brow opacity = 0, hue=218,
 * sat=88. Result: bars render identical to today.
 *
 * Attaches `window.SophieEmotionController.create({ barCount })` →
 *   - setEmotion(key)   → target key (neutral|happy|laughing|sad|surprised|angry|skeptical|wink|thinking)
 *   - step()            → advance lerp 1 tick, return current style snapshot:
 *                         { emotion, hue, sat, tShape[], bShape[],
 *                           lA,rA,lY,rY,lW,rW, op, wink }
 */
(function () {
  "use strict";

  // Emotion table — hue/sat + mouth shape key + brow angles/opacity.
  // Values chosen to match the reference demo.
  var EMO = {
    neutral:   { hue:218, sat:88, mouth:'neutral', bL:{a:0,   y:0,   w:1.0 }, bR:{a:0,   y:0,   w:1.0 }, op:0.0,  wink:false },
    happy:     { hue:45,  sat:90, mouth:'smile',   bL:{a:-8,  y:-8,  w:1.0 }, bR:{a:8,   y:-8,  w:1.0 }, op:0.72, wink:false },
    laughing:  { hue:30,  sat:92, mouth:'smile',   bL:{a:-12, y:-14, w:1.1 }, bR:{a:12,  y:-14, w:1.1 }, op:0.85, wink:false },
    sad:       { hue:220, sat:30, mouth:'frown',   bL:{a:-22, y:-4,  w:0.82}, bR:{a:22,  y:-4,  w:0.82}, op:0.68, wink:false },
    surprised: { hue:280, sat:70, mouth:'open',    bL:{a:0,   y:-20, w:1.1 }, bR:{a:0,   y:-20, w:1.1 }, op:0.90, wink:false },
    angry:     { hue:0,   sat:85, mouth:'frown',   bL:{a:22,  y:8,   w:1.0 }, bR:{a:-22, y:8,   w:1.0 }, op:0.95, wink:false },
    skeptical: { hue:160, sat:60, mouth:'neutral', bL:{a:-14, y:-14, w:1.0 }, bR:{a:3,   y:2,   w:1.0 }, op:0.75, wink:false },
    wink:      { hue:45,  sat:90, mouth:'smile',   bL:{a:-10, y:-10, w:1.0 }, bR:{a:4,   y:2,   w:1.0 }, op:0.80, wink:true  },
    thinking:  { hue:55,  sat:75, mouth:'neutral', bL:{a:-2,  y:0,   w:1.0 }, bR:{a:-12, y:-14, w:1.1 }, op:0.65, wink:false }
  };

  // Top-half envelope (0..1) per mouth shape and per-bar normalized position.
  // All shapes (including neutral) taper toward the edges: real lips open
  // most in the center and barely move at the corners, so the outer bars
  // should barely animate regardless of audio level.
  function tEnv(mouth, norm) {
    var d = norm * 2 - 1;                                 // -1..+1
    if (mouth === 'smile') {
      var c = Math.cos(norm * Math.PI);
      return 0.06 + Math.pow(Math.abs(c), 2.0) * 0.94;    // corners up
    }
    if (mouth === 'frown') {
      var s = Math.sin(norm * Math.PI);
      var r = s * s;
      return (r > 0.15 ? (r - 0.15) / 0.85 : 0) * 0.55;   // slight center dip
    }
    if (mouth === 'open') {
      return 0.22 + Math.exp(-d * d * 3) * 0.55;          // "O"
    }
    // neutral / thinking / skeptical: Gaussian — center opens, edges barely
    return 0.05 + Math.exp(-d * d * 4) * 0.95;            // center≈1.0, edge≈0.07
  }

  function bEnv(mouth, norm) {
    var d = norm * 2 - 1;
    if (mouth === 'smile') {
      var s = Math.sin(norm * Math.PI);
      var r = s * s;
      return r > 0.15 ? (r - 0.15) / 0.85 : 0;            // center bottom fills
    }
    if (mouth === 'frown') {
      var c = Math.cos(norm * Math.PI);
      return (0.06 + Math.pow(Math.abs(c), 2.0) * 0.94) * 0.65;
    }
    if (mouth === 'open') {
      return 0.22 + Math.exp(-d * d * 3) * 0.55;
    }
    // neutral mouth — same Gaussian for bottom half (symmetric opening)
    return 0.05 + Math.exp(-d * d * 4) * 0.95;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function createController(opts) {
    var N = (opts && opts.barCount) || 20;
    var LERP_T = 0.055;

    var targetKey = 'neutral';
    var tgt = EMO.neutral;

    function buildShapes(mouth) {
      var tArr = new Array(N), bArr = new Array(N);
      for (var i = 0; i < N; i++) {
        var norm = N > 1 ? i / (N - 1) : 0.5;
        tArr[i] = tEnv(mouth, norm);
        bArr[i] = bEnv(mouth, norm);
      }
      return { t: tArr, b: bArr };
    }

    var tgtShapes = buildShapes(tgt.mouth);

    // Current (interpolated) state — initialised to neutral targets so
    // the very first frame is already "neutral", no startup lerp.
    var cur = {
      emotion: 'neutral',
      hue: tgt.hue, sat: tgt.sat,
      lA: 0, rA: 0, lY: 0, rY: 0, lW: 1, rW: 1,
      op: 0, wink: false,
      tShape: tgtShapes.t.slice(),
      bShape: tgtShapes.b.slice()
    };

    function setEmotion(key) {
      if (!EMO[key]) key = 'neutral';
      if (key === targetKey) return;
      targetKey = key;
      tgt = EMO[key];
      tgtShapes = buildShapes(tgt.mouth);
    }

    function step() {
      cur.emotion = targetKey;
      cur.hue = lerp(cur.hue, tgt.hue, LERP_T);
      cur.sat = lerp(cur.sat, tgt.sat, LERP_T);
      cur.lA  = lerp(cur.lA,  tgt.bL.a, LERP_T);
      cur.rA  = lerp(cur.rA,  tgt.bR.a, LERP_T);
      cur.lY  = lerp(cur.lY,  tgt.bL.y, LERP_T);
      cur.rY  = lerp(cur.rY,  tgt.bR.y, LERP_T);
      cur.lW  = lerp(cur.lW,  tgt.bL.w, LERP_T);
      cur.rW  = lerp(cur.rW,  tgt.bR.w, LERP_T);
      cur.op  = lerp(cur.op,  tgt.op,   LERP_T);
      cur.wink = tgt.wink;  // boolean — snap

      for (var i = 0; i < N; i++) {
        cur.tShape[i] = lerp(cur.tShape[i], tgtShapes.t[i], LERP_T);
        cur.bShape[i] = lerp(cur.bShape[i], tgtShapes.b[i], LERP_T);
      }
      return cur;  // read-only for caller
    }

    return {
      setEmotion: setEmotion,
      getEmotion: function () { return targetKey; },
      step: step
    };
  }

  window.SophieEmotionController = { create: createController };
})();
