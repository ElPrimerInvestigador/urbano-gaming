import type { SessionRecord } from "../types";
import { RoomCodeCollisionError } from "../types";
import type { SessionRepository } from "./sessionRepository";

/**
 * In-memory test double. Used only under __tests__. Mirrors the same
 * active-room-code-uniqueness rule enforced by the Postgres partial
 * unique index in production, so unit tests exercise the same logic
 * the real constraint would enforce.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();
  private events: Array<{ sessionId: string; eventType: string; payload: unknown }> = [];

  async insertSession(record: SessionRecord): Promise<void> {
    const collision = [...this.sessions.values()].some(
      (s) => s.roomCode === record.roomCode && s.state !== "SESSION_COMPLETE"
    );
    if (collision) {
      throw new RoomCodeCollisionError();
    }
    if (this.sessions.has(record.sessionId)) {
      throw new Error("Duplicate session_id insert.");
    }
    this.sessions.set(record.sessionId, { ...record });
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async insertEvent(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.events.push({ sessionId, eventType, payload });
  }

  /** Test-only helper, not part of the repository interface. */
  _getEventsForSession(sessionId: string) {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  /** Test-only helper to inspect current size / state for assertions. */
  _all() {
    return [...this.sessions.values()];
  }

  /**
   * Test-only helper to simulate a session reaching SESSION_COMPLETE.
   * No COMPLETE_SESSION command exists in this vertical slice's scope —
   * this exists solely to test the room-code-reuse assumption in isolation.
   */
  _forceComplete(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) {
      this.sessions.set(sessionId, { ...s, state: "SESSION_COMPLETE" });
    }
  }
}
