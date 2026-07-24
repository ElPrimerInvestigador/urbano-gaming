import { randomUUID } from "crypto";
import type { SessionRecord } from "../types";
import {
  RoomCodeCollisionError,
  DisplayNameTakenError,
  SessionNotFoundError,
  LobbyNotOpenError,
  LobbyNotLockedError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
} from "../types";
import type {
  SessionEventRecord,
  ParticipantRecord,
  ParticipantJoinedEventRecord,
  LobbyLockedEventRecord,
  SessionCompletedEventRecord,
  PromptRecord,
  SessionRepository,
} from "./sessionRepository";

/**
 * Engineering seed prompt — placeholder content whose only purpose is
 * validating the START_SESSION pipeline (transition, persistence,
 * GET_SESSION integration). Not production copy; replace freely without
 * any architectural impact.
 */
const ENGINEERING_SEED_PROMPT_TEXT =
  "[ENGINEERING SEED PROMPT — placeholder, not production copy] What's one thing you're looking forward to this week?";

/**
 * In-memory test double.
 *
 * createSession mirrors the production repository's conceptual atomic
 * operation: validation occurs before either the session or event is stored.
 * joinParticipant follows the identical pattern for participants, and is
 * independently authoritative for session-state — it re-checks the
 * session's current state itself rather than trusting a caller's earlier
 * lookup, mirroring join_participant_atomically's row-locked re-check in
 * the real database function.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();

  private participants = new Map<string, ParticipantRecord>();

  private events: Array<SessionEventRecord> = [];

  /**
   * Seeded with exactly one prompt at construction, mirroring the
   * production migration's single-row seed. current_prompt_id is an
   * explicit MVP optimization, not a commitment to the long-term
   * gameplay model.
   */
  private prompts = new Map<string, PromptRecord>([
    (() => {
      const promptId = randomUUID();
      return [
        promptId,
        { promptId, text: ENGINEERING_SEED_PROMPT_TEXT },
      ] as const;
    })(),
  ]);

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

  async joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void> {
    // Authoritative session-state re-check, independent of any earlier
    // application-layer lookup. Mirrors join_participant_atomically's
    // row-locked re-check in the real database function.
    const session = this.sessions.get(record.sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    const nameCollision = [...this.participants.values()].some(
      (participant) =>
        participant.sessionId === record.sessionId &&
        participant.normalizedDisplayName === record.normalizedDisplayName
    );

    if (nameCollision) {
      throw new DisplayNameTakenError();
    }

    if (this.participants.has(record.participantId)) {
      throw new Error("Duplicate participant_id insert.");
    }

    if (joinedEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Joined event sessionId must match the participant's session."
      );
    }

    /*
     * No mutation occurs before every validation succeeds, matching
     * createSession's all-or-nothing behavior.
     */
    this.participants.set(record.participantId, { ...record });

    this.events.push({
      sessionId: joinedEvent.sessionId,
      eventType: joinedEvent.eventType,
      payload: { ...joinedEvent.payload },
    });
  }

  async getActiveSessionByRoomCode(
    roomCode: string
  ): Promise<SessionRecord | null> {
    const match = [...this.sessions.values()].find(
      (session) =>
        session.roomCode === roomCode && session.state !== "SESSION_COMPLETE"
    );

    return match ?? null;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // lock_lobby_atomically's row-locked re-check in the real database
    // function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Lock event sessionId must match the session being locked."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "LOBBY_LOCKED",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async getParticipantsForSession(
    sessionId: string
  ): Promise<ParticipantRecord[]> {
    return [...this.participants.values()]
      .filter((participant) => participant.sessionId === sessionId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // complete_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state === "SESSION_COMPLETE") {
      throw new SessionAlreadyCompleteError();
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Completion event sessionId must match the session being completed."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "SESSION_COMPLETE",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async getPromptById(promptId: string): Promise<PromptRecord | null> {
    return this.prompts.get(promptId) ?? null;
  }

  async startSession(
    sessionId: string,
    hostToken: string
  ): Promise<{
    state: SessionRecord["state"];
    stateVersion: number;
    currentPromptId: string;
  }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // start_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    // Prompt selection swap point: today, exactly one prompt exists, so
    // this is trivially deterministic. A future selection strategy
    // (random, round-robin, exclude-already-used) replaces only this
    // line — no change to anything above or below it.
    const [selectedPrompt] = this.prompts.values();

    const updated: SessionRecord = {
      ...session,
      state: "PROMPT_ACTIVE",
      currentPromptId: selectedPrompt.promptId,
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId,
      eventType: "SESSION_STARTED",
      payload: { promptId: selectedPrompt.promptId },
    });

    return {
      state: updated.state,
      stateVersion: updated.stateVersion,
      currentPromptId: selectedPrompt.promptId,
    };
  }

  /** Test-only helper, not part of the repository interface. */
  _getEventsForSession(sessionId: string) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  /** Test-only helper to inspect current size and state. */
  _all() {
    return [...this.sessions.values()];
  }

  /** Test-only helper to inspect stored participants. */
  _allParticipants() {
    return [...this.participants.values()];
  }

  /**
   * Test-only helper to jump a session directly to SESSION_COMPLETE
   * without going through completeSession()'s host-token check —
   * useful for tests that only need a completed session as setup, not
   * as the behavior under test.
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

  /** Test-only helper to force a session into an arbitrary state directly. */
  _forceState(sessionId: string, state: SessionRecord["state"]) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, { ...session, state });
    }
  }
}