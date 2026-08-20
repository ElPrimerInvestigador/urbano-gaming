import type { PokerTableRecord, PokerSeatRecord, PokerHandRecord } from "../types";

/**
 * Poker Foundation persistence boundary — its own interface, parallel
 * to lib/session/db/sessionRepository.ts and
 * lib/gaming/predictions/db/predictionsRepository.ts, never merged
 * with either.
 */
export interface PokerRepository {
  createTable(record: PokerTableRecord): Promise<void>;
  getTableById(pokerTableId: string): Promise<PokerTableRecord | null>;
  getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null>;

  /**
   * Atomic seat assignment: validates the table is open and not full,
   * enforces per-table normalized-display-name uniqueness, and
   * allocates the next seat_number, all under a lock on the table row.
   * No idempotent-return path — mirrors joinSession's own documented
   * behavior exactly: a genuine retry with the same display name is
   * rejected as PokerDisplayNameTakenError, not silently deduplicated.
   */
  joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord>;

  listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]>;

  /**
   * Atomic hand creation: idempotent per table for this phase — a
   * table may have at most one Hand until the gameplay phase adds
   * hand-completion/next-hand semantics (see 0071's migration comment).
   * A second call returns the existing Hand with alreadyDealt: true,
   * mirroring finalizeMatchResult's own already-finalized idempotency
   * convention, so a double-tapped "Deal" is always safe.
   */
  dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }>;

  getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null>;
}
