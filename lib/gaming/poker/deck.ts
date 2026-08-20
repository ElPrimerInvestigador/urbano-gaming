import { randomInt } from "crypto";

/**
 * Poker Foundation (Phase 1). A standard 52-card deck, no jokers.
 * Canonical card codes are RankSuit — ranks 2-9, T, J, Q, K, A; suits
 * C, D, H, S — e.g. "AS" (ace of spades), "TC" (ten of clubs). This is
 * the same authoritative representation persisted to poker_hands.deck_order
 * and never exposed to any client beyond a caller's own dealt cards.
 */

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["C", "D", "H", "S"];

export function buildStandardDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle using Node's crypto.randomInt — a CSPRNG, not
 * Math.random() (not cryptographically secure) and not Postgres's own
 * random() (a fast, non-cryptographic PRNG). Shuffling happens here, in
 * the domain layer, rather than in SQL, for the same reason Predictions'
 * geolocation distance is computed in TypeScript and handed to its
 * atomic function as a pre-computed value: the atomic function's job is
 * to validate and persist authoritative state under a lock, not to be
 * the source of randomness. The atomic function still independently
 * validates the result (0071) is a genuine 52-card permutation before
 * trusting it — this function's output is not blindly persisted.
 */
export function shuffleDeck(deck: string[]): string[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function isValidStandardDeck(cards: string[]): boolean {
  if (cards.length !== 52) return false;
  const canonical = new Set(buildStandardDeck());
  const seen = new Set<string>();
  for (const card of cards) {
    if (!canonical.has(card)) return false;
    if (seen.has(card)) return false;
    seen.add(card);
  }
  return true;
}
