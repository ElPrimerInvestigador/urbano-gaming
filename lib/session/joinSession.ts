import { randomUUID } from "crypto";
import { generateHostToken as generateParticipantToken } from "./hostToken";
import type { SessionRepository } from "./db/sessionRepository";
import type { ParticipantRecord, ParticipantJoinedEventRecord } from "./db/sessionRepository";
import type { JoinSessionResult } from "./types";
import {
  SessionNotFoundError,
  LobbyNotOpenError,
  EmptyDisplayNameError,
  DisplayNameTooLongError,
} from "./types";

/**
 * JOIN_SESSION command handler.
 *
 * Scope: resolves a room code to an active session, verifies the lobby
 * is open, validates and normalizes the supplied display name, and
 * persists exactly one participant plus its PARTICIPANT_JOINED event as
 * one atomic operation (via SessionRepository.joinParticipant). Nothing
 * else — no readiness, no lobby broadcast, no state transition.
 *
 * Idempotency correction: session-scoped normalized display-name
 * uniqueness is duplicate-name *enforcement*, not command-level
 * idempotency. A repeated join request with the same display name does
 * NOT return the original participant — it is rejected as
 * DisplayNameTakenError. This is explicit MVP behavior.
 *
 * Session-state authority: the getActiveSessionByRoomCode lookup below
 * is a fast-path check for a clear, immediate rejection (nonexistent
 * room, obviously-closed lobby) — it is NOT the sole guarantee that the
 * session is still joinable. The repository's joinParticipant call is
 * the authoritative check, re-verifying session state inside the same
 * atomic persistence operation that inserts the participant, to close
 * the race window between this lookup and that write.
 *
 * Note on token generation: reuses the same opaque, high-entropy token
 * generator used for the host token. The function name (generateHostToken)
 * is generic in implementation despite the name — imported under an alias
 * here rather than duplicating it.
 */

const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Validates and trims a submitted display name per the MVP display-name
 * floor: at least one visible character after trimming, at most 40
 * characters after trimming. Returns the trimmed value, which is what
 * gets persisted for presentation.
 */
function validateAndTrimDisplayName(displayName: string): string {
  const trimmed = displayName.trim();

  if (trimmed.length === 0) {
    throw new EmptyDisplayNameError();
  }

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new DisplayNameTooLongError();
  }

  return trimmed;
}

function normalizeDisplayName(trimmedDisplayName: string): string {
  return trimmedDisplayName.toLowerCase();
}

/**
 * Normalizes a submitted room code for lookup: trims incidental
 * whitespace (e.g. copy-paste) and uppercases it, matching the
 * uppercase-only alphabet generateRoomCode produces. Neither repository
 * implementation normalizes on its own, so this must happen here.
 */
function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

/**
 * URBANO Gaming Identity Foundation: gamingMemberId is an optional,
 * additive 4th parameter. Every pre-Identity-Foundation caller (and
 * every existing test) omits it, defaulting to null — the exact
 * existing Guest path, byte-identical. A caller supplies a non-null
 * value only after independently verifying the Gaming Member's
 * identity and profile completeness (see lib/gaming and the join
 * route) — this function trusts its caller completely and performs no
 * verification of its own, mirroring how it has never verified
 * participantToken's provenance either.
 */
export async function joinSession(
  repo: SessionRepository,
  roomCode: string,
  displayName: string,
  gamingMemberId: string | null = null
): Promise<JoinSessionResult> {
  const trimmedDisplayName = validateAndTrimDisplayName(displayName);
  const normalizedRoomCode = normalizeRoomCode(roomCode);

  const session = await repo.getActiveSessionByRoomCode(normalizedRoomCode);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.state !== "LOBBY_OPEN") {
    throw new LobbyNotOpenError(session.state);
  }

  const now = new Date().toISOString();
  const record: ParticipantRecord = {
    participantId: randomUUID(),
    sessionId: session.sessionId,
    displayName: trimmedDisplayName,
    normalizedDisplayName: normalizeDisplayName(trimmedDisplayName),
    participantToken: generateParticipantToken(),
    joinedAt: now,
    gamingMemberId,
  };

  const joinedEvent: ParticipantJoinedEventRecord = {
    sessionId: session.sessionId,
    eventType: "PARTICIPANT_JOINED",
    payload: {
      participantId: record.participantId,
      displayName: record.displayName,
    },
  };

  // No idempotent-return path: a DisplayNameTakenError propagates directly
  // to the caller. This call is also where session-state is authoritatively
  // re-verified (see module note above) — a LobbyNotOpenError or
  // SessionNotFoundError raised here reflects a state change that happened
  // after the lookup above, not a stale duplicate of it.
  await repo.joinParticipant(record, joinedEvent);

  return {
    participantId: record.participantId,
    participantToken: record.participantToken,
    sessionId: session.sessionId,
    sessionState: session.state,
    displayName: record.displayName,
    gamingMemberId: record.gamingMemberId,
  };
}
