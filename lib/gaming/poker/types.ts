/**
 * Poker Foundation (Phase 1) — Poker Table / seating / authoritative
 * deck / private hole cards / role-aware projection only. No betting,
 * no chips, no streets, no showdown — see
 * POKER_FOUNDATION_IMPLEMENTATION_RECORD.md for the exact phase
 * boundary and why this is a standalone module rather than a new
 * Session Engine.
 */

export interface PokerTableRecord {
  pokerTableId: string;
  roomCode: string;
  hostToken: string;
  maxSeats: number;
  closedAt: string | null;
  createdAt: string;
}

export interface PokerSeatRecord {
  pokerSeatId: string;
  pokerTableId: string;
  seatNumber: number;
  displayName: string;
  normalizedDisplayName: string;
  participantToken: string;
  joinedAt: string;
}

/**
 * dealtSeatNumbers: the seats included in this Hand, in dealing order
 * (starting immediately after dealerSeatNumber, wrapping around) —
 * frozen at deal time per the "join between Hands only" rule. deckOrder
 * is the full authoritative 52-card shuffled permutation; it is
 * server-only state and must never appear in any client-facing
 * projection (see getTableState.ts). Hole cards for the player at
 * dealtSeatNumbers[i] are deckOrder[i] and deckOrder[dealtSeatNumbers.length + i]
 * — one card to each active player in turn, twice around, mirroring
 * real dealing order rather than dealing two consecutive cards to each
 * player.
 */
export interface PokerHandRecord {
  pokerHandId: string;
  pokerTableId: string;
  handOrdinal: number;
  dealerSeatNumber: number;
  dealtSeatNumbers: number[];
  deckOrder: string[];
  dealtAt: string;
}

export interface CreatePokerTableResult {
  pokerTableId: string;
  roomCode: string;
  hostToken: string;
  maxSeats: number;
}

export interface JoinPokerTableResult {
  pokerSeatId: string;
  pokerTableId: string;
  seatNumber: number;
  displayName: string;
  participantToken: string;
}

export interface DealPokerHandResult {
  pokerHandId: string;
  pokerTableId: string;
  handOrdinal: number;
  dealerSeatNumber: number;
  dealtSeatNumbers: number[];
  alreadyDealt: boolean;
}

/** A seat as exposed by GET_TABLE_STATE — no participantToken. */
export interface SeatSummary {
  seatNumber: number;
  displayName: string;
  isDealer: boolean;
  inCurrentHand: boolean;
}

/**
 * The role-aware read projection. myHoleCards is populated only for
 * the calling participant's own seat, only once a Hand has been dealt
 * and their seat was included in it — never for the host, never for
 * any other seat. See getTableState.ts's own comment for the full
 * privacy rule and why the host does not automatically see hole cards.
 */
export interface GetTableStateResult {
  pokerTableId: string;
  roomCode: string;
  maxSeats: number;
  closedAt: string | null;
  seats: SeatSummary[];
  currentHandId: string | null;
  currentHandOrdinal: number | null;
  myHoleCards: [string, string] | null;
}

// --- Errors -------------------------------------------------------------

export class PokerRoomCodeCollisionError extends Error {
  constructor() {
    super("Room code collision against an active poker table.");
    this.name = "PokerRoomCodeCollisionError";
  }
}

export class PokerTableNotFoundError extends Error {
  constructor() {
    super("No poker table exists for this id.");
    this.name = "PokerTableNotFoundError";
  }
}

export class PokerTableClosedError extends Error {
  constructor() {
    super("This poker table is closed.");
    this.name = "PokerTableClosedError";
  }
}

export class PokerTableFullError extends Error {
  constructor() {
    super("This poker table already has the maximum number of seats filled.");
    this.name = "PokerTableFullError";
  }
}

export class PokerDisplayNameTakenError extends Error {
  constructor() {
    super("This display name is already seated at this table.");
    this.name = "PokerDisplayNameTakenError";
  }
}

export class PokerEmptyDisplayNameError extends Error {
  constructor() {
    super("Display name cannot be empty.");
    this.name = "PokerEmptyDisplayNameError";
  }
}

export class PokerDisplayNameTooLongError extends Error {
  constructor() {
    super("Display name cannot exceed 40 characters.");
    this.name = "PokerDisplayNameTooLongError";
  }
}

export class PokerTableAccessDeniedError extends Error {
  constructor() {
    super("This token does not grant access to this poker table.");
    this.name = "PokerTableAccessDeniedError";
  }
}

export class NotEnoughSeatedPlayersError extends Error {
  constructor() {
    super("At least two seated players are required to deal a hand.");
    this.name = "NotEnoughSeatedPlayersError";
  }
}

export class InvalidDeckError extends Error {
  constructor() {
    super("The supplied deck is not a valid 52-card permutation.");
    this.name = "InvalidDeckError";
  }
}
