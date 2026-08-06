# UI Convergence — Tier 2, Structural Work

## Objective

Resume UI Convergence Tier 2 with its structural half only, per the accepted scope: reduce the host's operational click-load and remove Trivia-specific vocabulary from the presentation layer, without touching any Experience Layer hypothesis (reveal animation, winner celebration, dimming, glow, sound, haptics — still explicitly deferred). Motivated by real production playtest evidence (Slices 001–006) showing the host console had become the operational control center, not a secondary panel, and that the Lock→Start→Close→Reveal→StartNext loop was pacing-repetitive across every prior implementation, which happened to be Trivia-shaped.

An explicit architectural correction was applied mid-design: rather than optimizing the new pacing specifically for Multiple Choice / Open Response, the mechanism itself — a single state-driven primary action, where each Interaction Engine's own state answers "what's next" — is the generalizable element. No future engine's shape is assumed by this pass; only the *lookup*, not the *sequence*, is baked in.

Deliberately excluded from this pass: merging Reveal and Start-Next into a single click. That specific optimization trades off against a real risk — a participant could miss the reveal entirely if it flashes past faster than `sessionSync`'s ~2s poll interval — and how long a reveal should stay visible before the game moves on is a felt-experience/pacing question, i.e. Experience Layer, not structural.

## What changed

**Turn terminology throughout the UI.** "Question" (host) and "Prompt" (participant) are replaced by "Turn" as the presentation-layer vocabulary in both files — the stepper step label, the interaction counter (`renderInteractionLabel()` → "Turn N"), the `PROMPT_ACTIVE` state label ("Turn Active"), and the participant's prompt-card heading ("Current Turn"). This is deliberately *not* a rename of the domain concept — `Interaction Instance` in `lib/session/*` is untouched. The presentation layer needed its own vocabulary specifically so it stops assuming every future Interaction Engine asks a "question": a Pictionary or Photo Challenge turn is not a question, but it is still a Turn.

**State-driven primary action** (`host.html`, `resolvePrimaryAction()`): the host's five separate buttons (`Lock Lobby`, `Start Next Question`, `Start Session`, `Close Submissions`, `Reveal Results`) are replaced by one `#btn-primary-action` button whose label and handler are resolved from current session/interaction state — a lookup, not a fixed sequence:

- `LOBBY_OPEN` → "Lock Lobby"
- `PROMPT_ACTIVE` → "Close Submissions"
- `SUBMISSIONS_CLOSED` → "Reveal Results"
- no interaction / `RESULT_REVEAL`, next prepared MC question exists → "Start Turn N" (starts that question)
- no interaction / `RESULT_REVEAL`, no prepared question left (or host toggled it open) → the ad-hoc Open Response form expands inline, "Start Turn N" starts it instead

A secondary toggle (`Ask an ad-hoc question instead` / `Use the next prepared question instead`) preserves the host's ability to interleave an unplanned Open Response question even while Multiple Choice questions remain queued — deliberately not removed in the name of simplification, since flexibility mid-game was real behavior worth keeping.

**Host control-center layout**: `host.html` restructured into a two-column CSS grid (`.control-grid`, 2fr/1fr at ≥860px, single column below) — Current Turn / progress / results / the sticky `.primary-action-bar` / secondary actions in the main column; Participants and Standings in the side column. The primary action bar is `position: sticky` so it stays reachable without scrolling regardless of how long the results list grows.

**Compact room code**: once `sessionLifecycleState` is anything other than `LOBBY_OPEN`, the room code card collapses to a compact strip (`updateRoomCodeDisplayMode()`) — it matters most while people are joining and far less once the game is running.

**Collapsible "Manage Content"**: the Authoring Workspace is wrapped in `#authoringWorkspaceBody`, auto-collapsed exactly once on the transition into `LOBBY_LOCKED` (`updateManageContentDisclosure()`, guarded by `manageContentAutoCollapsed` so it never fights a host who manually reopens it — `PREPARE_QUESTIONS` remains valid mid-game). A `Manage Content` / `Hide Content` toggle button controls it thereafter.

