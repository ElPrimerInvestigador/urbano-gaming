/**
 * Poker Gameplay Phase — pure, dependency-free rule functions shared
 * by the domain layer (startHand.ts, applyPlayerAction.ts,
 * getTableState.ts) and independently re-implemented against by the
 * in-memory repository's own action-application logic, mirroring how
 * this codebase already treats such pure logic elsewhere. None of
 * these touch the database — every function here is a straight
 * computation over already-fetched state, which is what makes them
 * independently unit-testable without Postgres.
 */

export type Street = "PRE_FLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN" | "COMPLETE";

/** Dealer rotates to the next currently-seated player after the previous dealer, wrapping. First Hand: lowest seated seat. */
export function computeDealerSeatNumber(
  seatedNumbers: number[],
  previousDealerSeatNumber: number | null
): number {
  const sorted = [...seatedNumbers].sort((a, b) => a - b);
  if (previousDealerSeatNumber === null) return sorted[0];
  const next = sorted.find((n) => n > previousDealerSeatNumber);
  return next ?? sorted[0];
}

/** Real dealing order: starts immediately left of the dealer, wraps around to include the dealer last. */
export function computeDealingOrder(seatedNumbers: number[], dealerSeatNumber: number): number[] {
  const sorted = [...seatedNumbers].sort((a, b) => a - b);
  const idx = sorted.indexOf(dealerSeatNumber);
  return [...sorted.slice(idx + 1), ...sorted.slice(0, idx + 1)];
}

/** Heads-up: dealer posts small blind. 3+: first two seats left of the dealer post SB/BB. */
export function computeBlindSeats(
  dealingOrder: number[],
  dealerSeatNumber: number
): { smallBlindSeat: number; bigBlindSeat: number } {
  if (dealingOrder.length === 2) {
    const other = dealingOrder.find((s) => s !== dealerSeatNumber)!;
    return { smallBlindSeat: dealerSeatNumber, bigBlindSeat: other };
  }
  return { smallBlindSeat: dealingOrder[0], bigBlindSeat: dealingOrder[1] };
}

/** Heads-up: dealer/SB acts first pre-flop. 3+: first seat after the big blind. */
export function computePreFlopFirstActor(
  dealingOrder: number[],
  smallBlindSeat: number,
  bigBlindSeat: number
): number {
  if (dealingOrder.length === 2) return smallBlindSeat;
  const idx = dealingOrder.indexOf(bigBlindSeat);
  return dealingOrder[(idx + 1) % dealingOrder.length];
}

/** Heads-up: non-dealer (BB) acts first post-flop. 3+: first seat left of the dealer (dealingOrder[0]). */
export function computePostFlopFirstActor(dealingOrder: number[], smallBlindSeat: number): number {
  if (dealingOrder.length === 2) return dealingOrder.find((s) => s !== smallBlindSeat)!;
  return dealingOrder[0];
}

/**
 * Community board cards, derived purely from the authoritative
 * deck_order + the number of dealt hole-card seats + the current
 * street — never persisted separately (see 0074's migration comment).
 * One burn card before each street, exactly as real dealing works.
 */
export function computeBoardCards(deckOrder: string[], dealtSeatCount: number, street: Street): string[] {
  const n = dealtSeatCount;
  const board: string[] = [];
  if (street === "PRE_FLOP") return board;
  board.push(deckOrder[2 * n + 1], deckOrder[2 * n + 2], deckOrder[2 * n + 3]);
  if (street === "FLOP") return board;
  board.push(deckOrder[2 * n + 5]);
  if (street === "TURN") return board;
  board.push(deckOrder[2 * n + 7]);
  return board; // RIVER, SHOWDOWN, COMPLETE all show the full 5-card board
}

export interface PotPayout {
  seatNumber: number;
  amount: number;
}
export interface Pot {
  amount: number;
  eligibleSeatNumbers: number[];
  payouts: PotPayout[];
}

/**
 * Side-pot decomposition — the standard algorithm: sort distinct
 * non-folded contribution levels ascending; each level slices a layer
 * off every remaining contributor's commitment, forming one pot per
 * distinct all-in threshold. A folded seat's chips still count toward
 * pot amounts (their contribution is "dead money," per real Hold'em
 * rules) but they are never in eligibleSeatNumbers, so they can never
 * win a pot. Winners for each pot must be supplied by the caller
 * (this function does no hand evaluation) as an ordered list of
 * seat-number groups from best to worst among that pot's eligible
 * seats; ties within a group split the pot, with any odd chip going to
 * the first seat in the group (by seat_number ascending) — the chosen,
 * documented v1 odd-chip rule.
 */
