# Experience Layer — First Iteration

## Objective

Make gameplay feel more exciting without changing the underlying platform architecture, building directly on top of the accepted Structural Tier 2 foundation (state-driven primary action, Turn terminology, control-center layout). Per `Product/URBANO_Gaming_Application.md`, purple is introduced exclusively as an Experience Layer Activity signal — never part of the constitutional charcoal/gold/ivory identity — complementing gold's Recognition role rather than competing with it. Every element below is tracked individually as a removable hypothesis, not shipped as a permanent design decision.

Explicitly out of scope for this iteration, per standing instruction: Experience Composition, repository restructuring, any new platform capability, any change to the one-Turn-per-question Trivia baseline, and any retro/pixel/CRT visual treatment (an open question deliberately left to a future hypothesis rather than resolved here — see `Product/URBANO_Gaming_Application.md`'s Future Hypotheses).

## Hypotheses

### Hypothesis 1 — Active Turn reads as "live" (purple)

- **Hypothesis**: giving the active Turn's prompt a purple border and soft glow, replacing its default gold framing only while `PROMPT_ACTIVE`, will make the current moment read as "something is happening right now" without competing with gold's Recognition role.
- **Expected emotional outcome**: a small jolt of "it's live" energy at the moment a Turn starts, on both host and participant.
- **Implementation**: `.prompt-text.exp-live` (purple border-left + box-shadow glow), toggled by `updateExperienceLayer()` based on `interactionLifecycleState === "PROMPT_ACTIVE"` (host) / `effectiveState === "PROMPT_ACTIVE"` (participant). Reverts to the default gold border the instant the Turn is no longer active.
- **Validation criteria**: does it read as "live," not as an error/warning state? Does it stay legible against charcoal? Does gold's Recognition role stay undiluted elsewhere on screen?
- **Playtest observations**: verified live via the dev harness — purple border + glow render correctly at both desktop and mobile widths on host and participant, correctly toggles off the instant submissions close, and correctly re-triggers on a second Turn in the same session. No production playtest observation yet.
- **Final decision**: pending a real production playtest.

### Hypothesis 2 — Reveal pulse

- **Hypothesis**: a brief, non-looping purple pulse the instant a Turn's results become visible will make the reveal feel like a distinct moment, separate from the correctness colors (green/red) already on individual results.
- **Expected emotional outcome**: a "that just happened" beat at reveal, without delaying or distracting from reading the actual results.
- **Implementation**: `@keyframes expRevealPulse` (700ms, ease-out, runs once) applied to `#resultsCard` via a `.exp-reveal-pulse` class, added on the detected transition into `RESULT_REVEAL` (tracked via `expLastInteractionState`, forced to restart via a remove/reflow/re-add so a second Turn's reveal repeats the pulse rather than no-op'ing because the class never left).
- **Validation criteria**: does the reveal feel like an event? Does it interfere with reading results? Does it repeat correctly on every Turn's reveal, not just the first?
- **Playtest observations**: verified live across two consecutive Turns in the same session — the pulse correctly fires on both reveals, confirmed via computed class state at the moment of transition. No production playtest observation yet.
- **Final decision**: pending a real production playtest.

### Hypothesis 3 — Winner celebration (purple framing gold)

- **Hypothesis**: framing the gold winner banner with a few seconds of purple pulse will read as complementary (Activity energy framing a Recognition moment) rather than the two colors competing for attention.
- **Expected emotional outcome**: the winner moment feels more celebratory without the gold Recognition message losing its role as the clear focal point.
- **Implementation**: `@keyframes expWinnerPulse` (1.4s, ease-in-out, 3 iterations then settles — never becomes ambient looping motion on a screen left open) applied to `.winner-banner.exp-celebrate`, added once per completed session (`expCelebrationPlayed` flag) and specifically gated on an actual winner existing — a defect caught during this iteration's own simulation: the celebration initially fired even for "No winner determined — no points were awarded," which would have celebrated a non-event. Fixed by checking the banner's own text before adding the class.
- **Validation criteria**: do gold and purple read as complementary here, or do they clash? Does the "no winner" case correctly stay purple-free?
- **Playtest observations**: verified live — celebration correctly fires for an actual winner, correctly withheld for "no winner determined," correctly plays exactly once per session (confirmed stable across repeated poll ticks), and correctly resets for a second game created in the same tab. No production playtest observation yet for the actual gold+purple emotional read.
- **Final decision**: pending a real production playtest.

## What did not change

- No domain, migration, or API changes.
- No change to the one-Turn-per-question Trivia baseline.
- No retro/pixel/CRT visual treatment — deliberately deferred as an open question, not resolved here.
- No motion beyond the three scoped hypotheses above — no ambient animation, nothing that gates or delays the host's control flow.
- The Structural Tier 2 host layout (Roster-first control-grid) and the participant completion screen (Winner/Standings/Continuation only) are unchanged and were re-verified, not regressed, by this pass.

## Files changed

- `public/host.html`, `public/participant.html` — Experience Layer CSS block (`--exp-purple`, `--exp-purple-glow`, `.exp-live`, `.exp-reveal-pulse`, `.exp-celebrate`, their keyframes) and `updateExperienceLayer()` plus its supporting state (`expLastInteractionState`, `expCelebrationPlayed`, reset in `switchToNewSession()` / `switchToJoinedSession()`).
- `Product/URBANO_Gaming_Application.md` — new application-tier document (not constitutional) preceding this implementation, per explicit instruction: reviews the current URBANO Gaming logo and the Logo Concepts exploration, and establishes the Recognition (gold) vs. Activity (purple) framing this implementation applies.

No changes to `lib/session/*`, migrations, or API routes.

## Validation

- `npx tsc --noEmit`: clean.
- `npx vitest run`: 208/208 passing, unaffected as expected for a presentation-only change.
- `npm run build`: clean.
- **Live operational simulation** against the running dev server, across three separate sessions: a single-Turn game verifying all three hypotheses individually; a two-Turn game verifying Hypotheses 1 and 2 correctly re-trigger per Turn rather than firing only once; and a dedicated check of Hypothesis 3's winner/no-winner distinction after the defect above was found and fixed. Confirmed at both desktop (1280px) and mobile (400px) viewport widths, and confirmed `?debug=1` gating is unaffected.

## Defect found and fixed during this iteration's own simulation

The winner celebration (Hypothesis 3) initially applied `.exp-celebrate` any time `SESSION_COMPLETE` was reached with a visible winner banner — including the "No winner determined — no points were awarded" case, which is a non-event, not a winner. Fixed by checking the banner's own rendered text before adding the class, in both `host.html` and `participant.html`. Caught and fixed before any production exposure.

## Status

Awaiting a real production playtest before any of the three hypotheses is accepted, iterated on, or removed. Not committed, pushed, or deployed — per standing practice and the explicit instruction to complete a full operational simulation first.
