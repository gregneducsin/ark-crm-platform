/**
 * Detects when the bot is asking essentially the same unresolved question
 * turn after turn — the real signal that a conversation is stuck, not just
 * "many messages sent." A customer answering normally, even briefly or
 * unhelpfully, still moves the conversation forward turn to turn; only a
 * genuine loop keeps circling back to a near-identical question.
 *
 * Real incident: a customer answered a "which plan length" question
 * repeatedly in different words (a specific duration, "whatever you like",
 * a dose instead of a duration) and Lucy never recognized any of them as
 * resolving it, so she kept re-asking a reworded version of the same
 * question for almost an hour, eventually producing ~20 real texts to one
 * customer. This is a plain word-overlap heuristic, not semantic
 * understanding — it doesn't need to be perfect, only good enough to catch
 * the bot repeating its own recent phrasing.
 */

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "you",
  "your",
  "for",
  "to",
  "of",
  "this",
  "that",
  "would",
  "which",
  "what",
  "best",
  "one",
  "those",
  "work",
  "works",
  "now",
  "or",
  "and",
  "just",
  "right",
  "time",
  "think",
  "thinking",
  "want",
  "wanting",
  "prefer",
  "i",
  "me",
  "it",
  "in",
  "on",
  "with",
  "so",
  "but",
  "if",
  "be",
  "still",
  "really",
  "get",
  "got",
  "going",
  "go",
  "need",
  "needs",
  "like",
  "also",
  "then",
  "there",
  "here",
  "let",
  "know",
  "sure",
  "make",
  "sounds",
  "sound",
  "good",
  "great",
  "up",
  "out",
  "from",
  "at",
  "as",
  "can",
  "could",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * True when two questions share enough of their distinctive content words to
 * read as "the same question, reworded" — an overlap coefficient (shared
 * words divided by the SMALLER question's word count), not Jaccard, since a
 * short reworded question ("3-month, or 6-month?") should still count as a
 * repeat of a longer one that mentions the same specifics.
 */
function isSameQuestion(a: string, b: string): boolean {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const smaller = Math.min(wordsA.size, wordsB.size);
  return intersection.length / smaller >= 0.5;
}

/**
 * Counts how many of the most recent questions (oldest to newest) form an
 * unbroken trailing streak of "the same question" as `candidateQuestion` —
 * counting backward from the end and stopping at the first one that isn't a
 * match. Returns 0 if there's no candidate question to compare against.
 */
export function countTrailingRepeatQuestions(recentQuestions: readonly string[], candidateQuestion: string | null): number {
  if (!candidateQuestion) return 0;
  let count = 0;
  for (let i = recentQuestions.length - 1; i >= 0; i--) {
    if (isSameQuestion(recentQuestions[i], candidateQuestion)) count++;
    else break;
  }
  return count;
}