**Participant focus mode** (`participant.html`, `updateFocusMode()`): the stepper and standings are hidden while a Turn is active and the participant has not yet completed their part of it in the current page load (`effectiveState === "PROMPT_ACTIVE" && !hasSubmittedThisPageLoad`), applied last in `applySessionSnapshot()` so it overrides `renderStandings()`'s own visibility decision. The intent is that participants spend as little attention as possible on anything but the current Turn while it's actionable; once they submit, or once results are revealed, the stepper and standings return.

## Files changed

- `public/host.html` — control-center CSS, markup restructure, `resolvePrimaryAction()` and its supporting functions, Turn terminology, Manage Content disclosure, compact room code.
- `public/participant.html` — Turn terminology, `updateFocusMode()`.

No changes to `lib/session/*`, migrations, or API routes. No Experience Layer element (purple accent, animation, dimming, glow, sound, haptics) touched.

## Validation

- `npx tsc --noEmit`: clean.
- `npx vitest run`: full suite passing, unaffected as expected for a presentation-only change.
- `npm run build`: clean.
- **Live Operational Simulation** against the running dev server, full multi-Turn game: created a session, authored and saved 2 Multiple Choice questions, joined a participant, locked the lobby, ran Turn 1 (Multiple Choice, correct answer) through submit → close → reveal, ran Turn 2 (Multiple Choice, incorrect answer) through the same cycle confirming the prepared-question queue and standings updated correctly, confirmed the primary action correctly detected queue exhaustion after Turn 2 and auto-expanded the ad-hoc Open Response form, ran Turn 3 (ad-hoc Open Response) through submit → close → reveal → manual award, then ended the session and confirmed the `SESSION_COMPLETE` layout (winner banner, secondary-actions row: Check for updates / End Session / Create New Session / Create Rematch).
  - Confirmed focus mode on the participant: stepper and standings hidden while each Turn was active and unanswered (both Multiple Choice and Open Response), and correctly restored immediately after submission and again after each reveal.
  - Confirmed the host control-center layout at a 400px mobile viewport: single-column stacking, no overflow, all controls reachable.
  - Confirmed `?debug=1` still correctly reveals the sync debug panel and the Session (dev info) card within the restructured layout, and that a page reload correctly resumes the in-progress session via `sessionStorage`.
  - Confirmed the participant's post-completion panel (winner banner, "Join another session") renders correctly under the Turn-terminology changes.

## Defects found during simulation, and their actual cause

Two results during the simulation initially looked like Structural Tier 2 defects and were investigated before being ruled out:

1. **Participant appeared not to enter focus mode when a Turn started.** Root cause: a sequencing error in the simulation itself — the participant attempted to join *after* the host had already locked the lobby, which the API correctly rejects (`409 Conflict`, joining is only valid during `LOBBY_OPEN`). The participant was never actually in the session; `Participants (0)` on the host confirmed this. Re-run with the participant joining before lock produced the correct result: stepper and standings hidden, prompt card visible, "Current Turn" heading shown.
2. **Clicking the primary action after the prepared-question queue was exhausted returned `400 Bad Request` ("Prompt text cannot be empty").** This was also a simulation artifact, not a defect: `resolvePrimaryAction()` correctly detected the exhausted queue and expanded the ad-hoc Open Response textarea inline (visible in a screenshot taken at the time) — the automated click fired before that textarea was filled in. Filling it and re-clicking succeeded (`200 OK`), confirming the fallback behavior itself is correct.

No code changes resulted from either investigation.

## Explicitly deferred

- The Experience Layer (purple accent, reveal animation, winner celebration, dimming, glow, future sound/haptics) — each to be tracked individually as a hypothesis (hypothesis / expected emotional outcome / implementation / validation criteria / playtest observations / final decision) once this Structural baseline is reviewed and accepted.
- Merging Reveal and Start-Next into one action — an Experience Layer pacing question, not structural.
- Experience Composition, Social Identity, Economy, and the URBANO/Level 33 constitutional relationship review — all out of scope for this phase per standing instruction.

This is a stopping point for review, per the agreed sequence: Structural work → operational simulation → review → Experience Layer.

## Addendum: Production Playtest Findings (Iteration 2)

