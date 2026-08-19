import type { GamingRepository } from "./db/gamingRepository";
import type { GamingMemberRecord } from "./types";

/**
 * RESOLVE_GAMING_MEMBER: a pure lookup by a verified auth.users id.
 * Never creates a row — a null result means this auth user has not yet
 * completed Gaming Member profile creation (see createGamingMember.ts),
 * not an error. The caller (the sign-in UX / join route) is
 * responsible for routing a null result to profile completion.
 */
export async function resolveGamingMember(
  repo: GamingRepository,
  authUserId: string
): Promise<GamingMemberRecord | null> {
  return repo.resolveGamingMemberByAuthUserId(authUserId);
}
