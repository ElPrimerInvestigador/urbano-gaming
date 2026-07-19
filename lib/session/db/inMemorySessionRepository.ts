import type { SessionRecord } from "../types";
import { RoomCodeCollisionError } from "../types";
import type {
  SessionEventRecord,
  SessionRepository,
} from "./sessionRepository";

/**
 * In-memory test double.
 *
 * createSession mirrors the production repository's conceptual atomic
 * operation: validation occurs before either the session or event is stored.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();

  private events: Array<SessionEventRecord> = [];

  async createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void> {
    const collision = [...this.sessions.values()].some(
      (session) =>
        session.roomCode === record.roomCode &&
        session.state !== "SESSION_COMPLETE"
    );

    if (collision) {
      throw new RoomCodeCollisionError();
    }

    if (this.sessions.has(record.sessionId)) {
      throw new Error("Duplicate session_id insert.");
    }

    if (initialEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Initial event sessionId must match the session being created."
      );
    }

    /*
     * No mutation occurs before every validation succeeds. This preserves
     * all-or-nothing behavior within the in-memory implementation.
     */
    this.sessions.set(record.sessionId, { ...record });

    this.events.push({
      sessionId: initialEvent.sessionId,
      eventType: initialEvent.eventType,
      payload: { ...initialEvent.payload },
    });
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Test-only helper, not part of the repository interface. */
  _getEventsForSession(sessionId: string) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  /** Test-only helper to inspect current size and state. */
  _all() {
    return [...this.sessions.values()];
  }

  /**
   * Test-only helper to simulate a session reaching SESSION_COMPLETE.
   * No COMPLETE_SESSION command exists in this vertical slice.
   */
  _forceComplete(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, {
        ...session,
        state: "SESSION_COMPLETE",
      });
    }
  }
}