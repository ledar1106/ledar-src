/**
 * Does this look like a credential somebody pasted into the wrong box?
 *
 * ## 🟥 Why this exists
 *
 * It happened. Driving the key screen, a click missed the key field by a few
 * pixels and a real API key went into the QUESTION box instead — in clear
 * text, on screen, one button away from being sent to a model along with the
 * table names.
 *
 * The person doing it knew exactly what they were doing. Somebody who has
 * just been told *"paste your key"* and is looking at two text boxes is more
 * likely to do it, not less. And the consequence is the worst one this
 * product has: their credential leaves the machine, inside a payload the
 * disclosure screen described as "your question".
 *
 * ## What it is, and what it is not
 *
 * It is a slip-catcher, not a security boundary. There is no attacker here —
 * an attacker does not need to trick somebody into leaking their own key when
 * the key is already on that machine. So a plain, readable rule is right, and
 * the failure mode to avoid is the opposite one: firing on real questions.
 *
 * Two rungs, both requiring a run with no spaces in it, because a question is
 * words and a key is not:
 *
 * ```text
 * ① a known prefix    sk-… sk_… — what most providers issue
 * ② shape alone       32+ chars, no spaces, mixing case AND digits
 * ```
 *
 * ⚠️ Rung ② is the one that could misfire. "A customer paid and cannot see
 * their rental" has spaces in every eight characters; a 32-character unbroken
 * token mixing case and digits is not a sentence in any language. The tests
 * hold real questions against it.
 *
 * ## No imports, on purpose
 *
 * Both the window and the main process need this — the window so a key is
 * never drawn on screen, the main process because that is where the boundary
 * is. Two copies of one rule is debt N57's exact shape, so there is one, and
 * it lives here beside `ipc.ts` for the same reason that file does: it is the
 * vocabulary both sides share, and it drags neither side's world into the
 * other.
 */

/** Prefixes providers actually issue. Cheap, and catches the common case. */
const KNOWN_PREFIX = /(?:^|\s)(?:sk|rk|pk|api|key)[-_][A-Za-z0-9_-]{16,}/;

/** A long unbroken token mixing case and digits. Not a word in any language. */
const SHAPED_LIKE_A_KEY = /(?:^|\s)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?:\s|$)/;

/**
 * Whether this text carries something that looks like a credential.
 *
 * 🟥 Returns a boolean and never the match. Nothing that reports on a
 * suspected secret may carry the secret out with it — a refusal that quoted
 * the key would put it in a log, a screenshot, and a bug report.
 */
export function looksLikeSecret(text: string): boolean {
  return KNOWN_PREFIX.test(text) || SHAPED_LIKE_A_KEY.test(text);
}
