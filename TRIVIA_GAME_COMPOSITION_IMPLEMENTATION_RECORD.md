# Trivia Game Composition — Implementation Record

## Objective (as accepted)

Founder production playtest of Slice 009 exposed a Product-model problem: a real prepared set of Trivia questions rendered as N separate "Turn 1", "Turn 2", ... "Turn N" — each its own Segment, each with its own single-Interaction standings, rather than one coherent Trivia Game. The founder-directed corrective design (a prior, read-only investigation, not part of this record) established the accepted composition:

**Session → Segment (= one Trivia Game) → N Multiple Choice Interaction Instances (Question 1..N)**

This record covers the accepted design's *implementation*: making a multi-question Trivia Game actually compose into one Segment, correcting public vocabulary from Segment-derived "Turn" language to Trivia's own "Question" language, reducing host administration per question to a single composed action, and adding the smallest participant-safe read model needed to show "Question X of N" without exposing prepared-question content.

## Canonical architecture evidence (why no schema or migration change was required)

`Session_Architecture.md` (post-Slice-007 update) states directly: *"a future Experience design remains free to group many Interaction Instances (ten Trivia questions) into one segment if that better serves the experience, exactly as the existing examples already show."* The same document's "Multi-Interaction Session" example (`Session → Trivia [Question 1,2,3] → Final Result → Complete`) and Architectural Rule 6 ("One game may contain one or many Interaction Instances") describe the same model independently. `Runtime_Architecture.md` names Trivia by name as a canonical "Game or Experience Segment" example with the identical elasticity note.

