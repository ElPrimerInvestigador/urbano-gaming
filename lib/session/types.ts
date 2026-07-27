/**
 * Types matching the finalized Session Data Model.
 * Fields beyond what CREATE_SESSION needs (e.g. participants) are
 * intentionally not modeled here — out of scope for this vertical slice.
 */

export type SessionState =
  | "LOBBY_OPEN"
  | "LOBBY_LOCKED"
  | "SESSION_INTRO"
  | "PROMPT_ACTIVE"
  | "SUBMISSIONS_CLOSED"
  | "RESULT_REVEAL"
  | "SOCIAL_PAUSE"
  | "SESSION_COMPLETE"
  | "SESSION_PAUSED";

export type PauseReason = "MANUAL" | "HOST_DISCONNECTED" | null;

/**
 * Slice 001 (Session / Interaction separation): the lifecycle of one
 * Interaction Instance, independent of the session's own (now
 * narrower) lifecycle. These three values are already members of
 * SessionState above — kept as literal members there rather than
 * removed, since the sessions.state check constraint still permits
 * them and no existing historical row needs to change shape. Going
 * forward, the application only ever writes them to
 * interaction_instances.state, never to sessions.state.
 */
export type InteractionState =
  | "PROMPT_ACTIVE"
  | "SUBMISSIONS_CLOSED"
  | "RESULT_REVEAL";

