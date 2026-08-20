import type { PokerRepository } from "./db/pokerRepository";
import type { GetTableStateResult } from "./types";
import { PokerTableNotFoundError, PokerTableAccessDeniedError } from "./types";
import { computeBoardCards, computeLegalActions } from "./pokerRules";

/**
 * GET_TABLE_STATE command handler — the load-bearing privacy boundary
 * of this entire phase. Mirrors getSession.ts's own bearer-token
 * resolution exactly (isHost / callingSeat), then builds the response
 * by EXPLICIT PROJECTION CONSTRUCTION, never by spreading a raw
 * PokerHandRecord — deckOrder (the full authoritative shuffle) is never
 * referenced by name anywhere in this function's return value, and
 * every other seat's hole cards are never computed at all for a caller
 * who isn't that seat and isn't a legitimate Showdown reveal, not
 * merely omitted after being computed.
 *
 * Host privacy: the host token authenticates table administration
 * (create, deal), not omniscience — there is no operational reason for
 * this phase's host to see any seat's unrevealed hole cards, so
 * myHoleCards is null for the host exactly as it is for a participant
 * looking at a seat that isn't their own.
 *
 * Reveal rule (v1): once a Hand reaches street = 'COMPLETE' via a real
 * Showdown, poker_hand_results.showdown_hands (every non-folded
 * contestant) becomes visible to everyone via each seat's own
 * revealedHoleCards — an early win (fold-to-one) never populates this,
 * since no evaluation ever happens for it.
 */
export async function getTableState(
  repo: PokerRepository,
  pokerTableId: string,
  bearerToken: string
): Promise<GetTableStateResult> {
  const table = await repo.getTableById(pokerTableId);
  if (!table) {
    throw new PokerTableNotFoundError();
  }

  const seats = await repo.listSeatsForTable(pokerTableId);

  const isHost = bearerToken === table.hostToken;
  const callingSeat = seats.find((s) => s.participantToken === bearerToken);
  const isParticipant = callingSeat !== undefined;

  if (!isHost && !isParticipant) {
    throw new PokerTableAccessDeniedError();
  }

  const currentHand = await repo.getMostRecentHandForTable(pokerTableId);
  const dealtSeatSet = new Set(currentHand?.dealtSeatNumbers ?? []);
  const handPlayers = currentHand ? await repo.getHandPlayers(currentHand.pokerHandId) : [];
  const handPlayerBySeat = new Map(handPlayers.map((p) => [p.seatNumber, p]));

  const handResult =
    currentHand && currentHand.street === "COMPLETE"
      ? await repo.getHandResult(currentHand.pokerHandId)
      : null;

  const seatSummaries = seats.map((s) => {
    const hp = handPlayerBySeat.get(s.seatNumber);
    const revealed = handResult?.showdownHands?.[String(s.seatNumber)];
    return {
      seatNumber: s.seatNumber,
      displayName: s.displayName,
      isDealer: currentHand?.dealerSeatNumber === s.seatNumber,
      inCurrentHand: dealtSeatSet.has(s.seatNumber),
      stack: s.stack,
      committedThisHand: hp?.committedThisHand ?? 0,
      committedThisStreet: hp?.committedThisStreet ?? 0,
      folded: hp?.folded ?? false,
      allIn: hp?.allIn ?? false,
      isCurrentActor: currentHand?.currentActorSeatNumber === s.seatNumber,
      revealedHoleCards: revealed ? revealed.cards : null,
    };
  });

  // The only place myHoleCards is ever computed: strictly for the
  // calling participant's own seat, strictly from currentHand's own
  // dealtSeatNumbers/deckOrder, never touched for any other caller.
  let myHoleCards: [string, string] | null = null;
  if (callingSeat && currentHand && dealtSeatSet.has(callingSeat.seatNumber)) {
    const position = currentHand.dealtSeatNumbers.indexOf(callingSeat.seatNumber);
    const n = currentHand.dealtSeatNumbers.length;
    myHoleCards = [
      currentHand.deckOrder[position],
      currentHand.deckOrder[n + position],
    ];
  }

  // Once a Hand is COMPLETE, `street` alone can no longer say how many
  // streets were actually reached before it ended (a fold can end a
  // Hand at PRE_FLOP, FLOP, or TURN just as validly as at Showdown) —
  // the persisted handResult.board (computed once, correctly, at
  // settlement time) is the authoritative source from that point on,
  // never a live re-derivation that would wrongly assume a full board.
  const board = handResult
    ? handResult.board
    : currentHand
      ? computeBoardCards(currentHand.deckOrder, currentHand.dealtSeatNumbers.length, currentHand.street)
      : [];

  const pot = handPlayers.reduce((sum, p) => sum + p.committedThisHand, 0);

  let myLegalActions: GetTableStateResult["myLegalActions"] = null;
  if (
    callingSeat &&
    currentHand &&
    currentHand.currentActorSeatNumber === callingSeat.seatNumber &&
    currentHand.street !== "SHOWDOWN" &&
    currentHand.street !== "COMPLETE"
  ) {
    const hp = handPlayerBySeat.get(callingSeat.seatNumber);
    if (hp) {
      myLegalActions = computeLegalActions({
        currentBet: currentHand.currentBet,
        minRaiseAmount: currentHand.minRaiseAmount,
        committedThisStreet: hp.committedThisStreet,
        remainingStack: callingSeat.stack - hp.committedThisHand,
        lastRaiseWasFull: currentHand.lastRaiseWasFull,
        actedThisStreet: hp.actedThisStreet,
        configuredBigBlind: table.bigBlind,
      });
    }
  }

  return {
    pokerTableId: table.pokerTableId,
    roomCode: table.roomCode,
    maxSeats: table.maxSeats,
    closedAt: table.closedAt,
    startingStack: table.startingStack,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    seats: seatSummaries,
    currentHandId: currentHand?.pokerHandId ?? null,
    currentHandOrdinal: currentHand?.handOrdinal ?? null,
    street: currentHand?.street ?? null,
    board,
    pot,
    myHoleCards,
    myLegalActions,
    handResult,
  };
}
