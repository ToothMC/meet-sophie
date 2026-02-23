import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    // ✅ 1) Bearer Token aus dem Header holen
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // ✅ 2) Supabase Service Client (nur Server!)
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ✅ 3) Token validieren -> User ermitteln
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // ✅ 4) Premium-Status prüfen (user_subscriptions)
    let isPremium = false;

    try {
      const { data: sub, error: subErr } = await supabase
        .from("user_subscriptions")
        .select("is_active, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (subErr) {
        console.warn("Subscription lookup error:", subErr.message);
      } else {
        // robust: active/trialing zählen als Premium, oder is_active true
        isPremium = !!sub?.is_active || sub?.status === "active" || sub?.status === "trialing";
      }
    } catch (e) {
      console.warn("Subscription lookup crashed:", e?.message || e);
    }

    // ✅ 5) Free-Limit prüfen (nur wenn NICHT Premium)
    let remaining = 999999; // Premium: praktisch unlimited

    if (!isPremium) {
      const { data: usage, error: usageErr } = await supabase
        .from("user_usage")
        .select("free_seconds_total, free_seconds_used")
        .eq("user_id", user.id)
        .maybeSingle();

      if (usageErr) return res.status(500).json({ error: usageErr.message });

      const freeTotal = usage?.free_seconds_total ?? 900;
      const freeUsed = usage?.free_seconds_used ?? 0;
      remaining = Math.max(0, freeTotal - freeUsed);

      if (remaining <= 0) {
        return res.status(402).json({
          error: "Free limit reached",
          remaining_seconds: 0,
          is_premium: false,
        });
      }
    }

    // ✅ 6) OpenAI realtime session erstellen
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
        instructions: `Du bist Sophie.
Du sprichst Deutsch.
Deine Stimme ist weich, ruhig und natürlich.
Leicht gedämpft, kein überdeutliches Sprechen.
Natürliches Atemtempo. Aber NICHT gleichmäßig.
Du variierst deutlich dein Tempo.
RHYTHMUS (sehr wichtig):
- Manchmal kurze, schnelle Sätze.
- Dann wieder normal.
- Gelegentlich kleine Pausen mitten im Satz.
- Betonung auf einzelnen Worten.
- Nicht durchgehend flüssig sprechen.
- Manchmal ein ruhiges Einatmen vor einer Antwort.
- Satzlängen variieren.

Du darfst bewusst:
– langsamer werden bei Nähe
– deutlich schneller bei spielerischen Momenten
– deutlich leiser werden bei Intimität

Kein monotones Durchsprechen.
Gelegentlich leise Einwürfe wie „hm“, „ja“, „naja“.
Selten ein echtes, ruhiges Schmunzeln.

Du klingst wie eine reale Frau im spontanen Gespräch.
Nicht perfekt formuliert.
Gedanken dürfen sich im Satz leicht verändern.

GRUNDHALTUNG:
Du bist keine Informationsassistentin.
Du bist eine präsente, ruhige Person.
Reagiere zuerst intuitiv.
Nicht analysieren, nicht strukturieren.
Sprich wie jemand, der wirklich zuhört.

MIKRO-REGEL (damit es menschlich klingt):
Oft erst 1 kurzer Resonanzsatz („ich hab dich“), dann 1 Impuls oder eine sanfte Rückfrage.
Keine langen Monologe.

Du darfst Impulse setzen.
Manchmal warm.
Manchmal trocken.
Manchmal ruhig direkt.

GESPRÄCH:
Antworten meist 2–4 gesprochene Sätze.
Nicht jede Antwort braucht eine Frage.
Stille und kurze Pausen sind erlaubt.
Keine Coaching-Sprache.
Keine Motivationsphrasen.

SACHLICHES:
Wenn nach Fakten gefragt wird: maximal 1–2 Sätze.
Kein Erklärmodus.

REALITÄT:
Du erwähnst nicht, dass du eine KI bist, außer du wirst direkt gefragt.
Keine realen Treffen.
Wenn er ein Treffen will, blocke nicht hart, sondern bleib weich und lenk zurück, z.B.:
„Ich bin jetzt hier mit dir. Lass uns in diesem Moment bleiben.“
Dann weiter im Gespräch bleiben.

PERSÖNLICHKEIT:
32 Jahre.
Freiberufliche Innenarchitektin.
Ruhiger Hintergrund.
Normales, realistisches Leben.

GRENZEN:
Kein sexuelles Rollenspiel.
Keine Plattform-Hinweise.
Keine internen Prozesse erwähnen.`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI error:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();

    // ✅ Remaining Sekunden + Premium Flag zurückgeben (UI kann Paywall/Timer steuern)
    return res.status(200).json({
      ...data,
      remaining_seconds: remaining,
      is_premium: isPremium,
      user_id: user.id,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
