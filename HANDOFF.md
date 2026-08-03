# Handoff — Level 33 MVP

Prepared for a fresh Claude conversation continuing this work. Read
this before taking any action; it summarizes state established across
prior sessions so it doesn't need to be rediscovered.

## Repository state

- Branch: `integrate/join-session`
- Latest commit: `7ac0d11` — "feat: separate Session and Interaction
  lifecycles, enabling sequential interactions" (Slice 001, following
  `a2dc68a`).
- Slice 001 (Session / Interaction separation) is implemented, tested,
  live-verified, architecture-reviewed, and **constitutionally
  accepted**. The events this document previously said were still
  pending — the multi-human playtest, and any implementation slice
  chosen from its findings — have both happened; see below.
- No implementation slice is currently authorized. Do not begin one
  without explicit user instruction — this document exists to
  orient a fresh session accurately, not to greenlight new work.
- The complete Slice 001 history (Feature Genesis, Slice Selection,
  Slice Design, Implementation & Validation, Constitutional
  Acceptance) is permanently preserved in the constitutional
  repository at `Level 33/History/Slices/Slice_001/`. This file
  stays a working summary for continuing the software session; that
  location is the canonical historical record.

## Implemented gameplay lifecycle

A complete, playable Level 33 loop is implemented end to end, and a
Session may now run any number of sequential interactions before
completing (Slice 001):

`CREATE_SESSION → JOIN_SESSION → LOCK_LOBBY →`
`[ START_SESSION (host-defined prompt, re-invocable) →`
`SUBMIT_RESPONSE (with revision) → CLOSE_SUBMISSIONS → REVEAL_RESULTS ] × N →`
`COMPLETE_SESSION`

`START_SESSION` may be called again once the current interaction
reaches `RESULT_REVEAL` — this is what makes multiple sequential
interactions possible per Session.

Architecture per command: transport-agnostic domain function
(`lib/session/*.ts`) → `SessionRepository` interface → two
implementations (`InMemorySessionRepository` test double,
`SupabaseSessionRepository` production) → thin Next.js API route
(`app/api/sessions/...`). Atomicity is enforced in Postgres via
`SELECT ... FOR UPDATE` row-locking RPC functions
(`supabase/migrations/`), with domain-typed errors translated from
named Postgres exceptions (`errcode = 'P0001'`). Slice 001 added a new
`interaction_instances` table (migrations `0015`-`0020`) that owns the
PROMPT_ACTIVE/SUBMISSIONS_CLOSED/RESULT_REVEAL lifecycle independently
of the Session's own (now narrower) LOBBY_OPEN/LOBBY_LOCKED/
SESSION_COMPLETE lifecycle — see ADR-006 (Accepted and Validated) and
`Architecture/Session_Architecture.md` / `State_Architecture.md`'s
"Current MVP Mapping" / "Current MVP State Model" sections.

Current MVP product rules (explicitly temporary, not permanent
gameplay rules — see prior Decision Reviews):
- Free-text-only submissions.
- One submission per participant per interaction instance; a second
  submission **overwrites** the first ("last write wins"), enforced
  via `ON CONFLICT` upsert in Postgres.
- Participant-only auth for `SUBMIT_RESPONSE` (bearer
  `participantToken`); no host fallback.
- Host-only, explicit `CLOSE_SUBMISSIONS` / `REVEAL_RESULTS` — no
  timers, no automatic transitions.
- Results show all responses attributed by display name — no
  anonymity, no voting, no scoring, no AI, no `SOCIAL_PAUSE`. Multiple
  *sequential* rounds are now supported (Slice 001); a generalized
  multi-engine/Game-level model is still not.

## Validation status

- **In-memory behavioral suite**: 121 tests passing across 9 files
  (`npm test`), covering every command's exhaustive edge cases and
  error paths against `InMemorySessionRepository`, including dedicated
  sequential-interaction scenarios added for Slice 001.
- **Live Supabase contract suite** (`npm run test:contract`):
  separately scoped — proves each atomic Postgres RPC function
  actually executes correctly against a real database (not a
  re-coverage of in-memory edge cases), including a full two-interaction
  lifecycle. Found and fixed real live-only SQL bugs across two
  slices: ambiguous-column-reference bugs in `RETURNS TABLE` functions
  (migrations 0013/0014), and — during Slice 001 — a `RETURNS TABLE`
  shape change that `CREATE OR REPLACE` cannot apply in place,
  requiring `DROP FUNCTION` + `CREATE FUNCTION` instead (migrations
  0017-0019, mirroring the fix already used in 0020). Neither bug
  class was ever visible to in-memory tests, since SQL identifier
  resolution and function-replacement rules don't exist in a plain JS
  test double.
- **Type-check** (`npx tsc --noEmit`): clean.
- **Production build** (`npm run build`): clean. Known hazard —
  never run a production build while `npm run dev` is running
  against the same `.next/` directory; it corrupts the dev server's
  module cache. Always stop the dev server first.
