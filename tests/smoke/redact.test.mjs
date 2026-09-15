// Smoke tests for lib/ai/redact.js — format-based redaction at provider boundaries.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../../lib/ai/redact.js";

const cases = [
  ["openai key", "mein key ist sk-abcdefghijklmnopqrstuvwxyz123456 ok", "[api-key]"],
  ["anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "[api-key]"],
  ["stripe key", "use sk_live_abcdefghijklmnop123456 please", "[api-key]"],
  ["aws key", "AKIAIOSFODNN7EXAMPLE", "[api-key]"],
  ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[api-key]"],
  ["slack token", "xoxb-1234567890-abcdefghij", "[api-key]"],
  ["google key", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r", "[api-key]"],
  ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[token]"],
  ["bearer", "Authorization: Bearer abcdefghijklmnop1234567890", "Bearer [token]"],
  ["cookie header", "Set-Cookie: session=abc123; Path=/", "[cookie]"],
  ["session kv", "access_token=abcdefgh12345678 in url", "[token]"],
  ["password de", "Passwort: Sommer2026!", "[redacted]"],
  ["password en", "password = hunter2hunter2", "[redacted]"],
  ["pin", "PIN: 1234", "[redacted]"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "[private-key]"],
  ["iban", "IBAN DE89 3704 0044 0532 0130 00 bitte", "[iban]"],
  ["card luhn", "Karte 4111 1111 1111 1111 ok", "[card]"],
  ["hex token", "id 3f7a9c2b1d4e5f60718293a4b5c6d7e8", "[token]"],
  ["email", "schreib an max.mustermann@example.com", "[email]"],
  ["phone intl", "ruf +49 171 1234567 an", "[telefon]"],
  ["phone local", "Nummer 0171 1234567", "[telefon]"],
];

for (const [name, input, placeholder] of cases) {
  test(`redacts ${name}`, () => {
    const { text, count } = redactSensitive(input);
    assert.ok(text.includes(placeholder), `expected ${placeholder} in "${text}"`);
    assert.ok(count >= 1);
  });
}

test("secret value never survives", () => {
  const { text } = redactSensitive("key sk-abcdefghijklmnopqrstuvwxyz123456 and pass Passwort: geheim123");
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(!text.includes("geheim123"));
});

test("card number failing Luhn is left alone", () => {
  const { text, count } = redactSensitive("Referenz 4111 1111 1111 1112");
  assert.ok(text.includes("4111 1111 1111 1112"));
  assert.equal(count, 0);
});

const negatives = [
  "Wir treffen uns am 15.09.2026 um 14:30 Uhr.",
  "Das Budget liegt bei 12.500 Euro für 2027.",
  "Donaudampfschifffahrtsgesellschaftskapitän ist ein langes Wort.",
  "The system prompt says the user should decide.",
  "Version 2.5 kostet 0,30 Dollar pro Million Tokens.",
];
for (const s of negatives) {
  test(`leaves normal text unchanged: ${s.slice(0, 30)}`, () => {
    const { text, count } = redactSensitive(s);
    assert.equal(text, s);
    assert.equal(count, 0);
  });
}

test("handles null/undefined", () => {
  assert.deepEqual(redactSensitive(null), { text: "", count: 0 });
});
