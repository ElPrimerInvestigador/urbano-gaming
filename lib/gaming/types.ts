/**
 * URBANO Gaming Identity Foundation. Gaming Member domain types — kept
 * in their own module, parallel to lib/session/types.ts, rather than
 * merged into it: Gaming Member is a separate aggregate from Session/
 * Participant (see gamingRepository.ts's own module comment), and
 * nothing here is imported by lib/session.
 */

/** A persistent Gaming Member, as returned by resolve/create. */
export interface GamingMemberRecord {
  gamingMemberId: string;
  authUserId: string;
  displayName: string;
  createdAt: string;
}

/**
 * Raised by CREATE_GAMING_MEMBER when the supplied display name is
 * empty after trimming whitespace. Mirrors
 * lib/session/types.ts's EmptyDisplayNameError floor exactly (at least
 * one visible character), kept as a distinct class so this domain does
 * not import from lib/session.
 */
export class EmptyGamingDisplayNameError extends Error {
  constructor() {
    super("Display name cannot be empty.");
    this.name = "EmptyGamingDisplayNameError";
  }
}

/**
 * Raised by CREATE_GAMING_MEMBER when the supplied display name
 * exceeds 40 characters after trimming — mirrors
 * lib/session/types.ts's DisplayNameTooLongError floor exactly.
 */
export class GamingDisplayNameTooLongError extends Error {
  constructor() {
    super("Display name cannot exceed 40 characters.");
    this.name = "GamingDisplayNameTooLongError";
  }
}
