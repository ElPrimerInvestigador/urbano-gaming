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

export interface SessionRecord {
  sessionId: string;
  roomCode: string;
  hostToken: string;
  state: SessionState;
  stateVersion: number;
  pauseReason: PauseReason;
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

/** A participant as exposed by GET_SESSION — no token, no join timestamp. */
export interface ParticipantSummary {
  participantId: string;
  displayName: string;
}

/**
 * Result of a successful GET_SESSION. Never includes hostToken or any
 * participantToken.
 */
export interface GetSessionResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
  participants: ParticipantSummary[];
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
