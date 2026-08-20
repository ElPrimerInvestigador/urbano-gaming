# Poker Foundation Implementation Record

Local-only. Uncommitted at the time of this writing, per explicit founder instruction not to stage/commit/push/deploy. This record documents Phase 1 of Poker only — table/seating, authoritative deck, private hole cards, and the role-aware public/private projection. No betting, no chips, no streets, no showdown.

## Why Poker is standalone

A read-only Private Table / Poker implementation-readiness gate preceded this phase (see the founder/canonical-Code-Review-accepted architecture direction). It found no firm design authority anywhere in this repository or the Knowledge OS for a "Private Table Engine" — every prior mention was either an illustrative example, an explicit scope-fence, or a self-labeled non-design compatibility check (`SLICE_008_IMPLEMENTATION_RECORD.md`: "Private Player State, Shared Game State, and any Virtual Card Deck concept remain fully undesigned and unimplemented"). An external "UG – Internal – research" review, later confirmed by canonical Code Review, established that Private Hand / Shared Table was a *research hypothesis*, not an approved Engine, and explicitly left open whether the right answer is one shared foundation, several Engines, an orchestration layer, or no shared abstraction at all — with no authority requiring a generic engine before a real proving implementation.

## Why Session/Segment/Interaction Instance aren't reused

`sessions.state` is a closed enum built for the lobby → prompt/submit/reveal cycle; a Poker Table's real lifecycle (waiting for seats → hand in progress → between hands → closed, hands repeating indefinitely) does not map onto it. `segments` groups Interaction Instances under one member-facing Turn — Poker's own "Hand" is only superficially analogous (a durable ordinal), not the same shape. `interaction_instances`' three-state lifecycle (`PROMPT_ACTIVE → SUBMISSIONS_CLOSED → RESULT_REVEAL`) encodes "one prompt, each participant submits once, then reveal at once" — a Poker Hand is many sequential per-seat actions across multiple betting rounds with mid-round elimination (fold) and running amounts; there is no honest way to represent that as a submission-per-participant-per-interaction. Forcing it in would have produced exactly the false semantics the readiness gate warned against.

## Why no generic Private Table Engine exists yet

ADR-007's own bar ("a new Engine requires evidence of genuinely new participant behavior") cuts against building a *multi-game* abstraction off one data point. The other named future games (Bullshit, Conquian, Nervioso, Slapjack, Snap) span at least two structurally different action models — strict turn order (Poker, Conquian) vs. simultaneous reaction with no turn order at all (Nervioso, Slapjack, Snap) — so a shared foundation built from Poker alone would very likely fit neither well. Poker is built as its own bespoke module, with internal seams (deck/shuffle, private-hand-projection, dealing order) kept separable so a second card game can justify extraction later from real evidence, not speculation.

## Table / seating architecture