export function computeSidePots(
  committedThisHand: Record<number, number>,
  foldedSeats: Set<number>,
  rankedEligibleGroups: (allEligibleSeats: number[]) => number[][]
): Pot[] {
  const seats = Object.keys(committedThisHand).map(Number);
  // Layer boundaries come from EVERY seat's contribution level, folded
  // included — a folded player's chips are still real money that must
  // land in some pot (dead money), even at a contribution level no
  // active player happens to share. Excluding folded seats here was a
  // real chip-conservation bug: a folded seat's contribution below the
  // lowest active level would otherwise never appear in any layer's
  // contributor set and silently vanish.
  const distinctLevels = Array.from(
    new Set(seats.filter((s) => committedThisHand[s] > 0).map((s) => committedThisHand[s]))
  ).sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previousLevel = 0;

  for (const level of distinctLevels) {
    const layerSize = level - previousLevel;
    if (layerSize <= 0) {
      previousLevel = level;
      continue;
    }
    // Every seat (folded or not) that committed at least `level` contributes this layer.
    const contributors = seats.filter((s) => committedThisHand[s] >= level);
    const amount = layerSize * contributors.length;
    const eligibleSeatNumbers = contributors.filter((s) => !foldedSeats.has(s) && committedThisHand[s] >= level);

    if (amount > 0 && eligibleSeatNumbers.length > 0) {
      const payouts = distributePot(amount, rankedEligibleGroups(eligibleSeatNumbers));
      pots.push({ amount, eligibleSeatNumbers, payouts });
    }
    previousLevel = level;
  }

  return pots;
}

/** Splits one pot's amount among the best-ranked group (ties split evenly); odd chips go to the lowest seat_number in that group. */
function distributePot(amount: number, rankedGroups: number[][]): PotPayout[] {
  const winningGroup = rankedGroups[0] ?? [];
  if (winningGroup.length === 0) return [];
  const sortedWinners = [...winningGroup].sort((a, b) => a - b);
  const share = Math.floor(amount / sortedWinners.length);
  let remainder = amount - share * sortedWinners.length;
  return sortedWinners.map((seatNumber) => {
    const oddChip = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { seatNumber, amount: share + oddChip };
  });
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  minRaiseTo: number | null;
  canAllIn: boolean;
  maxAmount: number;
}

/** Computes the legal action set for one seat from already-fetched authoritative state — no DB access. */
export function computeLegalActions(input: {
  currentBet: number;
  minRaiseAmount: number;
  committedThisStreet: number;
  remainingStack: number;
  lastRaiseWasFull: boolean;
  actedThisStreet: boolean;
  configuredBigBlind: number;
}): LegalActions {
  const toCall = input.currentBet - input.committedThisStreet;
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && input.remainingStack > 0;
  const canFold = true;
  const canAllIn = input.remainingStack > 0;

  // Raise is offered only if this seat hasn't yet acted this street, OR the
  // last aggressive action was a full raise (not a short all-in raise) —
  // the reopened-action rule.
  const raiseEligible = !input.actedThisStreet || input.lastRaiseWasFull;

  if (input.currentBet === 0) {
    const canBet = input.remainingStack > 0;
    return {
      canFold,
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canBet,
      canRaise: false,
      minRaiseTo: canBet ? Math.min(input.configuredBigBlind, input.remainingStack) : null,
      canAllIn,
      maxAmount: input.remainingStack,
    };
  }

  const canRaise = raiseEligible && input.remainingStack > toCall;
  const minRaiseTo = canRaise
    ? input.committedThisStreet + Math.min(toCall + input.minRaiseAmount, input.remainingStack)
    : null;

  return {
    canFold,
    canCheck,
    canCall,
    callAmount: Math.min(toCall, input.remainingStack),
    canBet: false,
    canRaise,
    minRaiseTo,
    canAllIn,
    maxAmount: input.committedThisStreet + input.remainingStack,
  };
}
