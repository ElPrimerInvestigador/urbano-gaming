import { generateHostToken as generateParticipantToken } from "../../session/hostToken";
import type { PokerRepository } from "./db/pokerRepository";
import type { JoinPokerTableResult } from "./types";
import {
  PokerTableNotFoundError,
  PokerEmptyDisplayNameError,
  PokerDisplayNameTooLongError,
} from "./types";

/**
 * JOIN_POKER_TABLE command handler. Mirrors joinSession.ts's own
 * validation/normalization/token-generation exactly, including its
 * "no idempotent-return path" behavior — a genuine retry with the same
 * display name is rejected as PokerDisplayNameTakenError by the
 * repository's uniqueness enforcement, not silently deduplicated.
 */

const MAX_DISPLAY_NAME_LENGTH = 40;

function validateAndTrimDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) throw new PokerEmptyDisplayNameError();
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) throw new PokerDisplayNameTooLongError();
  return trimmed;
}

function normalizeDisplayName(trimmedDisplayName: string): string {
  return trimmedDisplayName.toLowerCase();
}

function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

export async function joinTable(
  repo: PokerRepository,
  roomCode: string,
  displayName: string
): Promise<JoinPokerTableResult> {
  const trimmedDisplayName = validateAndTrimDisplayName(displayName);
  const normalizedRoomCode = normalizeRoomCode(roomCode);

  const table = await repo.getActiveTableByRoomCode(normalizedRoomCode);
  if (!table) {
    throw new PokerTableNotFoundError();
  }

  const seat = await repo.joinTable({
    pokerTableId: table.pokerTableId,
    displayName: trimmedDisplayName,
    normalizedDisplayName: normalizeDisplayName(trimmedDisplayName),
    participantToken: generateParticipantToken(),
  });

  return {
    pokerSeatId: seat.pokerSeatId,
    pokerTableId: seat.pokerTableId,
    seatNumber: seat.seatNumber,
    displayName: seat.displayName,
    participantToken: seat.participantToken,
  };
}