`poker_tables` (room code, host token, `max_seats` 2–6, `closed_at` nullable — no other lifecycle column; "accepting participants" vs. "hand dealt" is derived from whether a `poker_hands` row exists, mirroring `segments`' own "derive, don't persist" precedent) and `poker_seats` (one row per seated Guest — no `gaming_member_id` column at all; Poker does not depend on production Gaming Member authentication). Room code and host token generation are reused directly from `lib/session/roomCode.ts`/`hostToken.ts` — the two genuinely dependency-free utilities the readiness gate identified — imported, not duplicated. `CREATE_POKER_TABLE` mirrors `createSession`'s own generate-and-retry-on-collision shape exactly (no atomic function needed, no concurrent-mutation race). `JOIN_POKER_TABLE` is one atomic function (`join_poker_table_atomically`) that locks the table row, enforces `max_seats`, and allocates the next `seat_number` under that lock — verified safe under genuine concurrency (see Tests below). Duplicate display names are rejected via a unique constraint, not silently deduplicated — mirroring `joinSession.ts`'s own documented "no idempotent-return path" behavior exactly.

## Deck representation and shuffle authority

A standard 52-card deck, no jokers, canonical `RankSuit` codes (e.g. `"AS"`, `"TC"`). The shuffle (Fisher-Yates using Node's `crypto.randomInt` — a CSPRNG, not `Math.random()` and not Postgres's own non-cryptographic `random()`) happens in the domain layer (`lib/gaming/poker/deck.ts`), the same division of labor already established by Predictions' geolocation distance computation: TypeScript computes, the atomic SQL function (`deal_poker_hand_atomically`) independently re-validates before trusting it — specifically, a `count(distinct card) = 52` check inside the same transaction, defense in depth beyond the table's own `jsonb_array_length = 52` constraint (which alone would not catch a duplicate-with-one-missing deck).

## Card persistence decision

One authoritative shuffled-order array (`poker_hands.deck_order`, `jsonb`) per Hand — not 52 persistent card-location rows. This makes "no duplicate cards, no card in two locations" true *by construction* (a permutation has each value exactly once), gives deterministic, cheap derivation of any card's location from index arithmetic, and stays proportionate to what this phase actually needs — not a collectible-card platform. `poker_hands.dealt_seat_numbers` (an ordered `integer[]`, frozen at deal time) records which seats are in the Hand and in what real dealing order; the seat at position `i` holds `deck_order[i]` and `deck_order[N+i]` as its two hole cards (one card to each active player in turn, twice around — the real rule, implemented directly since it cost nothing extra over a simplification). This representation held up cleanly through implementation; no second source of truth was ever needed.

**Dealer selection is explicitly NON-FINAL for this phase**: the dealer is chosen as the lowest currently-seated seat number, documented as such directly in `dealHand.ts`'s own comment — real button rotation across Hands has no meaning yet, since this phase never deals a second Hand for a table at all (see Idempotency below). This must not be silently read as final Texas Hold'em button semantics; it is a placeholder deterministic rule sufficient to prove dealing order, nothing more.

## Privacy projection — the load-bearing boundary

`getTableState.ts` mirrors `getSession.ts`'s own bearer-token resolution (`isHost` / `callingSeat`) exactly, then builds the response by **explicit projection construction** — `deckOrder` is never referenced by name anywhere in the return value, and other seats' hole cards are never computed at all for a caller who isn't that seat, not merely omitted after being computed. `myHoleCards` is `[string, string] | null`, populated only for the calling participant's own seat, only once dealt.

**Host privacy is a deliberate, explicit decision, not an oversight**: the host token authenticates table administration (create, deal), not omniscience. There is no operational reason in this phase for the host to see any seat's hole cards, so `myHoleCards` is `null` for the host exactly as for a participant looking at a seat that isn't their own. Verified directly, at the network level, in the live simulation below — not assumed from the domain code alone.

## Reconnect

Verified: refreshing the participant page recovers the same seat and the identical hole cards purely from the server response — the page has no client-side card cache. A host reload restores current table state (seats, dealer, hand id) the same way.

## Idempotency / concurrency

`JOIN_POKER_TABLE`: seat allocation is race-free under concurrent joins because every insert path is serialized through the same table-row lock — verified with four genuinely concurrent join requests against the same table producing seat numbers `[0,1,2,3]`, no gaps, no duplicates. `DEAL_HAND`: idempotent per table, not sequence-capable — a table may have at most one Hand until the gameplay phase adds hand-completion/next-hand semantics; a double-tapped Deal returns the existing Hand with `alreadyDealt: true`, mirroring `finalizeMatchResult`'s own already-finalized convention. Verified with two genuinely concurrent deal requests against the same table producing exactly one `poker_hands` row.

## Local operational simulation

Real browser session against local Postgres only (`SUPABASE_URL=http://127.0.0.1:54421`, verified directly in Postgres before and after — table `poker_tables.room_code = 'PZQAZH'` confirmed to exist locally, never in production). Host created a table; Alex joined through the real join UI; Jordan and Sam joined via direct API calls (avoiding a same-browser-tab localStorage collision, a testing-tool artifact, not a product concern); the host's live view showed all three seats with zero card exposure. The host dealt the Hand. Direct network-payload inspection (not DOM-only) confirmed:

- Alex's raw `GET_TABLE_STATE` response: `myHoleCards: ["AS","3C"]`, no `deckOrder`, no other seat's cards.
- Jordan's own response: `myHoleCards: ["JD","JS"]`. Sam's own response: `myHoleCards: ["8H","KS"]`. All six dealt cards distinct.
- The host's raw response: `myHoleCards: null`, and the body contains none of the six dealt card codes anywhere.
- A fourth participant (Casey) joined *after* the Hand was dealt: seated at seat 3, `myHoleCards: null`, `inCurrentHand: false` — correctly waiting for the next Hand rather than being retroactively dealt in.
- A full page reload for Alex reproduced the identical two hole cards from server state alone.

Screenshots captured at desktop and at 375×812 (mobile) confirm the hole cards render legibly as face-up cards, other seats render without any card information, and the mid-hand joiner shows a "Waiting" badge instead of "Dealt" — no horizontal overflow at either width.

## Mobile validation

375×812, real render: room code pill, two face-up hole cards, seat list with dealer/waiting badges — all legible, no overflow. Verified via direct screenshot after a real page load (not a resized desktop screenshot of unchanged markup).

## Local dev tooling note (not part of this feature's own scope)

Running the browser simulation safely required the local dev server to target local Postgres instead of `.env.local`'s production values. This was done transiently by adding a second `.claude/launch.json` configuration (`urbano-gaming-dev-localdb`, port 3001) passing `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` as explicit shell environment overrides — the same override technique already used for contract tests — without touching `.env.local` at all. That addition has since been **reverted**: `.claude/launch.json` is tracked, committed canonical repository tooling (last touched by the `d5d3d8c` re-bootstrap commit), and hardcoding even a local demo key inline in a tracked file is not something this phase's scope should carry forward silently. `.claude/launch.json` is confirmed back to a zero diff against its committed state and is excluded from this commit.

## Explicit deferrals

Blinds, chip stacks, pot, betting actions, all-in, side pots, flop/turn/river, showdown, hand evaluator, pot award, next hand, disconnect timeout/default-action, reaction windows, Bullshit, Conquian, Nervioso, Slapjack, Snap, a generic Private Table Engine, Poker Gaming XP, Poker rating, tournament Poker, production deployment. None of these were designed, scaffolded, or assumed compatible with what was built here.

## Future extraction candidates (observed, not acted on)

`lib/gaming/poker/deck.ts` (shuffle/deck validity), the explicit-projection-construction discipline in `getTableState.ts`, and the table-row-lock-then-allocate pattern in `join_poker_table_atomically` are the pieces most likely to generalize if a second card game is ever built — noted here as observations from doing the work, not as a proposal to extract them now.

## Production status

~~Local only. Migrations 0067–0071 have never been applied to production (confirmed: production's migration ceiling remains 0044, per the same authoritative `supabase migration list --linked` check used for Identity/Predictions). No push, no deploy, no SMTP. Poker gameplay (betting, showdown, chips) is not implemented — this record does not claim Poker is playable end to end, only that its privacy/state foundation is proven.~~

**Superseded 2026-08-20.** Migrations `0067`–`0071` applied to production as part of the accepted `0045`–`0081` batch; commit `f030558` (superset of this Foundation commit `f75a759` plus Poker Gameplay) pushed to `origin/main` and deployed. Foundation's own migration files, routes, and tests (`poker.test.ts`, `pokerSupabaseRepository.contract.test.ts`) were not modified by the Gameplay phase and remain passing.

Foundation-specific production evidence, gathered directly against the live table used for the full Gameplay proving case (full detail in `POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md`'s own "Production Deployment & Validation" section):

- **Table creation / Guest seating**: table created with real config (`startingStack:200, smallBlind:5, bigBlind:10`); Alex, Jordan, and Sam joined and seated at sequential seat numbers with `stack` correctly initialized from `starting_stack`.
- **Host privacy**: the Host's own `GET` view had `myHoleCards: null` throughout, and every seat's `revealedHoleCards: null` before Showdown.
- **Participant private-card projection**: each participant's `myHoleCards` contained exactly their own two cards and no other seat's.
- **No raw-deck exposure**: `deckOrder` confirmed absent from every response payload across the entire proving case, including at Showdown (only `board` and the specific revealed hands are ever returned).
- **Reconnect**: every check throughout the proving case was a fresh, independent `GET` using only a token — full state (hole cards, stack, board, legal actions) restored from the server with no client-side memory.
- **Join-during-Hand / waiting behavior**: a Guest (`MobileGuest`, joined live via the mobile client) was correctly shown "waiting" and excluded from the Hand already in progress, then correctly included in the next Hand.
- **Production mobile evidence**: real 375×812 screenshots at `https://urbano-gaming-playtest.vercel.app/poker-table.html` showing the join screen and the waiting-seat view, both legible with no horizontal overflow.

**DEPLOYED. PRODUCTION VALIDATED.**
