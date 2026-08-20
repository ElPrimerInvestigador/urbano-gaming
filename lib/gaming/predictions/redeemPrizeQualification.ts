import type { PredictionsRepository } from "./db/predictionsRepository";

/**
 * REDEEM_PRIZE_QUALIFICATION — v1 redemption: a single admin action,
 * exactly once, idempotent on retry. Never claws back a redeemed
 * qualification even if a later correction supersedes it.
 */
export async function redeemPrizeQualification(
  repo: PredictionsRepository,
  prizeQualificationId: string,
  redeemedByGamingMemberId: string
): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
  return repo.redeemPrizeQualification(prizeQualificationId, redeemedByGamingMemberId);
}