export interface SessionRecord {
  sessionId: string;
  roomCode: string;
  hostToken: string;
  state: SessionState;
  stateVersion: number;
  pauseReason: PauseReason;
  /**
   * Explicit MVP optimization, not a commitment to the long-term
   * gameplay model — a future "rounds" concept may eventually own
   * prompt selection instead of the session row directly.
   */
  currentPromptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionResult {
  sessionId: string;
  roomCode: string;
  hostToken: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Result of a successful LOCK_LOBBY.
 */
export interface LockLobbyResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Result of a successful COMPLETE_SESSION.
 */
export interface CompleteSessionResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Result of a successful START_SESSION. Slice 001: this command is now
 * re-invocable — once per interaction, not once per session — and
 * always creates a fresh interaction instance from host-supplied
 * prompt text. The session's own state/stateVersion never change as a
 * result of this call (the session was already LOBBY_LOCKED and stays
 * that way for every interaction it runs), so this result describes
 * only the newly created interaction instance.
 */
export interface StartSessionResult {
  sessionId: string;
  interactionInstanceId: string;
  promptId: string;
  state: InteractionState;
}

/**
 * Result of a successful SUBMIT_RESPONSE. "Latest response replaces the
 * previous one" (last-write-wins) is an explicit MVP implementation
 * decision, not a permanent gameplay rule — future product validation
 * may determine immutable submissions or a different revision policy
 * (e.g. a submit-once lock, an edit history, or a host-controlled
 * revision window). Revisit this deliberately rather than assuming the
 * current behavior is load-bearing.
 */
export interface SubmitResponseResult {
  submissionId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  text: string;
  updatedAt: string;
}

/**
 * Result of a successful CLOSE_SUBMISSIONS. Slice 001: describes the
 * interaction instance that closed, not the session — the session's
 * own state does not change.
 */
export interface CloseSubmissionsResult {
  sessionId: string;
  interactionInstanceId: string;
  state: InteractionState;
}

/**
 * Result of a successful REVEAL_RESULTS. Slice 001: describes the
 * interaction instance that revealed, not the session.
 */
export interface RevealResultsResult {
  sessionId: string;
  interactionInstanceId: string;
  state: InteractionState;
}

/** A participant as exposed by GET_SESSION — no token, no join timestamp. */
export interface ParticipantSummary {
  participantId: string;
  displayName: string;
}

/** A prompt as exposed by GET_SESSION. */
export interface PromptSummary {
  promptId: string;
  text: string;
}

/**
 * A submitted response as exposed by GET_SESSION during RESULT_REVEAL.
 * No anonymity for the MVP — attributed directly to the participant.
 */
export interface SubmissionSummary {
  participantId: string;
  displayName: string;
  text: string;
}

/**
 * Result of a successful GET_SESSION. Never includes hostToken or any
 * participantToken.
 *
 * Slice 001: `state` is now the session's own narrower lifecycle
 * (LOBBY_OPEN | LOBBY_LOCKED | SESSION_COMPLETE) — it no longer
 * reflects prompt/submission/reveal phase. `interactionNumber` and
 * `interactionState` describe the current interaction instance (the
 * most recently started one for this session), both null before any
 * interaction has ever been started. interactionNumber is a 1-indexed
 * count of interactions started so far — derived at read time from
 * however many interaction_instances rows exist for this session, not
 * a stored value (see the accepted Slice 001 design's stress test).
 *
 * submittedCount / eligibleParticipantCount are populated while the
 * current interaction is PROMPT_ACTIVE or SUBMISSIONS_CLOSED, null
 * otherwise. submissions is populated only while the current
 * interaction is RESULT_REVEAL (including after SESSION_COMPLETE, if
 * the session completed after revealing — mirroring currentPrompt's
 * precedent), null otherwise — response text is never exposed before
 * RESULT_REVEAL. Both are scoped to the *current* interaction only;
 * this slice does not expose past interactions' submissions.
 */
export interface GetSessionResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
  participants: ParticipantSummary[];
  interactionNumber: number | null;
  interactionState: InteractionState | null;
  currentPrompt: PromptSummary | null;
  submittedCount: number | null;
  eligibleParticipantCount: number | null;
  submissions: SubmissionSummary[] | null;
}

/** Raised when a generated room code collides with an active session. */
export class RoomCodeCollisionError extends Error {
  constructor() {
    super("Room code collision against an active session.");
    this.name = "RoomCodeCollisionError";
  }
}

/**
 * Result of a successful JOIN_SESSION.
 */
export interface JoinSessionResult {
  participantId: string;
  participantToken: string;
  sessionId: string;
  sessionState: SessionState;
  displayName: string;
}

/**
 * Raised when a command targets a session that does not exist (by room
 * code or by session id, depending on the caller). Shared across
 * JOIN_SESSION and LOCK_LOBBY.
 */
export class SessionNotFoundError extends Error {
  constructor() {
    super("No active session found.");
    this.name = "SessionNotFoundError";
  }
}

/**
 * Raised when a command requires the session to be LOBBY_OPEN and it is
 * not. Shared across JOIN_SESSION and LOCK_LOBBY — the message is
 * intentionally action-neutral rather than naming a specific command.
 */
export class LobbyNotOpenError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not LOBBY_OPEN.`
        : "Session is no longer LOBBY_OPEN."
    );
    this.name = "LobbyNotOpenError";
  }
}

/**
 * Raised when a command requires the session to be LOBBY_LOCKED and it
 * is not. Distinct from LobbyNotOpenError, which means the opposite
 * requirement (needs OPEN, isn't) — this means the session hasn't been
 * locked yet, or has already moved past LOBBY_LOCKED.
 */
export class LobbyNotLockedError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not LOBBY_LOCKED.`
        : "Session is no longer LOBBY_LOCKED."
    );
    this.name = "LobbyNotLockedError";
  }
}

/**
 * Raised when LOCK_LOBBY's supplied host token does not match the
 * session's stored host token.
 */
export class HostTokenMismatchError extends Error {
  constructor() {
    super("Host token does not match this session.");
    this.name = "HostTokenMismatchError";
  }
}

/**
 * Raised when GET_SESSION's supplied bearer token matches neither the
 * session's host token nor any participant's token for that session.
 */
export class SessionAccessDeniedError extends Error {
  constructor() {
    super("This token does not grant access to this session.");
    this.name = "SessionAccessDeniedError";
  }
}

/**
 * Raised when COMPLETE_SESSION targets a session that is already
 * SESSION_COMPLETE. Per Interpretation 2 (administrative termination),
 * this is the only state COMPLETE_SESSION rejects — every other state
 * is a valid source state.
 */
export class SessionAlreadyCompleteError extends Error {
  constructor() {
    super("Session is already complete.");
    this.name = "SessionAlreadyCompleteError";
  }
}

