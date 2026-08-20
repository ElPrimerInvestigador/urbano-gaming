import { randomUUID } from "crypto";
import type { PokerRepository } from "./pokerRepository";
import type { PokerTableRecord, PokerSeatRecord, PokerHandRecord } from "../types";
import {
  PokerRoomCodeCollisionError,
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableFullError,
  PokerDisplayNameTakenError,
  NotEnoughSeatedPlayersError,
} from "../types";
import { isValidStandardDeck } from "../deck";

/**
 * In-memory PokerRepository for behavioral tests — independently
 * re-implements the same invariants the real Postgres functions
 * enforce (seat allocation under a lock, display-name uniqueness,
 * table-full rejection, one-Hand-per-table idempotency, deck
 * validation), not a thin passthrough. Mirrors
 * InMemoryPredictionsRepository's own role exactly.
 */
export class InMemoryPokerRepository implements PokerRepository {
  private tables = new Map<string, PokerTableRecord>();
  private seats = new Map<string, PokerSeatRecord>();
  private hands = new Map<string, PokerHandRecord>();

  async createTable(record: PokerTableRecord): Promise<void> {
    const collision = [...this.tables.values()].some(
      (t) => t.roomCode === record.roomCode && t.closedAt === null
    );
    if (collision) throw new PokerRoomCodeCollisionError();
    this.tables.set(record.pokerTableId, record);
  }

  async getTableById(pokerTableId: string): Promise<PokerTableRecord | null> {
    return this.tables.get(pokerTableId) ?? null;
  }

  async getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null> {
    return (
      [...this.tables.values()].find(
        (t) => t.roomCode === roomCode && t.closedAt === null
      ) ?? null
    );
  }

  async joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord> {
    const table = this.tables.get(input.pokerTableId);
    if (!table) throw new PokerTableNotFoundError();
    if (table.closedAt !== null) throw new PokerTableClosedError();

    const existingSeats = [...this.seats.values()].filter(
      (s) => s.pokerTableId === input.pokerTableId
    );

    if (existingSeats.length >= table.maxSeats) {
      throw new PokerTableFullError();
    }

    if (
      existingSeats.some(
        (s) => s.normalizedDisplayName === input.normalizedDisplayName
      )
    ) {
      throw new PokerDisplayNameTakenError();
    }

    const nextSeatNumber =
      existingSeats.length === 0
        ? 0
        : Math.max(...existingSeats.map((s) => s.seatNumber)) + 1;

    const record: PokerSeatRecord = {
      pokerSeatId: randomUUID(),
      pokerTableId: input.pokerTableId,
      seatNumber: nextSeatNumber,
      displayName: input.displayName,
      normalizedDisplayName: input.normalizedDisplayName,
      participantToken: input.participantToken,
      joinedAt: new Date().toISOString(),
    };
    this.seats.set(record.pokerSeatId, record);
    return record;
  }

  async listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]> {
    return [...this.seats.values()]
      .filter((s) => s.pokerTableId === pokerTableId)
      .sort((a, b) => a.seatNumber - b.seatNumber);
  }

  async dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }> {
    const table = this.tables.get(input.pokerTableId);
    if (!table) throw new PokerTableNotFoundError();
    if (table.closedAt !== null) throw new PokerTableClosedError();

    const existing = [...this.hands.values()].find(
      (h) => h.pokerTableId === input.pokerTableId
    );
    if (existing) {
      return { hand: existing, alreadyDealt: true };
    }

    const seatedNumbers = new Set(
      [...this.seats.values()]
        .filter((s) => s.pokerTableId === input.pokerTableId)
        .map((s) => s.seatNumber)
    );
    const dealtSet = new Set(input.dealtSeatNumbers);
    const dealtAreAllSeated = [...dealtSet].every((n) => seatedNumbers.has(n));

    if (dealtSet.size < 2 || !dealtAreAllSeated) {
      throw new NotEnoughSeatedPlayersError();
    }

    if (!isValidStandardDeck(input.deckOrder)) {
      throw new Error("INVALID_DECK: the supplied deck is not a valid 52-card permutation.");
    }

    const record: PokerHandRecord = {
      pokerHandId: randomUUID(),
      pokerTableId: input.pokerTableId,
      handOrdinal: 1,
      dealerSeatNumber: input.dealerSeatNumber,
      dealtSeatNumbers: input.dealtSeatNumbers,
      deckOrder: input.deckOrder,
      dealtAt: new Date().toISOString(),
    };
    this.hands.set(record.pokerHandId, record);
    return { hand: record, alreadyDealt: false };
  }

  async getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    return (
      [...this.hands.values()].find((h) => h.pokerTableId === pokerTableId) ?? null
    );
  }
}
