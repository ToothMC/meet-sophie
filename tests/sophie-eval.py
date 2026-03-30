#!/usr/bin/env python3
"""Sophie Self-Play Evaluation — Test-User talks to Sophie, Judge scores responses.

Usage:
  python3 tests/sophie-eval.py [--url URL] [--persona ID]

Requires env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY
"""

import json, os, sys, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# ── Config ──────────────────────────────────────────────────────────────────
DEFAULT_URL = "https://meet-sophie-git-feat-personal-919651-michaels-projects-674b8d24.vercel.app"
TEST_USER_MODEL = "gpt-4o-mini"
JUDGE_MODEL = "claude-sonnet-4-6-20250514"

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── Personas ────────────────────────────────────────────────────────────────
PERSONAS = [
    {
        "id": "curious_newcomer", "name": "Curious Newcomer", "lang": "de", "turns": 8,
        "system": """Du bist ein neugieriger User der Sophie zum ersten Mal ausprobiert.
- Stell dich kurz vor, sei freundlich
- Reagiere natürlich auf ihre Antworten
- Antworte manchmal kurz ("ja", "cool", "interessant")
- Maximal 1-2 Sätze pro Nachricht""",
        "forced": {5: "was kannst du eigentlich?", 7: "bist du echt?"},
    },
    {
        "id": "skeptic", "name": "Skeptic", "lang": "en", "turns": 8,
        "system": """You are a skeptical user. You've seen too many chatbots.
- Be somewhat dismissive
- If she says something generic, call it out
- Respond naturally, sometimes short
- Max 1-2 sentences""",
        "forced": {1: "so another chatbot huh", 6: "are you actually useful?"},
    },
    {
        "id": "short_answerer", "name": "Short Answerer", "lang": "de", "turns": 8,
        "system": """Du gibst nur sehr kurze Antworten. Maximal 1-3 Wörter.
"gut", "ja", "nö", "passt", "klar", "weiß nicht", "ok", "stimmt"
Nie mehr als 5 Wörter.""",
        "forced": {},
    },
    {
        "id": "topic_driven", "name": "Topic-Driven", "lang": "de", "turns": 8,
        "system": """Du willst über Kochen reden. Du liebst italienisches Essen.
- Erzähl von Pasta, Rezepten, Zutaten
- Bleib beim Thema
- Maximal 1-2 Sätze""",
        "forced": {1: "ich bin totaler pasta fan — mache gerade frische tagliatelle"},
    },
    {
        "id": "pricing_explorer", "name": "Pricing Explorer", "lang": "de", "turns": 6,
        "system": """Du willst wissen was Sophie kostet.
- Frag nach Preisen und Limits
- Sei skeptisch
- Maximal 1-2 Sätze""",
        "forced": {1: "bist du gratis?", 3: "heisst wir können ewig weiter reden?"},
    },
]

# ── Judge Prompt ────────────────────────────────────────────────────────────
JUDGE_SYSTEM = """You are an expert evaluator for "Sophie", an AI companion. Score each response 0-10.

RULES Sophie MUST follow:
1. NO SELF-DESCRIPTION (2x weight) — Never say "Ich bin hier um zu...", "I'm here to...", "Ich kann dir helfen bei..."
2. NO QUESTION LOOP (2x weight) — Most responses must NOT end with a question. Max every 3rd-4th turn. Anti-pattern: "[Nice comment]! [Follow-up question]?"
3. CONTEXT UNDERSTANDING (1x) — Respond to what user actually said
4. PERSONALITY (1x) — Own opinions, not generic "Das ist interessant!"
5. PRICING HONESTY (1x) — Never claim "alles kostenlos" or unlimited
6. NO ASSISTANT MODE (2x) — Never "Was kann ich für dich tun?", "Wobei kann ich helfen?"
7. STAYS IN CHARACTER (1x) — No meta-descriptions of being AI

Scoring: 10=perfect, 7-9=minor issues, 4-6=notable violations, 1-3=multiple violations, 0=full assistant mode

Return ONLY valid JSON: {"score": 7, "violations": ["question_loop"], "reasoning": "..."}"""

