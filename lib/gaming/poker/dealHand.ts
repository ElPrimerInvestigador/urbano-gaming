import type { PokerRepository } from "./db/pokerRepository";
import type { DealPokerHandResult } from "./types";
import { PokerTableNotFoundError, NotEnoughSeatedPlayersError } from "./types";
import { buildStandardDeck, shuffleDeck } from "./deck";

/**
 * DEAL_HAND (START_POKER_HAND) command handler.
 *
 * Phase 1 boundary: idempotent per table, not sequence-capable — a
 * table may have at most one Hand until the gameplay phase adds
 * hand-completion/next-hand semantics (see 0071's migration comment
 * and POKER_FOUNDATION_IMPLEMENTATION_RECORD.md). This is what makes a
 * double-tapped "Deal" safe without inventing hand-lifecycle state this
 * phase has no use for yet.
 *
 * Dealing order: seats currently at the table, ordered starting
 * immediately after the dealer (the lowest seat_number present) and
 * wrapping around — the real "left of the button" rule, not a
 * simplification, since it costs nothing extra to implement correctly.
 * The dealer itself is also documented here as an explicit, non-final
 * choice for this phase: "lowest seated seat_number" — real
 * button rotation across Hands has no meaning yet, since this phase
 * never deals a second Hand.
 *
 * The shuffle happens here (TypeScript, crypto.randomInt — see
 * deck.ts) and the resulting deck is handed to the atomic function as
 * pre-computed, authoritative evidence — mirroring exactly how
 * Predictions' geolocation distance is computed in the domain layer
 * and handed to its own atomic function, which still independently
 * validates it before persisting.
 */
export async function dealHand(
  repo: PokerRepository,
  pokerTableId: string
): Promise<DealPokerHandResult> {
  const table = await repo.getTableById(pokerTableId);
  if (!table) {
    throw new PokerTableNotFoundError();
  }

  const seats = await repo.listSeatsForTable(pokerTableId);
  if (seats.length < 2) {
    throw new NotEnoughSeatedPlayersError();
  }

  const seatNumbers = seats.map((s) => s.seatNumber).sort((a, b) => a - b);
  const dealerSeatNumber = seatNumbers[0];

  const dealerIndex = seatNumbers.indexOf(dealerSeatNumber);
  const dealtSeatNumbers = [
    ...seatNumbers.slice(dealerIndex + 1),
    ...seatNumbers.slice(0, dealerIndex + 1),
  ];

  const deckOrder = shuffleDeck(buildStandardDeck());

  const { hand, alreadyDealt } = await repo.dealHand({
    pokerTableId,
    dealerSeatNumber,
    dealtSeatNumbers,
    deckOrder,
  });

  return {
    pokerHandId: hand.pokerHandId,
    pokerTableId: hand.pokerTableId,
    handOrdinal: hand.handOrdinal,
    dealerSeatNumber: hand.dealerSeatNumber,
    dealtSeatNumbers: hand.dealtSeatNumbers,
    alreadyDealt,
  };
}