- **Harness-split Operational Simulation (pre-Slice-001)**: fully
  completed against the live backend across two separate sessions
  (interrupted once by an external Supabase Cloudflare 522 outage,
  later resumed cleanly from a preserved checkpoint — see "Validation
  status categories" in memory). Confirmed: full lifecycle
  correctness, host Results rendering, participant reveal view with
  "(you)" own-response highlight, `completeSession()` transition, and
  the `lastKnownSubmissions` client-side cache correctly keeping the
  Results card visible after the backend's `submissions` field
  reverts to `null` at `SESSION_COMPLETE`.
- **Multi-human playtest of the role-separated interfaces**: has since
  happened. It found a systemic silent-error defect (no visible
  feedback on failed requests), remediated in commit `9e89f7e` before
  Slice 001 began.
- **Two-interaction Operational Simulation (Slice 001)**: run live
  through the actual `host.html`/`participant.html` harness (one host
  tab, two participant tabs) — full two-round lifecycle, including
  re-invoking `START_SESSION` after a reveal. This caught a real bug:
  a participant tab that missed an interaction's own reveal (only
  refreshing after the *next* interaction started, or after
  `COMPLETE_SESSION`) could show a *prior* interaction's cached
  results under the *current* interaction's prompt. Fixed by
  invalidating `lastKnownSubmissions` whenever `interactionNumber`
  advances, in both harness files; the fix was reproduced and
  re-verified live before the slice was accepted.

## Current harness architecture

- `public/host.html` — host interface. Drives state transitions
  only (create, lock, start with a prompt-text input, close, reveal,
  complete); never submits. Shows room code prominently, a 6-step
  lifecycle stepper (now computed from the Session's and the current
  interaction's state combined — see `computeStepIndex()`), an
  "Interaction #N" label, participant list, current prompt, results
  (once revealed), and state-gated action buttons. `Start Interaction`
  is re-invocable: enabled again once the current interaction reaches
  `RESULT_REVEAL`.
- `public/participant.html` — participant interface. Joins, waits,
  submits/revises, views reveal; never controls session state. Shows
  the same combined stepper, friendly per-state waiting messages, the
  current interaction's prompt, a submission progress bar, and a
  reveal list with the participant's own response visually
  distinguished. Resets its "already submitted" note and draft
  response text whenever a new interaction begins (detected via
  `interactionNumber` changing).
- Both use `sessionStorage` (not `localStorage`) to persist
  host/participant credentials across a tab refresh — deliberately
  per-tab, not shared, so multiple tabs can stand in for multiple
  independent humans. This is a **developer-harness-only** mechanism;
  it does not solve real participant-identity recovery and both files
  display bearer tokens on screen in plaintext — acceptable only in
  this isolated, unbundled, dev-only context.
- Shared-code decision: evaluated introducing `harness-common.js`,
  rejected it — the divergent per-role rendering logic didn't
  justify the abstraction. Accepted small, independent duplication
  between the two files instead.
- The original single-page combined harness is preserved (not
  deleted) at `archive/play.v1.html` — it proved the first complete
  gameplay loop and the human playtest that found the migrations
  0013/0014 bugs, and is kept for historical reference. It is no
  longer served from `public/` and is not maintained.

## Deferred architectural questions (explicitly out of current MVP scope)

- **Three-layer identity distinction** (preserve as an architectural
  observation, not a task): (1) backend session identity
  (`participantToken`/`hostToken`), (2) client continuity
  (`sessionStorage`, dev-harness-only), (3) eventual real human
  identity (accounts, cross-device recovery). These must stay
  conceptually separate. Per the user's most recent explicit
  instruction: **do not** treat product-level identity recovery or a
  broader authentication system as the next implementation slice —
  there is not yet sufficient product evidence to justify permanent
  accounts or cross-device recovery.
- **"Last write wins" submission-revision policy** is an explicit MVP
  implementation decision, not a permanent gameplay rule — revisit
  only with product evidence.
- **Invalid/expired room-code handling** on `participant.html` is a
  real, still-unimplemented gap (no dedicated error state beyond the
  generic error banner). The multi-human playtest this was folded
  into (see `PLAYTEST_PROTOCOL.md` — now historical; the playtest ran
  and fed into the constitutional process that selected Slice 001,
  not this gap) has already happened; this specific gap was not the
  finding that was acted on. It remains open and unactioned — not
  currently scheduled, not currently forbidden.
- **Generalized Interaction Engine framework, Voting/Multiple Choice,
  Experience Templates, Shared Game State, Party Mode, Authentication,
  AI, Realtime sync, parallel interactions, interaction history/replay
  UI** — all explicitly out of scope for Slice 001; still open.

## Current phase — post-Slice-001 synchronization

Slice 001 is implemented, verified, and constitutionally accepted (see
"Repository state" above). The repository has just been brought back
into sync: implementation-facing documentation across the
constitutional repo (`Architecture/`, `Implementation/`) and this
software repo (this file, `README.md`, `PROJECT_STATUS.md`) has been
updated to reflect it, following the same process used for prior
slices (`33a9afe`).

No next implementation slice has been selected or authorized. Do not
propose or begin one without an explicit user instruction to do so —
if asked what's next, the established process is the same stress-test-
ranked Next Slice Selection used to choose Slice 001, not a unilateral
pick.
