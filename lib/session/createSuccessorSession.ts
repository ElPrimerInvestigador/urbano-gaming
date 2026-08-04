import { randomUUID } from "crypto";
import { generateRoomCode } from "./roomCode";
import { generateHostToken } from "./hostToken";
import type { SessionRepository } from "./db/sessionRepository";
import type { CreateSessionResult, SessionRecord } from "./types";
import {
  RoomCodeCollisionError,
  SessionNotFoundError,
  HostTokenMismatchError,
  PredecessorSessionNotCompleteError,
  PredecessorAlreadyHasSuccessorError,
} from "./types";

/**
 * CREATE_SUCCESSOR_SESSION command handler.
 *
 * Session Continuity slice. A variant of CREATE_SESSION for the
 * host-initiated rematch flow: "create a new session, and remember
 * that it continues from this one." Everything CREATE_SESSION does
 * (fresh session_id, fresh room code with the usual collision retry,
 * fresh host token, LOBBY_OPEN, state_version 1) happens identically
 * here — the only addition is predecessorSessionId on the record and
 * the checks that justify setting it.
 *
 * Scope: verifies the caller's host token against the *predecessor*
 * session (not the session being created — it doesn't exist yet),
 * verifies the predecessor is SESSION_COMPLETE, and verifies the
 * predecessor does not already have a successor, before creating
 * exactly one new session record and its initial event as one atomic
 * operation. Nothing else — participants, scores, and prepared
 * questions are never copied; the new session starts exactly as empty
 * as any other CREATE_SESSION result. Carrying forward a display name
 * is a client-side pre-fill convenience (the participant's own browser
 * already remembers it from the predecessor), not something this
 * command does.
 *
 * Authority note: unlike every other host-scoped command in this
 * codebase, the predecessor's state cannot change concurrently with
 * this call — no repository method ever mutates a session once it
 * reaches SESSION_COMPLETE (see 0028's migration comment) — so the
 * SessionNotFoundError / HostTokenMismatchError /
 * PredecessorSessionNotCompleteError checks below are genuinely
 * authoritative from a single read, not merely a fast path awaiting a
 * repository-level re-check the way LOCK_LOBBY's or START_SESSION's
 * preconditions are. The one real race — two concurrent calls naming
 * the same predecessor — is guarded by
 * sessions_predecessor_session_id_unique (0028); the fast-path lookup
 * below exists only to produce a clean, immediate
 * PredecessorAlreadyHasSuccessorError in the common (non-racing) case,
 * not to replace that constraint.
 */

const MAX_ROOM_CODE_RETRIES = 5;

export async function createSuccessorSession(
  repo: SessionRepository,
  predecessorSessionId: string,
  hostToken: string
): Promise<CreateSessionResult> {
  const predecessor = await repo.getSessionById(predecessorSessionId);
  if (!predecessor) {
    throw new SessionNotFoundError();
  }

  if (predecessor.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (predecessor.state !== "SESSION_COMPLETE") {
    throw new PredecessorSessionNotCompleteError(predecessor.state);
  }

  const existingSuccessor = await repo.getSuccessorSessionByPredecessorId(
    predecessorSessionId
  );
  if (existingSuccessor) {
    throw new PredecessorAlreadyHasSuccessorError();
  }

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
      currentPromptId: null,
      predecessorSessionId,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await repo.createSession(record, {
        sessionId: record.sessionId,
        eventType: "SESSION_CREATED",
        payload: {
          roomCode: record.roomCode,
          predecessorSessionId,
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
      // Includes PredecessorAlreadyHasSuccessorError lost to a genuine
      // race against another concurrent call for the same
      // predecessor — not retried, since a new room code would not
      // resolve it.
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