`CURRENT_SEGMENT` (Slice 008, migration `0037`) already exists, is already engine-agnostic, and was already proven safe under concurrency (Slice 008's own concurrent-`NEW_SEGMENT` test). Prior to this record it had only ever been exercised by Voting attached to Open Response (the "Best Joke" case) — never by two Multiple Choice Interaction Instances in sequence. This implementation is therefore a composition/orchestration correction: it makes Trivia use a capability the architecture and the domain layer already fully support, not a new capability. No migration was created; the local schema remains at `0040`.

## Files changed

- **`lib/session/types.ts`** — added `QuestionProgress { current: number; total: number }` and a `questionProgress: QuestionProgress | null` field on `GetSessionResult`.
- **`lib/session/getSession.ts`** — fetches prepared questions once (only when `isHost || currentInteraction?.engineType === "MULTIPLE_CHOICE"`, to avoid a new query on the hot participant-polling path for Open Response/Voting sessions) and derives `questionProgress` from `consumedAt`/count — `current` is the count of already-consumed prepared questions, `total` the count of all prepared questions for the session; `null` when the current engine isn't Multiple Choice. No schema change; no new columns.
- **`public/host.html`**:
  - `renderInteractionLabel()` now shows `Question X of N` (from the new `questionProgress`) instead of `Turn N` whenever `currentEngineType === "MULTIPLE_CHOICE"`; Open Response and Voting keep `Turn N` unchanged.
  - New `triviaNextQuestion()` — a client-side composed action chaining `CLOSE_SUBMISSIONS → REVEAL_RESULTS → START_SESSION(segmentTarget: CURRENT_SEGMENT)`, re-checking live `interactionLifecycleState` before each step (via `hostRefresh()`) rather than assuming the prior step succeeded, so re-invoking it after a partial failure resumes from whatever state actually committed instead of retrying a step that already landed. An in-flight boolean guard plus `btn.disabled` prevent same-tab double-clicks.
  - `resolvePrimaryAction()`: for Multiple Choice, `PROMPT_ACTIVE`/`SUBMISSIONS_CLOSED` now show **Next Question** (calling `triviaNextQuestion()`) instead of the separate **Close Submissions**/**Reveal Results** buttons; a new branch keeps the flow inside the current Segment (`CURRENT_SEGMENT`) whenever another prepared question remains after `RESULT_REVEAL`; the Multiple-Choice **Start** label reads **Start Trivia** instead of `Start Turn N`.
  - New `triviaFinalResultsBanner` element/markup — shown (only) once the last prepared question has been revealed and no next question remains, reading "Final Results — Trivia complete. See Standings."; the existing Choose Turn Type selector remains reachable underneath it, since Trivia Game completion may coincide with, but does not have to end, the Session.
  - `startTurn()` (which starts Question 1) was not changed — it already defaults to `NEW_SEGMENT` for Multiple Choice, which is exactly the desired behavior for opening a new Trivia Game.
- **`public/participant.html`** — `renderPrompt()` takes a new `questionProgress` parameter and renders it in a new `questionProgressLabel` element (sibling of `#stepper`, mirroring `host.html`'s `interactionLabel` placement/styling) whenever non-null; absent for Open Response/Voting exactly as before.
- **`__tests__/getSession.test.ts`** — one new test: `questionProgress` is `null` for a fresh session with no current interaction.
- **`__tests__/triviaGameComposition.test.ts`** — new file, 14 tests (Composition, `questionProgress`, Scoring, Next Question progression control, rematch isolation — see Tests below).
- **`package.json`** — registered the new test file in the explicit `npm test` file list.

No migration. No `lib/session/startSession.ts`, `closeSubmissions.ts`, or `revealResults.ts` change — Trivia's multi-question flow is entirely a new *composition* of these three already-existing, already-atomic operations.

## Turn vocabulary correction (scope)

"Segment" remains the internal architecture name everywhere — never renamed, in code or in this record. "Turn" is Experience-specific public vocabulary (reserved especially for a future Level 33-style progression), not a universal label; Trivia's own public progression vocabulary is "Question." This correction is scoped to the two software surfaces this flow actually touches (`host.html`, `participant.html`) and, within them, only to labels that were rendering `Turn N` for a Multiple Choice Interaction: `renderInteractionLabel()`'s "Turn N" text, the `Start Turn N` button label, and the per-question host progression controls. Open Response and Voting's "Turn N" / "Start Turn N" / "Close Submissions" / "Reveal Results" labels are untouched.

**Deliberately left unchanged, considered in scope but judged out of scope for this task**: both files' `STATE_LABELS` mapping (`PROMPT_ACTIVE: "Turn Active"`) feeds a generic six-step lifecycle stepper (`Lobby Open → Lobby Locked → Turn Active → Submissions Closed → Results → Complete`) shared identically by all three engine types. Unlike `Turn N`, this label carries no Segment/question-number semantics — it names a lifecycle phase, not a Turn count — so it was judged out of this task's scope ("only correct what's required by this task," "do not globally delete Turn terminology"). Flagged here as an explicit deferral rather than silently left alone.

**Confirmed**: `Segment` was not globally renamed — it remains the internal domain/architecture name in every file, every identifier (`segmentNumber`, `segmentTarget`, `segments` table, etc.), and every code comment this implementation touched. Slice 008's own history (`SLICE_008_IMPLEMENTATION_RECORD.md`, `__tests__/segment.test.ts`'s "Best Joke proving case" language) was not rewritten — this record cites it but does not alter it.

## Question progress read model

`questionProgress: { current, total } | null` is deliberately minimal: both fields are counts already derivable from data any caller could already infer indirectly, carrying zero authoring content — no `correctOptionIndex`, no option text, no not-yet-asked question text, nothing the host-only `preparedQuestions` array exposes. `total` is intentionally session-wide rather than scoped to a named Question Set (no such entity was introduced). Host and participant receive the identical object, which is what let `host.html` and `participant.html` share the same "Question X of N" rendering logic. Verified experimentally (`__tests__/triviaGameComposition.test.ts`, "never leaks..." test): `JSON.stringify()` of a participant's full `GET_SESSION` response, with a 3-question Trivia Game in progress, contains no text from any not-yet-asked question and no correct-answer index for the current one.

## Host administration reduction — safety reasoning

**`Next Question` is not itself one atomic transaction.** It is a host-orchestration action, implemented client-side in `triviaNextQuestion()`, that composes three existing, independently authoritative operations in sequence:

`CLOSE_SUBMISSIONS → REVEAL_RESULTS → START_SESSION(CURRENT_SEGMENT)`

Each operation remains authoritative and atomic only at its own existing boundary (its own API call, its own underlying RPC) — exactly as it was before this implementation. The composed action is retry-aware and state-aware (it re-reads live `interactionLifecycleState` before each step rather than assuming the prior step succeeded), but **partial completion between operations can occur**: the process can be interrupted after `CLOSE_SUBMISSIONS` commits and before `REVEAL_RESULTS` is called, for instance. What makes this safe is not that the three steps happen as one transaction — they do not — but that re-invoking `triviaNextQuestion()` after a partial completion resumes correctly from whatever state actually committed, and that duplicate advancement (double-click, concurrent invocation) was pressure-tested and found safe:

- Each of the three composed calls is independently already atomic and exactly-once under concurrency — the same row-locking guarantee Slice 001/008's own concurrent-`START_SESSION` tests already establish for the underlying `start_session_atomically` SQL function. No single call's own boundary was changed by this implementation.
- **Close-succeeds-but-reveal-fails / reveal-succeeds-but-next-start-fails**: re-invoking `triviaNextQuestion()` re-reads `interactionLifecycleState` and resumes from whichever step's precondition is actually still unmet — it does not repeat a step whose effect already committed. Proven directly: `triviaGameComposition.test.ts`'s two "re-invoking ... after it already succeeded fails honestly" tests confirm the underlying guard (`PromptNotActiveError` / `SubmissionsNotClosedError`) rejects a redundant call rather than silently double-processing, and that the composed flow can still recover by proceeding to whichever step *is* valid.
- **Double-click / repeated-click**: a `triviaAdvanceInFlight` boolean plus `btn.disabled` prevent same-tab double-submission; at the domain layer, `triviaGameComposition.test.ts`'s concurrent-`CURRENT_SEGMENT`-start test proves that even without the client-side guard, exactly one of two simultaneous `START_SESSION(CURRENT_SEGMENT)` calls for the same next question succeeds and no duplicate Interaction Instance is created — the same lifecycle-guard mechanism Slice 008 already relies on for `NEW_SEGMENT`.
- **Stale host tab**: covered by the same re-invocation reasoning above — a stale tab's click re-reads live state before acting, so it cannot blindly repeat a step already committed by another tab or a prior click.
- **Participant still submitting**: unchanged existing behavior — `CLOSE_SUBMISSIONS` is the same operation as before; the host remains the pacer, no auto-close/auto-reveal was added.
- **No next question**: `triviaNextQuestion()`'s `RESULT_REVEAL` branch checks `lowestUnconsumedPreparedQuestion()` and simply returns (no `START_SESSION` call) when nothing remains — proven live in the 10-question browser simulation below (no `/start` request fired on the final question's advance) and in the "no next question available" unit test.

**Conclusion: no new atomic RPC was required for this implementation.** The composed, retry-aware orchestration above was judged sufficient under the failure modes actually pressure-tested. This is a judgment based on today's evidence, not a permanent architectural claim — if this orchestration later proves insufficient under real operational conditions (e.g. a failure mode not covered by the tests above, or an operational incident), atomic server-side orchestration (a new RPC spanning all three steps) may be reconsidered from that evidence. The reasoning above is recorded per the founder's explicit instruction, rather than merely asserted.

## Final-question / final-results behavior

When the current question is the last prepared one, `resolvePrimaryAction()` does not offer "Next Question" — it shows the `triviaFinalResultsBanner` ("Final Results — Trivia complete. See Standings.") instead, and the general Choose Turn Type selector remains available underneath for whatever the host does next. No new Game Outcome object and no `champion` aggregation architecture were introduced; the existing session `standings` (unchanged since Slice 002/awardPoints) are the Trivia Game's final result, exactly as instructed. The member-facing shape is `Question N of N → Final Results → standings/winner`, confirmed end-to-end in both the 10-question and mobile simulations below.

## Prepared-question semantics (scope)

For this implementation, the existing session-scoped prepared-question queue (`ordinal` + `consumedAt`) *is* the ordered question sequence for the one Trivia Game proving case. No Question Bank, named Question Set, Quiz entity, reusable content library, or multiple named Trivia Games within one Session were introduced — these remain legitimate future pressures, not implemented here.

## Trivia/Quiz boundary (scope)

This implementation is Trivia-only. No Quiz entity, Quiz button, or new Interaction Engine was added. The current architecture — Multiple Choice Engine plus multi-question Segment composition, as implemented here for Trivia — is capable of supporting a future Quiz Experience through this same composition, differing only in content/authoring/presentation; that is a description of present capability, not a commitment. Quiz itself is not implemented.

## Tests

`__tests__/triviaGameComposition.test.ts` (14 tests, all against `InMemorySessionRepository`):

- **Composition** (3): Question 1 opens a `NEW_SEGMENT`, Questions 2–3 attach via `CURRENT_SEGMENT` (one Segment, three Interaction Instances, single `segmentId`); `segmentNumber` stays constant while `interactionNumber` advances per question; a Trivia Game started after an unrelated already-completed Turn still opens its own `NEW_SEGMENT`.
- **`questionProgress`** (4): `null` for Open Response and for Voting; `{current:1,total:3}` immediately after Question 1 starts (host and participant alike); `{current:3,total:3}` once the final question has started, persisting through `RESULT_REVEAL`; never leaks `correctOptionIndex`, option text, or any other prepared-question content to a participant.
- **Scoring** (1): final standings across a 3-question Trivia Game equal the sum of `point_awards` per participant (`30`/`35` for two participants with a mixed correct/incorrect pattern across three different point values); `segmentNumber` stays `1`, `interactionNumber` reaches `3`.
- **Next Question progression control** (5): advances cleanly without duplicating Segments/Interaction Instances across three questions; re-invoking `closeSubmissions`/`revealResults` after either already succeeded fails honestly (`PromptNotActiveError`/`SubmissionsNotClosedError`) rather than silently duplicating state, and the composed flow can still recover from either point; concurrent double-click at the start-next-question step: exactly one of two simultaneous calls succeeds, no duplicate Interaction Instance; the last prepared question, once revealed, correctly reports zero unconsumed questions and `questionProgress` of `{3,3}`.
- **Rematch isolation** (1): a successor session starts with zero Segments and zero prepared questions of its own; the predecessor's Segment and its own (including never-started) prepared questions remain untouched and do not leak into or block the successor's own Trivia Game.

`__tests__/getSession.test.ts` (+1): `questionProgress` is `null` for a fresh session with no current interaction.

**Regression** (not duplicated as new tests — the existing suites already cover these scenarios and were re-run unmodified as part of `npm test`): Best Joke (`__tests__/segment.test.ts`'s "Best Joke proving case" — Open Response then Voting via `CURRENT_SEGMENT`), Voting (`__tests__/voting.test.ts`, `__tests__/participantsVoting.test.ts`), Open Response (`__tests__/submitResponse.test.ts`, `__tests__/closeSubmissions.test.ts`, `__tests__/revealResults.test.ts`), rematch isolation for non-Trivia sessions (`__tests__/segment.test.ts`, `__tests__/createSuccessorSession.test.ts`). All passed unchanged.

## Verification

- **Type-check** (`npx tsc --noEmit`): clean.
- **Full in-memory behavioral suite** (`npm test`): **257/257** passing (242 pre-existing + 14 new in `triviaGameComposition.test.ts` + 1 new in `getSession.test.ts`).
- **Local Postgres contract suite** (`npm run test:contract`, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` passed as explicit shell environment variables pointed at the local stack — the same override technique established in Slice 007/009, never touching `.env.local`'s production values): **47/47** passing, confirming no schema drift against the local database (still migrated through `0040`, no new migration).
- **Production build** (`npm run build`): clean.

### Local browser operational simulation (desktop, real 10-question set)

Host + 2 participants (Alex, Jordan) against a `next dev` instance temporarily pointed at the local Postgres stack (`.claude/launch.json` temporarily wrapped in an inline env-var override, the identical scaffolding technique used and reverted in Slice 009 — reverted again here; `.claude/launch.json` carries no diff in the final state, confirmed via `git status`). Ten real questions were authored through the existing Authoring Workspace bulk-import path (`Pizza topping / Cats-or-dogs / Sun-or-moon / Sky color / 2+2 / Capital of France / Largest ocean / Fastest land animal / Continents / Freezing point`, mixed point values 10/15/20).

Full flow driven end-to-end: **Choose Turn Type → Trivia → Start Trivia → Question 1 of 10** → both participants answer → **Next Question** (composed close→reveal→start) → **Question 2 of 10** → ... → **Question 10 of 10** → **Next Question** on the final question correctly performed close+reveal only, with no `/start` request — **Final Results — Trivia complete. See Standings.** banner appeared, no further "Next Question" offered.

Load-bearing invariants confirmed **directly against local Postgres** (not just the UI): exactly **1 Segment**, exactly **10 Multiple Choice Interaction Instances**, `segmentNumber` constant at `1` throughout, `interactionNumber` reaching `10`. Final scoring (mixed correct/incorrect answers across 10 questions of varying point value) matched exactly between the UI standings, the `point_awards` table (9 rows — no award for the one question both participants missed), and manual arithmetic: Alex 75, Jordan 30. No "Turn 1/2/3..." label appeared anywhere during the Trivia Game; every question showed "Question X of 10" to host and both participants.

Session completed (**Winner: Alex (75 pts)**), a rematch created, and rematch isolation verified directly against Postgres: the successor session had **zero Segments and zero prepared questions** of its own; the predecessor's one Segment (and its exhausted 10-question queue) remained untouched.

### Mobile validation (375×812)

A second, smaller (2-question) Trivia Game was run at a 375×812 viewport with two participants, covering Start Trivia → Question 1 of 2 → answer → Next Question (composed action) → Question 2 of 2 (final) → answer → Next Question correctly performed close+reveal only → Final Results banner → session complete (Winner: Alex, 20 pts). Confirmed via real screenshots at each reachable checkpoint (Lobby Open card, Authoring Workspace/bulk-import textarea, and the final participant Question 2 of 2 / Final Results / Standings screen): no horizontal overflow at any point, full-width buttons with generous tap-target height (`Lock Lobby`, `Join`, question option buttons), and the same "Question X of N" / "Final Results" / standings content confirmed via the live DOM as on desktop.

**Environment note**: partway through this pass, the Browser pane's click-injection tool (`computer` action `left_click`) began timing out across all tabs — a tool/environment issue, not a defect in the application under test (screenshots and `read_page` continued to work throughout, and recovered for click actions by the end of the pass). The remaining mobile interactions (answer selection, `Next Question`, session completion) were driven by invoking the identical functions the corresponding buttons' own `onclick` handlers call (`triviaNextQuestion()`, the option buttons' `.click()`, etc.) — functionally equivalent to a tap for verifying application logic and DOM state, though it does not exercise raw touch-event handling. Layout/overflow/tap-target evidence above comes from real screenshots, not this workaround.

## Product documentation currency (not modified — findings recorded for founder awareness only)

- `Session_Architecture.md`'s "Current MVP Mapping" section states Segment "has never been implemented" — stale; it predates Slice 008 (which implemented Segment) and this record's own use of `CURRENT_SEGMENT` for Trivia. Not corrected here per the explicit instruction not to modify Product/Architecture documentation during this software implementation.
- `Game_Composition_Architecture.md`'s "Interaction Sequence" terminology loose end (noted in the prior corrective-design investigation) remains unresolved — it did not block this implementation, so it was not addressed.

## Explicit deferrals (legitimate future pressures, not implemented here)

- Quiz entity / Quiz button / new Interaction Engine.
- Question Bank, named Question Set, reusable content library.
- Multiple named Trivia Games within a single Session.
- A new Game Outcome object or `champion` aggregation architecture.
- Auto-close or auto-reveal based on all-participants-answered — the host remains the pacer.
- `STATE_LABELS`'s generic `"Turn Active"` lifecycle-stepper label (shared by all engine types) — considered, deliberately left unchanged (see Turn vocabulary correction above).
- Private Table / Private Hand, Prediction/Golazo, tournament/external-orchestration concepts, Slice 010 — none touched, per explicit founder instruction.

## Recommendation

**Accept as a local implementation candidate.** All four verification gates are clean (tsc, 257/257 behavioral tests, 47/47 local contract tests, build), the corrected composition was proven both by targeted unit tests and by a real 10-question end-to-end browser simulation with direct Postgres confirmation of every load-bearing invariant, mobile validation surfaced no layout defects, and every existing regression-risk area (Best Joke, Voting, Open Response, rematch isolation) passed unmodified. No architecture deviation, no migration, no scope creep into Quiz/Slice 010/Private Table/Prediction — all explicitly out of scope and confirmed untouched.

Per the founder's explicit instruction: **not staged, not committed, not pushed, not deployed.** Stopped here for founder review.
