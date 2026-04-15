/*
 * Sophie Emotion Detection
 *
 * Local, zero-cost, zero-latency regex-based emotion classifier.
 * Attaches `window.SophieEmotion` with:
 *   - detectEmotion(text)               → string emotion key
 *   - detectEmotionDelayed(text, setter, delayMs)
 *   - resetEmotion(setter, delayMs)
 *
 * Emotion keys: neutral | happy | laughing | sad | surprised | angry | skeptical | wink | thinking
 */
(function () {
  "use strict";

  // Patterns ordered by priority (first match wins).
  // `laughing` before `happy`, `surprised` before `skeptical`, etc.
  var RULES = [
    { emotion: "laughing",  pattern: /\b(haha+|hehe+|lol+|rofl|lmao|witzig|lustig|hilarious|funny)\b|😂|🤣/i },
    { emotion: "wink",      pattern: /😉|\b(ironisch|scherz|just kidding|kidding|jk)\b/i },
    { emotion: "surprised", pattern: /\b(wow|echt\?|really\?|no way|unglaublich|incredible|amazing|krass|wahnsinn|ohne scheiß)\b|was\?!|😲|😮|😯/i },
    { emotion: "skeptical", pattern: /\b(sicher\?|bist du sicher|stimmt das|wirklich\?|doubt|zweifle|skeptisch|ehrlich\?|naja)\b/i },
    { emotion: "angry",     pattern: /\b(nervt|frustriert|geht nicht|angry|pissed|scheiße|scheisse|hate|wütend|wuetend|annoying|nervig|fuck|hasse|kotzt)\b|😠|😡|🤬/i },
    { emotion: "sad",       pattern: /\b(traurig|sad|leider|schade|sorry|bad|difficult|hard|struggling|schwierig|problem|weinen|depressed|down|einsam|lonely|enttäuscht|enttaeuscht)\b|😢|😭|☹️/i },
    { emotion: "happy",     pattern: /\b(danke|thanks|thank you|super|toll|klasse|großartig|grossartig|great|perfect|perfekt|awesome|love|geil|mega|freut mich|glücklich|gluecklich|happy|wunderbar|fantastisch)\b|😊|😀|😃|🙂|❤️/i },
    { emotion: "thinking",  pattern: /\b(hmm+|weiß nicht|weiss nicht|überlege|ueberlege|mal überlegen|let me think|not sure|thinking|keine ahnung|dunno)\b|🤔/i }
  ];

  function detectEmotion(text) {
    if (!text) return "neutral";
    var s = String(text);
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].pattern.test(s)) return RULES[i].emotion;
    }
    return "neutral";
  }

  var _detectTimer = null;
  var _resetTimer  = null;

  function detectEmotionDelayed(text, setter, delayMs) {
    if (typeof setter !== "function") return;
    if (_detectTimer) { clearTimeout(_detectTimer); _detectTimer = null; }
    if (_resetTimer)  { clearTimeout(_resetTimer);  _resetTimer  = null; }
    var d = (typeof delayMs === "number" && delayMs >= 0) ? delayMs : 200;
    _detectTimer = setTimeout(function () {
      _detectTimer = null;
      try { setter(detectEmotion(text)); } catch (_) {}
    }, d);
  }

  function resetEmotion(setter, delayMs) {
    if (typeof setter !== "function") return;
    if (_resetTimer) { clearTimeout(_resetTimer); _resetTimer = null; }
    var d = (typeof delayMs === "number" && delayMs >= 0) ? delayMs : 2000;
    _resetTimer = setTimeout(function () {
      _resetTimer = null;
      try { setter("neutral"); } catch (_) {}
    }, d);
  }

  window.SophieEmotion = {
    detectEmotion: detectEmotion,
    detectEmotionDelayed: detectEmotionDelayed,
    resetEmotion: resetEmotion
  };
})();
