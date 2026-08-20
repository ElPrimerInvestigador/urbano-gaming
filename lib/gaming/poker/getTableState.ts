import type { PokerRepository } from "./db/pokerRepository";
import type { GetTableStateResult } from "./types";
import { PokerTableNotFoundError, PokerTableAccessDeniedError } from "./types";

/**
 * GET_TABLE_STATE command handler — the load-bearing privacy boundary
 * of this entire phase. Mirrors getSession.ts's own bearer-token
 * resolution exactly (isHost / callingSeat), then builds the response
 * by EXPLICIT PROJECTION CONSTRUCTION, never by spreading a raw
 * PokerHandRecord — deckOrder (the full authoritative shuffle) is never
 * referenced by name anywhere in this function's return value, and
 * every other seat's hole cards are never computed at all for a caller
 * who isn't that seat, not merely omitted after being computed.
 *
 * Host privacy: the host token authenticates table administration
 * (create, deal), not omniscience — there is no operational reason for
 * this phase's host to see any seat's hole cards, so myHoleCards is
 * null for the host exactly as it is for a participant looking at a
 * seat that isn't their own. If a future phase needs host visibility
 * (e.g. a physical shared-table display), that is a new, explicit
 * decision — not an accidental default of "host sees everything."
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

  const currentHand = await repo.getCurrentHandForTable(pokerTableId);
  const dealtSeatSet = new Set(currentHand?.dealtSeatNumbers ?? []);

  const seatSummaries = seats.map((s) => ({
    seatNumber: s.seatNumber,
    displayName: s.displayName,
    isDealer: currentHand?.dealerSeatNumber === s.seatNumber,
    inCurrentHand: dealtSeatSet.has(s.seatNumber),
  }));

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

  return {
    pokerTableId: table.pokerTableId,
    roomCode: table.roomCode,
    maxSeats: table.maxSeats,
    closedAt: table.closedAt,
    seats: seatSummaries,
    currentHandId: currentHand?.pokerHandId ?? null,
    currentHandOrdinal: currentHand?.handOrdinal ?? null,
    myHoleCards,
  };
}