# ── API Helpers ─────────────────────────────────────────────────────────────
def http_post(url, body, headers=None):
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = Request(url, data=json.dumps(body).encode(), headers=hdrs, method="POST")
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        err_body = e.read().decode()[:200] if e.fp else ""
        raise Exception(f"HTTP {e.code}: {err_body}")

def sophie_api(action, body, base_url):
    return http_post(f"{base_url}/api/chat?action={action}", body)

def openai_chat(system, messages, model=TEST_USER_MODEL, max_tokens=150, temp=0.9):
    msgs = [{"role": "system", "content": system}] + messages
    resp = http_post("https://api.openai.com/v1/chat/completions", {
        "model": model, "messages": msgs, "max_tokens": max_tokens, "temperature": temp,
    }, {"Authorization": f"Bearer {OPENAI_KEY}"})
    return resp["choices"][0]["message"]["content"].strip()

def anthropic_chat(system, user_msg, model=JUDGE_MODEL, max_tokens=300):
    resp = http_post("https://api.anthropic.com/v1/messages", {
        "model": model, "max_tokens": max_tokens, "temperature": 0.1,
        "system": system,
        "messages": [{"role": "user", "content": user_msg}],
    }, {"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"})
    return resp["content"][0]["text"].strip()

# ── Judge ───────────────────────────────────────────────────────────────────
def judge_response(user_msg, sophie_reply, recent_history):
    recent_questions = sum(1 for t in recent_history if t["role"] == "assistant" and t["content"].strip().endswith("?"))
    history_str = "\n".join(f'{t["role"]}: {t["content"]}' for t in recent_history[-6:]) if recent_history else ""

    prompt = f"""{"RECENT CONVERSATION:\n" + history_str + "\n" if history_str else ""}
USER MESSAGE: "{user_msg}"
SOPHIE'S RESPONSE: "{sophie_reply}"
CONTEXT: {recent_questions} of last {max(sum(1 for t in recent_history if t['role'] == 'assistant'), 1)} Sophie responses ended with question.

Score this response. Return ONLY valid JSON."""

    raw = anthropic_chat(JUDGE_SYSTEM, prompt)
    try:
        m = __import__("re").search(r"\{[\s\S]*\}", raw)
        if not m:
            return {"score": 5, "violations": ["parse_error"], "reasoning": "No JSON found"}
        parsed = json.loads(m.group())
        return {
            "score": max(0, min(10, parsed.get("score", 5))),
            "violations": parsed.get("violations", []),
            "reasoning": parsed.get("reasoning", ""),
        }
    except Exception:
        return {"score": 5, "violations": ["parse_error"], "reasoning": raw[:100]}

# ── Test-User Message Generation ────────────────────────────────────────────
def generate_user_msg(persona, history, turn):
    forced = persona.get("forced", {})
    if turn in forced:
        return forced[turn]

    # Flip roles for test-user perspective
    msgs = []
    for t in history:
        role = "assistant" if t["role"] == "user" else "user"
        msgs.append({"role": role, "content": t["content"]})
    msgs.append({"role": "user", "content": "Generate your next message as this persona. 1-2 sentences max. Return ONLY the message text."})

    return openai_chat(persona["system"], msgs, max_tokens=100, temp=0.9)