/**
 * Raised when a command requires the current interaction instance to
 * be PROMPT_ACTIVE and it is not — either because no interaction has
 * been started yet, or because the current one has already moved past
 * PROMPT_ACTIVE, or because the session itself is no longer
 * LOBBY_LOCKED (e.g. already completed). Shared across SUBMIT_RESPONSE
 * and CLOSE_SUBMISSIONS, which have the identical precondition.
 * Slice 001: the state described is now the interaction instance's,
 * not the session's, though the type remains SessionState since
 * InteractionState's members are already a subset of it.
 */
export class PromptNotActiveError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not PROMPT_ACTIVE.`
        : "Session is no longer PROMPT_ACTIVE."
    );
    this.name = "PromptNotActiveError";
  }
}

/**
 * Raised when REVEAL_RESULTS targets a session whose current
 * interaction instance is not SUBMISSIONS_CLOSED.
 */
export class SubmissionsNotClosedError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not SUBMISSIONS_CLOSED.`
        : "Session is no longer SUBMISSIONS_CLOSED."
    );
    this.name = "SubmissionsNotClosedError";
  }
}

/**
 * Slice 001. Raised when START_SESSION is invoked while the session's
 * current interaction instance exists but has not yet reached
 * RESULT_REVEAL — the precondition that makes the command safely
 * re-invocable once per interaction rather than once per session.
 */
export class PreviousInteractionNotRevealedError extends Error {
  constructor(currentInteractionState?: InteractionState) {
    super(
      currentInteractionState
        ? `The current interaction is in ${currentInteractionState}, not RESULT_REVEAL.`
        : "The current interaction has not been revealed yet."
    );
    this.name = "PreviousInteractionNotRevealedError";
  }
}

/**
 * Slice 001. Raised when a host-supplied prompt is empty after
 * trimming whitespace. Mirrors EmptyResponseError's MVP floor: at
 * least one visible character is required.
 */
export class EmptyPromptTextError extends Error {
  constructor() {
    super("Prompt text cannot be empty.");
    this.name = "EmptyPromptTextError";
  }
}

/**
 * Slice 001. Raised when a host-supplied prompt exceeds the MVP
 * length floor (1000 characters after trimming) — mirrors
 * ResponseTooLongError's deliberately generous, adjustable
 * placeholder, not a considered product limit.
 */
export class PromptTextTooLongError extends Error {
  constructor() {
    super("Prompt text cannot exceed 1000 characters.");
    this.name = "PromptTextTooLongError";
  }
}

/**
 * Raised when a submitted response is empty after trimming whitespace.
 * Per MVP response floor: at least one visible character is required.
 */
export class EmptyResponseError extends Error {
  constructor() {
    super("Response cannot be empty.");
    this.name = "EmptyResponseError";
  }
}

/**
 * Raised when a submitted response exceeds the MVP length floor (1000
 * characters after trimming) — a deliberately generous, adjustable
 * placeholder, not a considered product limit.
 */
export class ResponseTooLongError extends Error {
  constructor() {
    super("Response cannot exceed 1000 characters.");
    this.name = "ResponseTooLongError";
  }
}

/**
 * Raised when a display name collides with an existing participant in
 * the same session, per the canonical repository's normalized
 * display-name uniqueness rule.
 */
export class DisplayNameTakenError extends Error {
  constructor() {
    super("This display name is already in use in this session.");
    this.name = "DisplayNameTakenError";
  }
}

/**
 * Raised when a submitted display name is empty after trimming
 * whitespace. Per MVP display-name floor: at least one visible
 * character is required after trimming.
 */
export class EmptyDisplayNameError extends Error {
  constructor() {
    super("Display name cannot be empty.");
    this.name = "EmptyDisplayNameError";
  }
}

/**
 * Raised when a submitted display name exceeds 40 characters after
 * trimming. Per MVP display-name floor.
 */
export class DisplayNameTooLongError extends Error {
  constructor() {
    super("Display name cannot exceed 40 characters.");
    this.name = "DisplayNameTooLongError";
  }
}
