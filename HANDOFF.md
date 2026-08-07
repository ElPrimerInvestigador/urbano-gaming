# Handoff — URBANO Gaming

Prepared for a fresh Claude conversation continuing this work. Read
this before taking any action; it summarizes state established across
prior sessions so it doesn't need to be rediscovered.

## Repository state

- Branch: `integrate/join-session`, pushed to `origin/main` as a clean
  fast-forward after every accepted slice — never a force-push.
- Latest committed slice: `2675067` — "feat: add Authoring Workspace
  for Multiple Choice content" (Slice 006).
- **Currently uncommitted**: UI Convergence, Tier 1 (the Constitutional
  Layer — Brandbook palette, typography, mark, mobile viewport,
  debug-surface gating) is implemented and verified but held
  uncommitted pending a repository synchronization pass and a final
  constitutional consistency check. See `UI_CONVERGENCE_IMPLEMENTATION_RECORD.md`.
- Slices 001 and 002 are **constitutionally accepted**, with full
  history at `Level 33/History/Slices/Slice_001/` and `.../Slice_002/`.
  Slices 003–006 are implemented, tested, and live-verified in
  production, but have **not** been through that formal ceremony, and
  **do not have** `History/Slices/` folders yet. This is a deliberate,
  explicit deferral (governance artifact, not implementation artifact)
  — do not reconstruct them without explicit user instruction.
- Implementation record files use two naming conventions:
  `SLICE_00N_IMPLEMENTATION_RECORD.md` (002–004) and descriptive names
  (`SESSION_CONTINUITY_IMPLEMENTATION_RECORD.md`,
  `AUTHORING_WORKSPACE_IMPLEMENTATION_RECORD.md` for 005–006, which
  were never assigned slice numbers in conversation). This
  inconsistency is known and **explicitly deferred** — it will be
  addressed as part of a later implementation-history normalization,
  not fixed incidentally. Do not rename these historical files without
  explicit instruction.
- `SLICE_003_IMPLEMENTATION_RECORD.md` is a known, byte-for-byte
  duplicate of Section 1 of `SLICE_003_REVIEW_PACKAGE.md` (both added
  in the same commit, never diverged). Flagged, not yet resolved —
  the standalone file is the one matching every other slice's naming
  convention.

## Implemented capabilities (Slices 001–006)

Full detail — problem solved, validating evidence, what future
Interaction Engines inherit for free, and what architectural risk
remains open for each — is in `PLATFORM_CAPABILITY_REVIEW.md`. Summary:

1. **Sequential Interaction lifecycle** (Slice 001) — a Session runs
   any number of interactions in sequence; each owns its own
   PROMPT_ACTIVE/SUBMISSIONS_CLOSED/RESULT_REVEAL state independent of
   the Session's own LOBBY_OPEN/LOBBY_LOCKED/SESSION_COMPLETE state.
2. **Cross-engine scoring** (Slice 002) — a session-scoped
   `point_awards` ledger, written to automatically (Multiple Choice's
   own reveal) or by host discretion (Open Response), producing one
   standings list regardless of which engine(s) ran.
3. **Multi-engine architecture** (Slice 003) — Multiple Choice trivia
   as a second Interaction Engine (`engine_type` + an extension table,
   `multiple_choice_details`), validating — for two structurally
   *similar* engines — the generic-instance-plus-extension pattern and
   the transactional reveal-and-score pattern.
4. **Passive synchronization** (Slice 004) — `sessionSync.js`, a
   shared, session-agnostic polling capability (`start/stop/pause/
   resume/refreshNow`) consumed identically by host and participant.
   "Check for updates" is now a manual recovery tool, not part of
   normal play.
5. **Session Continuity** (Slice 005) — `sessions.predecessor_session_id`
   lets a host create a linked successor session (a rematch);
   still-connected participants discover it through the same passive
   poll and must explicitly confirm joining — never a silent transfer.
   Independently, `participant.html` supports leaving any session and
   joining an unrelated one.
