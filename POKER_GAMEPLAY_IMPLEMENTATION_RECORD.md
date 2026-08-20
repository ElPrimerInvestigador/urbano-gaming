# Poker Gameplay Implementation Record

Local-only. Uncommitted at the time of this writing, per explicit founder instruction not to stage/commit/push/deploy. This record documents the betting/gameplay phase built directly on top of the already-accepted **Poker Foundation** (`f75a759d254f1abaf30671ce231b6d52f52dd6a8`) — blinds, betting rounds, all-in/side pots, showdown, payout, and next-Hand. It does not modify Identity Foundation, Soccer Predictions, or any Foundation-phase file (`0067`–`0071`, `dealHand.ts`, `deal_poker_hand_atomically`, `poker.test.ts`, `pokerSupabaseRepository.contract.test.ts`).

## Exact gameplay rules implemented

Single-table No-Limit Texas Hold'em: dealer/button, small blind, big blind, pre-flop/flop/turn/river, fold/check/call/bet/raise/all-in, minimum-raise and reopened-action semantics, all-in and side pots, automatic runout, showdown with a real hand evaluator, split pots with a documented odd-chip rule, atomic payout, next Hand with dealer rotation. Chips are session-scoped, valueless, table-only — no buy-in, no cash-out, no purchasable/transferable/redeemable chips, no Gaming XP or rating created anywhere in this phase.

## Table config

`poker_tables` gained `starting_stack`, `small_blind`, `big_blind` (additive `ALTER`, `0072`) with check constraints (`starting_stack > 0`, `small_blind > 0`, `big_blind > small_blind`). No tournament blind schedule, no rebuy/add-on system — smallest config that makes real betting possible.

## Chip model

`poker_seats.stack` (additive `ALTER`, `0073`) is the seat's persistent, authoritative total, carried across Hands — updated only at join (set from `starting_stack`) and at Hand settlement (early win or showdown payout). A seat's live in-hand chip count is always `stack - committed_this_hand` — derived, never stored redundantly. `poker_hand_players` (new table, `0075`) holds the actual per-Hand betting state: `committed_this_hand`, `committed_this_street`, `folded`, `all_in`, `acted_this_street`.

**Chip conservation is an explicit, automated invariant**, not an assumption: `settle_showdown_atomically` independently re-sums total payouts against total committed chips and raises `CHIP_CONSERVATION_VIOLATION` if they disagree — checked before a single stack is touched. Verified continuously through both test suites and the live operational simulation (every hand, every scenario, exact conservation).

## Dealer / blinds

Real Hold'em semantics, computed in the domain layer (`pokerRules.ts`, pure functions) from currently-seated eligible players (`stack > 0` only) and the table's own most recent Hand: dealer rotates to the next eligible seat after the previous dealer (lowest seat on the very first Hand); heads-up, the dealer posts the small blind and acts first pre-flop, the other player posts the big blind and acts first post-flop; 3+, the two seats left of the dealer post SB/BB, the seat after the big blind acts first pre-flop, and the seat immediately left of the dealer acts first post-flop. Verified for both 2-player and 3-player tables, and live across dealer rotation between two real Hands.

## Hand / street lifecycle

`poker_hands` gained (additive `ALTER`, `0074`): `street` (`PRE_FLOP → FLOP → TURN → RIVER → SHOWDOWN → COMPLETE`, a real persisted column — the one piece of state that genuinely cannot be "derive, don't persist," since `PLAYER_ACTION` must atomically gate on it under a lock), `small_blind_seat_number`, `big_blind_seat_number`, `current_bet`, `min_raise_amount`, `last_raise_was_full`, `current_actor_seat_number`, `completed_at`. Community board cards are **never persisted as their own field during play** — they remain a pure derivation of `deck_order` + street (one burn card before each street, exactly as real dealing works), computed identically by `pokerRules.computeBoardCards` and the SQL layer. Public Poker vocabulary throughout (Hand, Pre-flop, Flop, Turn, River, Showdown) — no generic Session "Turn" terminology anywhere in this module, and no collision with Poker's own "Turn" (fourth community card), since Session's Segment/Turn concept was never adopted here at all.

## Action model

One authoritative atomic function, `apply_player_action_atomically`, for all six action types (`FOLD/CHECK/CALL/BET/RAISE/ALL_IN`) — not one RPC per action. Every call validates, in order: Hand exists; not already `SHOWDOWN`/`COMPLETE`; caller's seat is the current actor; seat is in the Hand, not folded, not all-in; the requested action is legal given current state; the amount (if any) is legal. The client requests an action; the server alone decides whether it's legal and computes every derived amount.

