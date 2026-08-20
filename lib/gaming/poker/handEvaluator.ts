// @ts-nocheck — pokersolver (goldfire/pokersolver, MIT, zero
// dependencies) ships no TypeScript types. This file is the single
// isolated boundary where its untyped surface is used; every other
// module in this codebase only ever sees the typed functions below.
// Chosen over hand-rolling a 7-card evaluator: hand ranking is a
// well-understood, easy-to-get-subtly-wrong problem (kicker
// comparisons, wheel straights, etc.) that a mature, widely-used
// library gets right more cheaply and more trustworthily than a fresh
// implementation would. Evaluation is always server-authoritative —
// this module is only ever called from domain code (applyPlayerAction.ts),
// never reachable from a client request directly.
import pokersolverPkg from "pokersolver";

const { Hand } = pokersolverPkg;

/** Converts this codebase's card codes ("AS", "TC") to pokersolver's own ("As", "Tc"). */
function toPokersolverCard(card: string): string {
  return card[0] + card.slice(1).toLowerCase();
}

export interface EvaluatedHand {
  seatNumber: number;
  rankName: string;
  descr: string;
  cards: string[];
  /** Opaque handle back into pokersolver's own Hand object, used only by rankGroups below within this module. */
  _solved: any;
}

/** Evaluates one seat's best 5-card hand from their two hole cards + the community board. */
export function evaluateHand(seatNumber: number, holeCards: [string, string], board: string[]): EvaluatedHand {
  const allCards = [...holeCards, ...board].map(toPokersolverCard);
  const solved = Hand.solve(allCards);
  return {
    seatNumber,
    rankName: solved.name,
    descr: solved.descr,
    cards: (solved.cards ?? []).map((c: any) => String(c)),
    _solved: solved,
  };
}

/**
 * Ranks a set of evaluated hands best-to-worst, grouping ties into the
 * same rank position — the shape computeSidePots' rankedEligibleGroups
 * callback expects. Uses pokersolver's own Hand.winners to determine
 * ties correctly (not a naive rank-number comparison, since some hand
 * types compare on more than the top-level rank).
 */
export function rankHandsBestToWorst(hands: EvaluatedHand[]): number[][] {
  const remaining = [...hands];
  const groups: number[][] = [];

  while (remaining.length > 0) {
    const winners = Hand.winners(remaining.map((h) => h._solved));
    const winningGroup = remaining
      .filter((h) => winners.includes(h._solved))
      .map((h) => h.seatNumber);
    groups.push(winningGroup);

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (winners.includes(remaining[i]._solved)) remaining.splice(i, 1);
    }
  }

  return groups;
}