6. **Authoring Workspace** (Slice 006) — Create/Import/Review content
   authoring for Multiple Choice, with `ITEM_EDITORS[engineType]` as
   the one seam a future engine would extend; the workspace itself
   never references a Multiple-Choice-specific field.

Current gameplay lifecycle end to end:

```
CREATE_SESSION → JOIN_SESSION → LOCK_LOBBY →
[ START_SESSION (Multiple Choice from a prepared queue, or an
  ad-hoc Open Response prompt) → SUBMIT_RESPONSE (with revision) →
  CLOSE_SUBMISSIONS → REVEAL_RESULTS (auto-scores Multiple Choice) ] × N →
COMPLETE_SESSION [ → CREATE_SUCCESSOR_SESSION (rematch) ]
```

Architecture per command: transport-agnostic domain function
(`lib/session/*.ts`) → `SessionRepository` interface → two
implementations (`InMemorySessionRepository` test double,
`SupabaseSessionRepository` production) → thin Next.js API route
(`app/api/sessions/...`). Atomicity is enforced in Postgres via
`SELECT ... FOR UPDATE` row-locking RPC functions
(`supabase/migrations/`, currently through `0029`), with domain-typed
errors translated from named Postgres exceptions.

## Current product rules (still explicit MVP decisions, not permanent)

- "Last write wins" on a resubmitted response — revisit only with
  product evidence.
- No persistent participant or host identity across sessions, by
  design — see "Deferred architectural questions" below. This is the
  single constraint most likely to matter for any future capability
  involving content reuse or returning players.
- A completed session may have at most one direct successor
  (write-once, enforced by a database constraint) — a chain, not a
  tree. Deliberate, matches the accepted Session Continuity design.
- `points_for_correct` remains a raw per-award number, not a real
  "scoring rule" concept — explicitly named across two slice records
  as a stand-in for an Experience Template that does not yet exist as
  software. See `PLATFORM_CAPABILITY_REVIEW.md`'s Experience
  Composition candidate.

## Validation status

- **In-memory behavioral suite**: 192 tests across 12 files under
  plain `vitest run`; `npm test` currently runs only 181 of these,
  because `package.json`'s `test` script is an explicit file list that
  was never updated to include `createSuccessorSession.test.ts`. Known,
  unresolved, low-priority — flagged again here so it isn't lost.
- **Live Supabase contract suite** (`npm run test:contract`): proves
  every atomic Postgres RPC function against a real database.
- `npx tsc --noEmit` and `npm run build`: clean as of the latest
  commit and as of the uncommitted Tier 1 work.
- **Production playtests**: a real multi-game playtest with real
  participants validated Slices through 005 end to end (passive sync,
  Multiple Choice trivia, automatic and manual scoring, rematches,
  independent rejoining, multiple consecutive games). Slice 006 was
  separately verified in production via direct API/browser
  verification plus a dedicated first-time-host UX walkthrough that
  found and fixed two real defects before commit (a silently
  pre-selected "correct" answer default, and a save-confirmation
  message being wiped by the next automatic sync tick).

## Current UI architecture

`public/host.html` and `public/participant.html` are no longer a
generic-styled engineering harness — as of the uncommitted UI
Convergence Tier 1 work, both implement the URBANO Brandbook's actual
visual identity: charcoal (`#0A0A0A`) / gold (`#D4AF37`) / ivory
(`#F5F1E8`), Montserrat, and the real "U" mark (`public/urbano-mark.svg`).
Primary buttons are deliberately ivory-filled, not gold-filled — gold
stays a rare accent (room code, standings, winner banner), matching
the Brandbook's own restraint discipline rather than a mechanical
color substitution. Full reasoning and the roadmap this came from are
in `UI_CONVERGENCE_REVIEW.md`; exactly what was implemented and
verified is in `UI_CONVERGENCE_IMPLEMENTATION_RECORD.md`.

**Two layers, deliberately kept separate — operationally, not just
conceptually:**