## Legal-action computation

`pokerRules.computeLegalActions` — a pure function — is the single source both `getTableState.ts` (for the participant's own turn, in `myLegalActions`) and the atomic function's own validation logic conceptually agree with (independently implemented in SQL, proven to match via shared worked examples across both test suites). The participant UI renders exactly the buttons the server says are legal; it never invents its own legality logic.

## Minimum raise / reopened action — verified, not hand-waved

`current_bet`, `min_raise_amount`, `last_raise_was_full` (Hand-level) and `acted_this_street` (per-seat) together implement the standard rule: a full bet/raise resets every other active seat's `acted_this_street` to `false` (reopening the round) and updates `min_raise_amount`; a **short all-in raise** (below the minimum full raise) still raises `current_bet` — so seats that already acted still owe a call/fold response — but leaves `min_raise_amount` and everyone's `acted_this_street` untouched, so no one is offered `RAISE` again until a genuine full raise occurs. Verified with a real short-all-in scenario (3 players, a 35-chip effective stack producing a 10-chip raise increment below the 15-chip minimum) in both the behavioral suite and, independently, against real Postgres during the initial SQL smoke-testing pass (documented below).

## Betting-round completion / board progression

Fully automatic — the server determines completion (every non-folded, non-all-in seat has `acted_this_street = true` and `committed_this_street = current_bet`) and advances the street itself; the Host never clicks "Next." Verified: future board cards are never present in `GET_TABLE_STATE`'s `board` field before their street legitimately arrives (tested at the domain layer and re-verified live in the browser simulation).

## Early win (fold to one)

Settled entirely inside `apply_player_action_atomically` — no hand evaluation needed. The sole remaining seat wins every committed chip (including folded seats' "dead money"); **no cards are revealed**, and — the one real defect found this phase (see below) — the persisted board now correctly reflects exactly how many streets were reached before the fold, never a full 5 cards regardless of when the hand actually ended.

## All-in / automatic runout

When round-completion leaves at most one non-folded, non-all-in seat with any street remaining, the function skips straight to `street = 'SHOWDOWN'` rather than mechanically stepping through empty betting rounds — verified heads-up (immediate all-in call) and 3-handed (one short-stacked all-in, two full-stacked seats continuing to bet across streets before reaching showdown naturally).

## Side-pot algorithm

Implemented as a pure function, `pokerRules.computeSidePots` — the standard algorithm: distinct contribution levels (across **all** seats, folded included — a real bug found and fixed, see below) become layer boundaries; each layer's pot is contributed by every seat that reached that level (folded seats' chips count as dead money) but is only eligible to seats that (a) reached that level and (b) did not fold. Winners per pot are supplied by the caller as ranked seat-number groups (ties split evenly, odd chip to the lowest seat number — the documented v1 rule). Verified with multiple worked examples (two/three distinct all-in levels, a folded contributor below the lowest active level, an even split, an odd-chip split) and against a real 3-way side pot in the live operational simulation, with exact chip conservation confirmed directly in Postgres.

## Hand evaluator / dependency

**`pokersolver`** (goldfire/pokersolver, MIT, zero transitive dependencies) — chosen over hand-rolling a 7-card evaluator because correct hand ranking (kicker comparisons, wheel straights, flush tie-breaks) is an easy-to-get-subtly-wrong problem a mature, widely-used library gets right more cheaply and more trustworthily than a fresh implementation. Isolated to one file (`handEvaluator.ts`, `@ts-nocheck` since the package ships no types) — every other module only sees the typed wrapper. Always server-authoritative: called exclusively from `applyPlayerAction.ts`, never reachable from a direct client request. Verified against a real, non-trivial hand during the live simulation: a board with four hearts already on it produced two players with a "Flush" by name, correctly resolved as a clean win (not a split) for the player whose kicker was genuinely higher — proof the wrapper does real card-level comparison, not category-name matching.

## Showdown behavior

`apply_player_action_atomically` stops at `street = 'SHOWDOWN'` without settling (no evaluator in SQL); `applyPlayerAction.ts` detects `showdownReached`, fetches every non-folded seat's hole cards (the same `deck_order` derivation `getTableState.ts` already uses), evaluates each hand, decomposes side pots, and calls `settle_showdown_atomically` to apply the payout atomically. The brief window between "reached Showdown" and "settled" carries no risk: no further player action is possible once `street = 'SHOWDOWN'`, and settlement is itself idempotent.

## Tie / odd-chip rule

Ties within a pot's winning group split the pot amount evenly; any remaining odd chip(s) go to the lowest seat number in the tied group. Chosen for determinism and simplicity — documented here as the v1 rule, not claimed as a "house standard." Chip conservation holds regardless (verified by direct test).

## Reveal / privacy rule (v1, chosen and documented)

**Every seat that reaches Showdown without folding is revealed to everyone** once the Hand completes (mirrors the common digital-poker convention of showing all contesting hands at Showdown, not just the winner) — a deliberate choice over a "winner only" or "loser mucks" rule, which would need its own arbitrary asymmetric logic for a v1 that doesn't need one. **Folded hands are never revealed, at any point, for any reason.** An early win (fold to one) reveals nothing at all — no cards, no board beyond whatever streets were legitimately reached. Verified in the browser simulation directly: three real hands revealed correctly at a genuine Showdown; a fold-to-one hand revealed nothing.

## Payout / chip-conservation evidence

Every settlement (early win and Showdown alike) is one atomic operation: winners' stacks increase, the Hand becomes `COMPLETE`, and result evidence (`poker_hand_results`) is persisted in the same transaction. Idempotent: a repeated settlement call on an already-`COMPLETE` Hand returns the existing result without paying out twice — verified directly (a forced re-`settle_showdown_atomically` call left every stack unchanged). Chip conservation was checked directly in Postgres after every real Hand played during this phase's operational simulation, across three consecutive real Hands sharing one table (a normal Showdown, a genuine 3-way side pot, and an early win) — the table's total chip sum never moved from what the three starting stacks summed to, at any point.

## Action history

`poker_hand_actions` (new, `0076`) — append-only, Poker-specific (deliberately not a reuse of `session_events`, which would falsely imply Session ownership; deliberately not a generic event-sourcing framework). Records every real action (including posted blinds) with `action_ordinal`, `street`, `seat_number`, `action_type`, `amount`, and a caller-supplied `idempotency_key` — the same idempotency-key convention already established for Predictions' `gaming_progression_events`. Serves auditability, reconnect/debugging, and dispute inspection; nothing more was built.

## Reconnect

Unchanged in spirit from the Foundation phase, extended to cover live betting state: a full page reload recovers the same hole cards, stack, committed amount, public board, current actor, and legal actions purely from server state — no client-side cache of any of it.

## Next Hand

One command, `start_poker_hand_atomically` (extended for real gameplay via a new function, `0079` — Foundation's own `deal_poker_hand_atomically`, `0071`, is untouched and still exercised by the Foundation's own tests), handles both the very first Hand and every subsequent one: it checks whether the table's most recent Hand is `COMPLETE`; if not, it returns that Hand unchanged (`alreadyStarted: true`) rather than starting a second one — a double-tapped "Start Hand"/"Next Hand" is safe by construction, and verified concurrently safe against real Postgres (two simultaneous start requests never produce two Hand rows). Each new Hand: rotates the dealer, uses each seat's current (already-settled) stack, freezes the currently-seated eligible set, posts fresh blinds, deals from a fresh independent shuffle. **Zero-stack seats are excluded** from the eligible set and therefore from the next Hand — verified live (a broke seat correctly shows "Waiting" through subsequent Hands) — with no rebuy mechanism invented. A participant who joined mid-Hand is correctly included once the next Hand actually starts.

## Host UI

Extended only as required: gameplay config at table creation (starting stack, blinds), one "Start Hand"/"Start Next Hand" button (gated on the current Hand being over), live public state (street, pot, board, seat stacks, dealer/acting/all-in/folded badges), final Hand result. No private-card access anywhere, no manual street/pot control.

## Participant UI

`poker-table.html` extended into a real controller: own hole cards, own stack and committed amount, public board and pot, whose turn it is, and — only on the caller's own turn — the exact legal-action buttons the server computed (`myLegalActions`), with a mobile-friendly numeric amount field for bet/raise. No raw action-command typing. Verified end to end via real clicks in the browser (join → call → showdown) before any programmatic driving was used for speed on the remaining scenarios.

## Operational simulation (real browser, local Postgres only)

One table, three real participants (Alex, Jordan, Sam), three consecutive real Hands on the same table:

- **Hand A** — normal betting across all four streets (call/bet/raise/call, check-downs to Showdown). A genuine flush-vs-flush comparison resolved correctly in favor of the higher kicker, not a split. Verified live in both the host view (zero card exposure) and the winning/losing participants' own views (correct reveal, correct "no win" messaging). Chip conservation confirmed directly in Postgres (3000 total, unchanged).
- **Hand B** — a natural side pot (stacks were already unequal from Hand A's result): Jordan raises big, Sam and Alex both go all-in for less, automatic runout to Showdown. Verified directly in Postgres: main pot (2520, all three eligible, won by Alex's flush) and a side pot (60, Jordan only, uncontested) — exact chip conservation (2580 total payouts = 2580 total committed).
- **Hand C** — early win: heads-up (Sam correctly excluded, broke from Hand B), Alex folds pre-flop. Verified directly in Postgres: `board = []`, `showdown_hands = null` — nothing revealed.

Dealer rotation was observed correctly across all three Hands (0 → 1 → 0 heads-up once Sam dropped out).

## Mobile validation (375×812)

Verified via real screenshots at genuine mobile viewport width: the join form, the active-turn view (own hole cards, pot, seat list with committed amounts, Fold/Call/Raise/All-in buttons plus a numeric amount field — no horizontal overflow, all controls comfortably tappable), the waiting-for-turn view (no action controls shown), and the Showdown/result view (full board, "Hand result," own revealed cards). One real tap (Call) was captured successfully on this pass; the remainder of the mobile sequence was driven via direct API calls after the Browser pane's click dispatch hit a transient timeout partway through this pass (the same class of intermittent Browser-pane tooling outage this repository's own prior implementation records have already documented) — rendering correctness at every state was still verified by screenshot, and interaction correctness for the identical markup/handlers was already proven by real clicks at desktop width earlier in this same simulation (there is no separate mobile code path). This is disclosed honestly rather than silently substituted.

