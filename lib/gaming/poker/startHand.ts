import type { PokerRepository } from "./db/pokerRepository";
import type { StartPokerHandResult } from "./types";
import { PokerTableNotFoundError, NotEnoughSeatedPlayersError } from "./types";
import { buildStandardDeck, shuffleDeck } from "./deck";
import {
  computeDealerSeatNumber,
  computeDealingOrder,
  computeBlindSeats,
  computePreFlopFirstActor,
} from "./pokerRules";

/**
 * START_HAND command handler — supersedes Phase 1's dealHand.ts for
 * real gameplay (dealHand.ts itself is untouched, still exercised by
 * the Poker Foundation's own tests). Computes dealer rotation, dealing
 * order, and blind seats in the domain layer from currently-seated
 * players (stack > 0 only — a broke seat cannot play the next Hand,
 * per the chosen v1 rule) and the table's own most recent Hand,
 * mirroring exactly how Phase 1's dealHand.ts computed its own dealing
 * order before handing it to an atomic function. The shuffle happens
 * here (crypto.randomInt — see deck.ts), never client-supplied.
 */
export async function startHand(
  repo: PokerRepository,
  pokerTableId: string
): Promise<StartPokerHandResult> {
  const table = await repo.getTableById(pokerTableId);
  if (!table) {
    throw new PokerTableNotFoundError();
  }

  const seats = await repo.listSeatsForTable(pokerTableId);
  const eligibleSeatNumbers = seats.filter((s) => s.stack > 0).map((s) => s.seatNumber);
  if (eligibleSeatNumbers.length < 2) {
    throw new NotEnoughSeatedPlayersError();
  }

  const mostRecentHand = await repo.getMostRecentHandForTable(pokerTableId);
  const previousDealer = mostRecentHand ? mostRecentHand.dealerSeatNumber : null;

  const dealerSeatNumber = computeDealerSeatNumber(eligibleSeatNumbers, previousDealer);
  const dealingOrder = computeDealingOrder(eligibleSeatNumbers, dealerSeatNumber);
  const { smallBlindSeat, bigBlindSeat } = computeBlindSeats(dealingOrder, dealerSeatNumber);
  const preFlopFirstActorSeatNumber = computePreFlopFirstActor(dealingOrder, smallBlindSeat, bigBlindSeat);

  const deckOrder = shuffleDeck(buildStandardDeck());

  const { hand, alreadyStarted } = await repo.startHand({
    pokerTableId,
    dealerSeatNumber,
    dealtSeatNumbers: dealingOrder,
    smallBlindSeatNumber: smallBlindSeat,
    bigBlindSeatNumber: bigBlindSeat,
    preFlopFirstActorSeatNumber,
    deckOrder,
  });

  return {
    pokerHandId: hand.pokerHandId,
    pokerTableId: hand.pokerTableId,
    handOrdinal: hand.handOrdinal,
    dealerSeatNumber: hand.dealerSeatNumber,
    dealtSeatNumbers: hand.dealtSeatNumbers,
    smallBlindSeatNumber: hand.smallBlindSeatNumber,
    bigBlindSeatNumber: hand.bigBlindSeatNumber,
    currentActorSeatNumber: hand.currentActorSeatNumber,
    street: hand.street,
    alreadyStarted,
  };
}