- **Constitutional Layer** (Tier 1, implemented): direct application
  of already-ratified Brandbook rules. Not provisional.
- **Experience Layer** (Tier 2, **not started**): a purple accent for
  gameplay moments, reveal/celebration animation, dimming, glow, and
  eventually sound/haptics. Explicitly treated as a set of individual,
  falsifiable hypotheses (hypothesis / expected emotional outcome /
  implementation / validation criteria / playtest observations / final
  decision each), not brand decisions — the purple accent specifically
  is confirmed as an *experiment*, not a Brandbook amendment, per
  explicit user instruction. **Does not begin until Tier 1 is
  validated by a real playtest** — protecting the evidence by
  protecting the sequence was an explicit, deliberate choice, not an
  arbitrary gate.

Developer-only diagnostics (the passive-sync debug panel, the raw
last-response viewer, and — host-only — the raw `sessionId`/
`hostToken` display) are hidden by default in both files; append
`?debug=1` to see them. The underlying mechanisms are fully intact —
only default visibility changed.

`sessionStorage` (not `localStorage`) still holds host/participant
credentials per-tab; this remains a development-appropriate mechanism,
not a real cross-device identity story — see below.

## Deferred architectural questions (explicitly out of current scope)

- **No persistent identity across sessions.** Reaffirmed at every
  slice since 001. There is still no operational evidence (no host has
  asked to be remembered, no participant has asked for cross-session
  continuity) justifying accounts or cross-device recovery. **Do not**
  treat this as the next capability without new evidence — this
  guidance has held for six slices and should keep holding until
  something concrete changes it.
- **`History/Slices/` reconstruction for Slices 003–006.** Explicitly
  deferred — a governance/constitutional-acceptance exercise, not an
  implementation-synchronization one. Do not begin it without explicit
  instruction.
- **Implementation record naming inconsistency** (numbered vs.
  descriptive filenames) and the **`SLICE_003_IMPLEMENTATION_RECORD.md`
  duplicate**. Both flagged, neither resolved — deferred to a future
  architectural exercise explicitly covering the Level 33 → URBANO
  Gaming repository transition. Do not rename or delete anything here
  without explicit instruction.
- **UI Convergence Tier 2** (the Experience Layer). Not started. Does
  not begin until Tier 1 is validated by a real playtest.
- **Experience Composition** — a real, named "Experience" concept
  composing multiple Interaction Engines with a shared scoring/
  sequencing model, recommended in `PLATFORM_CAPABILITY_REVIEW.md` as
  the highest-leverage next major capability, to be built alongside one
  genuinely different third Interaction Engine rather than another
  engine shaped like the existing two. **This is a recommendation, not
  an authorization.** The user explicitly paused to do UI Convergence
  first; do not begin Experience Composition work without an explicit
  instruction to do so.
- **Reusable Content Library** (content that outlives a single
  session) — named by the user as "part of the product roadmap," not
  yet designed or scheduled.
- **Operational/observability tooling** and **persistent identity** —
  both named as real but currently unevidenced in
  `PLATFORM_CAPABILITY_REVIEW.md`; watch for triggering evidence rather
  than building preemptively.

## Current phase

Repository synchronization is in progress: this file, `README.md`,
and `PROJECT_STATUS.md` have just been brought up to date through
Slice 006 and UI Convergence Tier 1, and `UI_CONVERGENCE_REVIEW.md` /
`PLATFORM_CAPABILITY_REVIEW.md` are being written into the repository
as architectural documents rather than remaining chat-only. After this
synchronization completes, a final constitutional consistency review
of the Tier 1 implementation against the Brandbook happens, then Tier
1 is committed, pushed, and deployed.

No next implementation slice is authorized. If asked what's next, the
established process is the same stress-test-ranked Next Slice
Selection used for every prior slice — informed by, but not
automatically deciding in favor of, `PLATFORM_CAPABILITY_REVIEW.md`'s
recommendation.
