import type { GamingRepository } from "./db/gamingRepository";
import type { GamingMemberRecord } from "./types";
import {
  EmptyGamingDisplayNameError,
  GamingDisplayNameTooLongError,
} from "./types";

const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Validates and trims a submitted Gaming Member display name — the
 * same MVP floor as Participant display names (lib/session/joinSession.ts):
 * at least one visible character after trimming, at most 40 characters.
 */
function validateAndTrimDisplayName(displayName: string): string {
  const trimmed = displayName.trim();

  if (trimmed.length === 0) {
    throw new EmptyGamingDisplayNameError();
  }

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new GamingDisplayNameTooLongError();
  }

  return trimmed;
}

/**
 * CREATE_GAMING_MEMBER: the one-time transition from "authenticated
 * Supabase Auth user with no completed profile" to "Gaming Member."
 * authUserId must already be a verified auth.users id — this function
 * trusts its caller completely (see lib/gaming/auth.ts) and never
 * accepts a client-trusted authUserId directly from request JSON/body/
 * query.
 *
 * Idempotent under retry/concurrency: a second call for the same
 * authUserId returns the already-existing Gaming Member rather than
 * erroring or creating a duplicate — see each GamingRepository
 * implementation's own createGamingMember for how that guarantee is
 * enforced (ON CONFLICT DO NOTHING + re-select in Postgres; a plain
 * existence check in memory).
 */
export async function createGamingMember(
  repo: GamingRepository,
  authUserId: string,
  displayName: string
): Promise<GamingMemberRecord> {
  const trimmed = validateAndTrimDisplayName(displayName);
  return repo.createGamingMember(authUserId, trimmed);
}
