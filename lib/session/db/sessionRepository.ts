import type { SessionRecord } from "../types";

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
}