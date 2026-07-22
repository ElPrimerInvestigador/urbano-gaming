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

/** Raised when JOIN_SESSION targets a room code with no active session. */
export class SessionNotFoundError extends Error {
  constructor() {
    super("No active session found for the given room code.");
    this.name = "SessionNotFoundError";
  }
}

/** Raised when JOIN_SESSION targets a session not in LOBBY_OPEN. */
export class LobbyNotOpenError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Cannot join: session is in ${currentState}, not LOBBY_OPEN.`
        : "Cannot join: session is no longer LOBBY_OPEN."
    );
    this.name = "LobbyNotOpenError";
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