A real production playtest against the deployed Structural Tier 2 build (`level33-mvp-playtest.vercel.app`) surfaced two structural refinements, applied below, plus two observations that were explicitly not implemented — captured here per instruction, not acted on.

### Structural refinements (implemented)

**Host control-center region arrangement.** The two-column layout (`host.html`) rearranged the Roster (Participants + Standings) to appear first — both physically first in the markup, and therefore first in reading order whether stacked (mobile/narrow, below the 860px breakpoint) or side-by-side (desktop). Previously the Roster sat in a narrow trailing `1fr` column behind a `2fr` main column; on any viewport narrower than 860px this also meant it rendered dead last, after the Current Turn content, the primary action bar, and the secondary actions — never "immediately visible" the way a host's core "who's here / how are they doing" context should be. The grid ratio also moved from `2fr 1fr` to `1fr 1.4fr`, giving the Roster meaningfully more width instead of reading as an afterthought. This is a pure rearrangement: no card was added, removed, or had its show/hide logic touched — `getElementById` targeting, `resolvePrimaryAction()`, and every other structural mechanism from the original Tier 2 pass are unchanged.

**Participant dedicated completion screen.** `renderPrompt()` and `renderResults()` had always treated `SESSION_COMPLETE` as just another "past `PROMPT_ACTIVE`" state to keep showing that Turn's content in — so a participant landing on a finished session still saw the final Turn's prompt, their submitted answer, and the full results list, alongside the intended Winner/Standings/Continuation content. This was a genuine defect, not a missing enhancement: nothing about the final Turn belongs on a completion screen. Fixed via a new `updateCompletionScreen(effectiveState)` in `participant.html`, called last in `applySessionSnapshot()` (the same override-at-the-end position `updateFocusMode()` already uses) — when `effectiveState === "SESSION_COMPLETE"`, it force-hides the stepper, the generic state message, and every Turn-content card (`promptCard`, `submitCard`, `optionsCard`, `progressCard`, `resultsCard`), leaving exactly what was specified: Winner banner, Final Standings, and the continuation card (Join Next Session / Join Another Session). Verified live: a session carried through to `SESSION_COMPLETE` now shows only Standings + Winner banner + the continuation form — nothing from the last Turn.

Both changes verified via `npx tsc --noEmit`, `npx vitest run` (208/208 passing), `npm run build`, and live checks against the dev server (control-grid reordering at both desktop and 400px mobile width; the completion screen rendering correctly for a session that had already been played through to completion).

### Architectural observation — captured, not implemented

The playtest surfaced a discovery about where the platform's Turn/Trivia coupling is heading: today, **one Turn is one Trivia question** — the domain layer's Interaction Instance and a single question are effectively the same thing. The playtest evidence points toward a future architecture where **one Turn is one Experience**, with Trivia becoming *one* Experience type capable of containing multiple questions, rather than the Turn/question relationship staying 1:1.

Per explicit instruction, this is recorded as an observation only. It is not implemented, no code was changed toward it, and the current Trivia implementation (one Turn = one question) remains the validated baseline. This belongs to a future, separately authorized Experience Composition workstream — the same deliberate deferral already applied to Experience Composition, Social Identity, and Economy elsewhere in this document.

### Experience Layer framing observation — captured, not implemented

A related observation concerns the still-deferred Experience Layer. The absence of the experimental purple accent during this playtest was noted as validating the agreed sequencing (Tier 1 baseline → Structural work → operational simulation → only then Experience Layer). The framing for *when* purple is eventually tried has been refined: rather than a general URBANO Gaming identity color, purple is now framed as **the visual language of live gameplay activity** — reserved for moments like an active Turn, a reveal, a winner celebration, a future timer, or a future lightning round — while gold continues to represent Recognition. The constitutional palette remains charcoal, ivory, and gold; purple would remain exclusively an Experience Layer element, tracked as an individually removable hypothesis if and when that layer is authorized.

No purple, no animation, and no other Experience Layer element was added to either file in this iteration. This refinement is recorded so it is available when Experience Layer hypothesis-tracking begins, not acted on now.

### Status

Awaiting another production playtest round following these structural refinements before Structural Tier 2 is accepted. Not yet committed, pushed, or deployed — per standing practice, these changes wait for explicit instruction before any of those three steps.
