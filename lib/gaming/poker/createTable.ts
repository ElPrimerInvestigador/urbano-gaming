import { randomUUID } from "crypto";
import { generateRoomCode } from "../../session/roomCode";
import { generateHostToken } from "../../session/hostToken";
import type { PokerRepository } from "./db/pokerRepository";
import type { CreatePokerTableResult, PokerTableRecord } from "./types";
import { PokerRoomCodeCollisionError } from "./types";

/**
 * CREATE_POKER_TABLE command handler. Mirrors createSession.ts exactly:
 * generate-and-retry room code allocation in the domain layer, not an
 * atomic SQL function — there is no concurrent-mutation race here,
 * only a collision to retry past. Reuses generateRoomCode/
 * generateHostToken directly (pure, dependency-free utilities) rather
 * than duplicating them — the one piece of Session's own code this
 * module imports, deliberately, per the readiness gate's own finding
 * that these two functions are genuinely reusable primitives with zero
 * coupling to Session's tables.
 */

const MAX_ROOM_CODE_RETRIES = 5;
const DEFAULT_MAX_SEATS = 6;
const MIN_MAX_SEATS = 2;

export async function createTable(
  repo: PokerRepository,
  input: { maxSeats?: number } = {}
): Promise<CreatePokerTableResult> {
  const maxSeats = input.maxSeats ?? DEFAULT_MAX_SEATS;
  if (!Number.isInteger(maxSeats) || maxSeats < MIN_MAX_SEATS || maxSeats > DEFAULT_MAX_SEATS) {
    throw new Error("Poker table max seats must be an integer between 2 and 6.");
  }

  for (let attempt = 0; attempt < MAX_ROOM_CODE_RETRIES; attempt++) {
    const record: PokerTableRecord = {
      pokerTableId: randomUUID(),
      roomCode: generateRoomCode(),
      hostToken: generateHostToken(),
      maxSeats,
      closedAt: null,
      createdAt: new Date().toISOString(),
    };

    try {
      await repo.createTable(record);
      return {
        pokerTableId: record.pokerTableId,
        roomCode: record.roomCode,
        hostToken: record.hostToken,
        maxSeats: record.maxSeats,
      };
    } catch (err) {
      if (err instanceof PokerRoomCodeCollisionError) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to allocate a unique poker table room code after ${MAX_ROOM_CODE_RETRIES} attempts.`
  );
}
