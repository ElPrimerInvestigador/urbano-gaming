import type { SessionRecord, SessionState } from "../types";

export interface SessionEventRecord {
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ParticipantRecord {
  participantId: string;
  sessionId: string;
  displayName: string;
  normalizedDisplayName: string;
  participantToken: string;
  joinedAt: string;
}

export interface ParticipantJoinedEventRecord extends SessionEventRecord {
  eventType: "PARTICIPANT_JOINED";
  payload: {
    participantId: string;
    displayName: string;
  };
}

export interface LobbyLockedEventRecord extends SessionEventRecord {
  eventType: "LOBBY_LOCKED";
  payload: Record<string, never>;
}

export interface SessionCompletedEventRecord extends SessionEventRecord {
  eventType: "SESSION_COMPLETED";
  payload: Record<string, never>;
}

/**
 * Repository interface for Session Engine persistence.
 *
 * The repository exposes conceptual persistence operations rather than
 * individual database writes. This ensures callers cannot accidentally
 * persist an aggregate without its required event.
 */
export interface SessionRepository {
  /**
   * Persist a new session and its initial event as one atomic operation.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce active room-code uniqueness;
   * - throw RoomCodeCollisionError only when room_code collides.
   */
  createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void>;

  /**
   * Persist a participant and its PARTICIPANT_JOINED event atomically.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce session-scoped normalized display-name uniqueness;
   * - translate only the display-name uniqueness violation into the
   *   corresponding domain error.
   */
  joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void>;

  /**
   * Resolve a room code to its active (non-SESSION_COMPLETE) session.
   * Required by JOIN_SESSION to validate the target session exists and
   * is joinable before persisting a participant.
   */
  getActiveSessionByRoomCode(roomCode: string): Promise<SessionRecord | null>;

  /** Used by tests and validation to confirm a session round-trips. */
  getSessionById(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * LOBBY_OPEN, then transition it to LOBBY_LOCKED, increment
   * state_version, and persist the LOBBY_LOCKED event — as one atomic
   * operation, mirroring joinParticipant's authoritative re-check.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotOpenError only when the session is not LOBBY_OPEN;
   * - return the authoritative post-transition state and state_version.
   */
  lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;

  /**
   * List all participants for a session, ordered by joinedAt ascending.
   * Not filtered by session state — GET_SESSION must be able to read a
   * session's participant list regardless of its current state.
   *
   * Tie-break contract: if multiple participants share the same
   * joinedAt timestamp, their relative order is intentionally
   * unspecified and must not be relied upon by consumers. The
   * guarantee implementations must uphold is determinism — repeated
   * calls against the same underlying data return the same order every
   * time. How a given implementation achieves that (a secondary sort
   * key, an incidental property of its storage model, or anything
   * else) is an implementation detail, not part of this contract.
   */
  getParticipantsForSession(sessionId: string): Promise<ParticipantRecord[]>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * not already SESSION_COMPLETE, then transition it to SESSION_COMPLETE,
   * increment state_version, and persist the SESSION_COMPLETED event —
   * as one atomic operation, mirroring lockLobby's authoritative
   * re-check.
   *
   * Per Interpretation 2 (administrative termination): this is callable
   * from any state except SESSION_COMPLETE itself — there is no single
   * required source state the way LOCK_LOBBY requires LOBBY_OPEN.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw SessionAlreadyCompleteError only when the session is already
   *   SESSION_COMPLETE;
   * - return the authoritative post-transition state and state_version.
   */
  completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;
}