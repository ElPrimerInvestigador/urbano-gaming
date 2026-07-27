import { randomUUID } from "crypto";
import type { SessionRecord, InteractionState } from "../types";
import {
  RoomCodeCollisionError,
  DisplayNameTakenError,
  SessionNotFoundError,
  LobbyNotOpenError,
  LobbyNotLockedError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  SubmissionsNotClosedError,
  PreviousInteractionNotRevealedError,
  EmptyPromptTextError,
  PromptTextTooLongError,
} from "../types";
import type {
  SessionEventRecord,
  ParticipantRecord,
  ParticipantJoinedEventRecord,
  LobbyLockedEventRecord,
  SessionCompletedEventRecord,
  PromptRecord,
  InteractionInstanceRecord,
  SubmissionRecord,
  SubmissionsClosedEventRecord,
  ResultsRevealedEventRecord,
  SessionRepository,
} from "./sessionRepository";

const MAX_PROMPT_TEXT_LENGTH = 1000;

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

  private submissions = new Map<string, SubmissionRecord>();

  private prompts = new Map<string, PromptRecord>();

  /**
   * Slice 001 (Session / Interaction separation). No seeded content —
   * unlike prompts, which were previously seeded with one fixed row,
   * interaction instances (and the prompts that back them) are always
   * created dynamically from host-supplied text via startSession.
   */
  private interactionInstances = new Map<string, InteractionInstanceRecord>();

  /**
   * The current interaction instance for a session is "the most
   * recently created one" — never a stored pointer (see the accepted
   * Slice 001 design's stress test). Returns null if no interaction
   * has ever been started for this session.
   */
  private getCurrentInteractionInstance(
    sessionId: string
  ): InteractionInstanceRecord | null {
    const instances = [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return instances.length > 0 ? instances[instances.length - 1] : null;
  }

  private validateAndTrimPromptText(text: string): string {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      throw new EmptyPromptTextError();
    }

    if (trimmed.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new PromptTextTooLongError();
    }

    return trimmed;
  }

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

  async getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]> {
    return [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async startSession(
    sessionId: string,
    hostToken: string,
    promptText: string
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
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

    const trimmedPromptText = this.validateAndTrimPromptText(promptText);

    // Re-invocable precondition: the session's current interaction
    // instance, if any, must already be RESULT_REVEAL before another
    // one may begin.
    const previousInteraction = this.getCurrentInteractionInstance(sessionId);
    if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
      throw new PreviousInteractionNotRevealedError(previousInteraction.state);
    }

    const now = new Date().toISOString();
    const promptId = randomUUID();
    this.prompts.set(promptId, { promptId, text: trimmedPromptText });

    const interactionInstanceId = randomUUID();
    const interactionInstance: InteractionInstanceRecord = {
      interactionInstanceId,
      sessionId,
      promptId,
      state: "PROMPT_ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    this.interactionInstances.set(interactionInstanceId, interactionInstance);

    this.events.push({
      sessionId,
      eventType: "INTERACTION_STARTED",
      payload: { interactionInstanceId, promptId },
    });

    return {
      interactionInstanceId,
      promptId,
      state: "PROMPT_ACTIVE",
    };
  }

  async submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    promptId: string;
    updatedAt: string;
  }> {
    // Authoritative participant-token and session/interaction-state
    // re-check, independent of any earlier application-layer lookup.
    // Mirrors submit_response_atomically's row-locked re-check in the
    // real database function. Also re-resolves the current interaction
    // instance here (not trusting an earlier domain-layer read), since
    // that's what the submission and its event are scoped to.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const { interactionInstanceId, promptId } = interactionInstance;
    const now = new Date().toISOString();

    // Upsert: one submission per participant per interaction instance.
    // "Last write wins" is an explicit MVP implementation decision, not
    // a permanent gameplay rule — see SubmitResponseResult's doc
    // comment.
    const existing = [...this.submissions.values()].find(
      (submission) =>
        submission.interactionInstanceId === interactionInstanceId &&
        submission.participantId === participantId
    );

    const submissionId = existing?.submissionId ?? randomUUID();
    const record: SubmissionRecord = {
      submissionId,
      sessionId,
      interactionInstanceId,
      participantId,
      promptId,
      text,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.submissions.set(submissionId, record);

    this.events.push({
      sessionId,
      eventType: "RESPONSE_SUBMITTED",
      payload: { participantId, interactionInstanceId, promptId },
    });

    return { submissionId, interactionInstanceId, promptId, updatedAt: now };
  }

  async getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]> {
    return [...this.submissions.values()].filter(
      (submission) => submission.interactionInstanceId === interactionInstanceId
    );
  }

  async closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "SUBMISSIONS_CLOSED",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "SUBMISSIONS_CLOSED"
    ) {
      throw new SubmissionsNotClosedError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "RESULT_REVEAL",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
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

  /** Test-only helper, not part of the repository interface. */
  _allInteractionInstances() {
    return [...this.interactionInstances.values()];
  }
}