## Defects found and fixed this phase

1. **`computeSidePots` dropped a folded seat's contribution below the lowest active level.** `distinctLevels` was computed only from non-folded seats, so a folded seat's chips at a contribution level no active seat shared were never counted in any pot's contributor set — real chips silently vanished (found via a deliberately constructed test: `{0: 50 (folded), 1: 100, 2: 100}` produced a 200-chip total instead of the correct 250). Fixed by computing layer boundaries from **every** seat's contribution level, folded included — a folded player's chips are still real dead money that must land in some pot. Verified by the same test and reconfirmed live in Hand B's real side pot.
2. **The board shown for an early-win (fold) Hand was hardcoded to an empty array in the atomic function, and `getTableState.ts` separately assumed a full 5-card board for any `street = 'COMPLETE'` Hand** — meaning a fold that happened after the flop or turn would show either nothing (SQL path) or a fabricated full board including cards that were never legitimately dealt (read path), depending on which bug fired first. Found during the live operational simulation (Hand C's participant view showed a full 5-card board for a hand that ended pre-flop). Fixed in three places: `apply_player_action_atomically` now slices the deck for exactly the number of cards the street reached before computing the payout; the in-memory repository's equivalent early-win branch was fixed the same way; `getTableState.ts` now prefers the persisted, correctly-computed `poker_hand_results.board` once a Hand is complete, rather than re-deriving a board from the ambiguous terminal `street = 'COMPLETE'` value. Verified by two new regression tests (pre-flop fold → empty board; post-flop fold → exactly 3 cards) and reconfirmed live.

No other defects were found. Every other mechanic (blinds, dealer rotation, action ordering, minimum-raise/reopen, automatic runout, showdown evaluation, payout, idempotency, concurrency) worked correctly on first implementation.

## Explicit deferrals

Disconnect/AFK timeout and default action (explicitly deferred per instruction — participants must act manually while connected); reaction windows; Bullshit/Conquian/Nervioso/Slapjack/Snap; a generic Private Table Engine; Poker Gaming XP; Poker rating; tournament structure/blind schedules/rebuys; production deployment.

## Production status

Local only. Migrations `0072`–`0081` have never been applied to production (production's migration ceiling remains `0044`, confirmed via the same authoritative `supabase migration list --linked` check used throughout this engagement). No push, no deploy, no SMTP. Identity Foundation and Soccer Predictions are unmodified. This record does not claim Poker complete beyond the v1 rules actually implemented here — no tournament play, no rebuy, no disconnect handling, no Gaming XP integration.
