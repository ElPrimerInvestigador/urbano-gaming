import type { SessionRecord } from "../types";

/**
 * Repository interface for session persistence.
 *
 * This is a standard test seam (dependency inversion for unit testing),
 * not an architectural decision — it does not change product scope,
 * canonical state ownership, or introduce a new external service. The
 * approved stack (Supabase) is implemented in supabaseSessionRepository.ts;
 * inMemorySessionRepository.ts exists only to support automated tests per
 * CLAUDE.md's testing requirement, and is never used outside of __tests__.
 */
export interface SessionRepository {
  /**
   * Insert a new session row. Must enforce room_code uniqueness among
   * active (state !== 'SESSION_COMPLETE') sessions at the persistence
   * layer and throw RoomCodeCollisionError on collision.
   */
  insertSession(record: SessionRecord): Promise<void>;

  /** Used only by tests/validation to confirm a record round-trips. */
  getSessionById(sessionId: string): Promise<SessionRecord | null>;

  /** Append-only event log write, per Session Engine's event log requirement. */
  insertEvent(sessionId: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
}