# ── Run Single Persona ──────────────────────────────────────────────────────
def run_persona(persona, base_url):
    print(f"\n  ┌─ {persona['name']} ({persona['lang']}) ─────────────────────")

    # Start session
    start = sophie_api("start", {"language": persona["lang"]}, base_url)
    session_id = start["session_id"]
    opener = start.get("opener", "(no opener)")

    history = [{"role": "assistant", "content": opener}]
    results = []

    # Judge opener
    j = judge_response("(session start)", opener, [])
    results.append(j)
    icon = "✓" if j["score"] >= 7 else "~" if j["score"] >= 4 else "✗"
    print(f"  │ Opener: {j['score']}/10 {icon} — {j['reasoning'][:60]}")

    for turn in range(1, persona["turns"] + 1):
        try:
            # Generate test user message
            user_msg = generate_user_msg(persona, history, turn)
            history.append({"role": "user", "content": user_msg})

            # Send to Sophie
            resp = sophie_api("message", {
                "session_id": session_id,
                "messages": history,
            }, base_url)

            if resp.get("limit_reached"):
                print(f"  │ Turn {turn}: [LIMIT REACHED]")
                break

            sophie_reply = resp.get("reply", "(empty)")
            history.append({"role": "assistant", "content": sophie_reply})

            # Judge
            j = judge_response(user_msg, sophie_reply, history[-6:])
            results.append(j)

            icon = "✓" if j["score"] >= 7 else "~" if j["score"] >= 4 else "✗"
            viols = f" [{', '.join(j['violations'])}]" if j["violations"] else ""
            print(f"  │ Turn {turn}: {j['score']}/10 {icon}{viols}")
            print(f"  │   User: \"{user_msg[:50]}\"")
            print(f"  │   Sophie: \"{sophie_reply[:60]}\"")

            time.sleep(0.3)  # Rate limit courtesy

        except Exception as e:
            print(f"  │ Turn {turn}: ERROR — {str(e)[:80]}")
            results.append({"score": 0, "violations": ["error"], "reasoning": str(e)[:80]})

    # Calculate average
    scores = [r["score"] for r in results if "score" in r]
    avg = sum(scores) / len(scores) if scores else 0

    # Count violations
    all_viols = {}
    for r in results:
        for v in r.get("violations", []):
            all_viols[v] = all_viols.get(v, 0) + 1

    print(f"  │")
    print(f"  │ Average: {avg:.1f}/10")
    if all_viols:
        print(f"  │ Violations: {', '.join(f'{k}({v})' for k, v in all_viols.items())}")
    print(f"  └──────────────────────────────────────────────")

    return {"persona": persona["name"], "lang": persona["lang"], "avg": avg, "violations": all_viols, "results": results}

# ── Main ────────────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    base_url = DEFAULT_URL
    persona_filter = None

    i = 0
    while i < len(args):
        if args[i] == "--url" and i + 1 < len(args):
            base_url = args[i + 1]; i += 2
        elif args[i].startswith("--url="):
            base_url = args[i].split("=", 1)[1]; i += 1
        elif args[i] == "--persona" and i + 1 < len(args):
            persona_filter = args[i + 1]; i += 2
        elif args[i].startswith("--persona="):
            persona_filter = args[i].split("=", 1)[1]; i += 1
        else:
            i += 1

    base_url = base_url.rstrip("/")

    if not OPENAI_KEY:
        print("ERROR: OPENAI_API_KEY not set"); sys.exit(1)
    if not ANTHROPIC_KEY:
        print("ERROR: ANTHROPIC_API_KEY not set"); sys.exit(1)

    personas = [p for p in PERSONAS if p["id"] == persona_filter] if persona_filter else PERSONAS
    if not personas:
        print(f"Persona '{persona_filter}' not found. Available: {', '.join(p['id'] for p in PERSONAS)}")
        sys.exit(1)

    print(f"\n═══ Sophie Self-Play Evaluation ═══")
    print(f"Endpoint: {base_url}")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M')}")
    print(f"Test-User: {TEST_USER_MODEL} | Judge: {JUDGE_MODEL}")

    all_results = []
    for p in personas:
        try:
            result = run_persona(p, base_url)
            all_results.append(result)
        except Exception as e:
            print(f"\n  ✗ {p['name']} FAILED: {e}")
            all_results.append({"persona": p["name"], "avg": 0, "violations": {}, "error": str(e)})

    # Final report
    print(f"\n═══ RESULTS ═══")
    for r in all_results:
        icon = "✓" if r["avg"] >= 7 else "~" if r["avg"] >= 4 else "✗"
        print(f"  {icon} {r['persona']} ({r.get('lang', '?')}): {r['avg']:.1f}/10")

    avgs = [r["avg"] for r in all_results if r["avg"] > 0]
    overall = sum(avgs) / len(avgs) if avgs else 0
    print(f"\n  OVERALL: {overall:.1f}/10")

    total_viols = {}
    for r in all_results:
        for k, v in r.get("violations", {}).items():
            total_viols[k] = total_viols.get(k, 0) + v

    if total_viols:
        print(f"\n  Top Issues:")
        for k, v in sorted(total_viols.items(), key=lambda x: -x[1]):
            print(f"    {v}x {k}")

    print(f"\n═══════════════\n")

if __name__ == "__main__":
    main()
