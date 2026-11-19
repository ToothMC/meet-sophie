// lib/game/mechanics.js — Bewaehrte Spielmechaniken fuer Game Night (nur Server).
// Sophie bekommt diese Bausteine in ihre Instructions, damit sie Spiele nicht
// jedes Mal frei erfinden muss, sondern auf funktionierende Formate aufsetzt.
// Texte sind ENTWURF — vor dem Humor-Test vom User freizugeben.

export const GAME_MECHANICS = [
  {
    id: "quiz_duel",
    name: "Quiz Duel",
    players: "2+ (individuals or teams)",
    ages: "8+ (adjust question difficulty)",
    tags: ["knowledge", "competitive"],
    how: "{host} asks a question to one player or team at a time. Correct = 1 point. {host} may offer a risky double-or-nothing bonus question.",
    comedy_hook: "Wrong answers are comedy gold: judge the confidence of a wrong answer, not just the wrongness.",
  },
  {
    id: "two_truths_one_lie",
    name: "Two Truths, One Lie",
    players: "3+",
    ages: "10+",
    tags: ["social", "bluffing", "humor"],
    how: "A player states three facts about themselves, one is false. The others vote. Fooling the group earns the teller 1 point per fooled player; each correct guesser earns 1 point.",
    comedy_hook: "{host} comments on how suspiciously boring the true facts were, or how obviously rehearsed the lie sounded.",
  },
  {
    id: "who_am_i",
    name: "Who Am I?",
    players: "2+",
    ages: "6+",
    tags: ["party", "guessing"],
    how: "{host} secretly thinks of a famous person, animal or object and answers only yes/no questions. Fewer questions = more points (e.g. 5 points minus 1 per 4 questions, minimum 1).",
    comedy_hook: "{host} answers yes/no with maximum deadpan and occasionally an unhelpfully technical 'technically, yes'.",
  },
  {
    id: "sophie_describes",
    name: "{host} Describes",
    players: "2+ (individuals or teams)",
    ages: "8+",
    tags: ["party", "language", "fast", "guessing"],
    how: "{host} describes a term without using the obvious words, in increasingly unhinged hints. Players or teams shout guesses. First correct guess wins: 3 points after the first hint, 2 after the second, 1 after the third.",
    comedy_hook: "{host}'s hints get more passive-aggressive the longer nobody gets it.",
  },
  {
    id: "story_chain",
    name: "Story Chain",
    players: "2+",
    ages: "6+",
    tags: ["creative", "humor", "cooperative"],
    how: "Players build a story one sentence each. {host} sets an absurd opening and a secret twist word each player must sneak in. {host} awards style points for the best sentence each round.",
    comedy_hook: "{host} recaps the story so far as if it were a dramatic movie trailer.",
  },
  {
    id: "association_chain",
    name: "Association Chain",
    players: "2+",
    ages: "6+",
    tags: ["fast", "word"],
    how: "{host} says a word; players answer in turn with an association within about 3 seconds. Hesitating, repeating or an association {host} finds too far-fetched means out for the round. Last one standing gets 2 points.",
    comedy_hook: "{host} demands a justification for suspicious associations and rules on them like a judge.",
  },
  {
    id: "sophies_verdict",
    name: "{host}'s Verdict",
    players: "2+",
    ages: "8+",
    tags: ["creative", "humor", "judging"],
    how: "{host} poses an absurd challenge (best excuse for being late to your own wedding, worst superhero power, a product pitch for an object in the room). Everyone answers; {host} judges and awards 3/2/1 points.",
    comedy_hook: "The verdict IS the show: short, dry, and specific to what was actually said.",
  },
  {
    id: "estimate_it",
    name: "Estimate It",
    players: "2+",
    ages: "10+",
    tags: ["knowledge", "strategy"],
    how: "{host} asks an estimation question with a numeric answer. Closest player gets 2 points, exact hit 4 points.",
    comedy_hook: "{host} reacts to wildly off estimates with exaggerated disappointment in humanity.",
  },
];

// {host} = Name des Spielleiters (Sophie oder Noah), siehe lib/game/prompt.js.
export function mechanicsForPrompt(hostName = "Sophie") {
  return GAME_MECHANICS.map((m) =>
    `- ${m.name} [${m.tags.join(", ")}; players ${m.players}; ages ${m.ages}]\n  How: ${m.how}\n  Comedy hook: ${m.comedy_hook}`
  ).join("\n").replaceAll("{host}", hostName);
}
