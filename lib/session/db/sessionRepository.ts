import type { SessionRecord } from "../types";

export interface SessionEventRecord {
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Repository interface for Session Engine persistence.
 *
 * The repository exposes conceptual persistence operations rather than
 * individual database writes. This ensures callers cannot accidentally
 * persist a session without its required initial event.
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

  /** Used by tests and validation to confirm a record round-trips. */
  getSessionById(sessionId: string): Promise<SessionRecord | null>;
}