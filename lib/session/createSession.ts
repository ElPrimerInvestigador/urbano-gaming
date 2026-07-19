import { randomUUID } from "crypto";
import { generateRoomCode } from "./roomCode";
import { generateHostToken } from "./hostToken";
import type { SessionRepository } from "./db/sessionRepository";
import type { CreateSessionResult, SessionRecord } from "./types";
import { RoomCodeCollisionError } from "./types";

/**
 * CREATE_SESSION command handler.
 *
 * Scope: creates exactly one session record in LOBBY_OPEN with
 * state_version = 1, pause_reason = null, a unique active room code,
 * and a host token. Writes one event log entry. Nothing else.
 *
 * This function contains no transport concerns (HTTP, auth headers) —
 * those belong to the API route that calls it. This keeps the command
 * logic testable independent of Next.js or Supabase specifics.
 */

const MAX_ROOM_CODE_RETRIES = 5;

export async function createSession(
  repo: SessionRepository
): Promise<CreateSessionResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ROOM_CODE_RETRIES; attempt++) {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: randomUUID(),
      roomCode: generateRoomCode(),
      hostToken: generateHostToken(),
      state: "LOBBY_OPEN",
      stateVersion: 1,
      pauseReason: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await repo.createSession(record, {
  sessionId: record.sessionId,
  eventType: "SESSION_CREATED",
  payload: {
    roomCode: record.roomCode,
  },
});

      return {
        sessionId: record.sessionId,
        roomCode: record.roomCode,
        hostToken: record.hostToken,
        state: record.state,
        stateVersion: record.stateVersion,
      };
    } catch (err) {
      if (err instanceof RoomCodeCollisionError) {
        lastError = err;
        continue; // regenerate and retry, per finalized data model
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to allocate a unique room code after ${MAX_ROOM_CODE_RETRIES} attempts.`
  );
  // lastError intentionally not re-thrown directly — this message is more
  // actionable for operators than surfacing the final collision alone.
  void lastError;
}
