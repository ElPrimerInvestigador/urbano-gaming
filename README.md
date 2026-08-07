# urbano-gaming — URBANO Gaming software repository

URBANO Gaming is a real-time, multi-round social game platform: a host runs a
session, participants join from their own phones, and the two roles
stay automatically synchronized through the whole game — no manual
refreshing, no shared screen required. It currently runs one
Interaction Engine (Multiple Choice trivia, plus a free-text Open
Response fallback) inside a Session model designed to run more engines
later without changing its core lifecycle.

```
CREATE_SESSION → JOIN_SESSION → LOCK_LOBBY →
[ START_SESSION (Multiple Choice from a prepared queue, or an
  ad-hoc Open Response prompt) → SUBMIT_RESPONSE (with revision) →
  CLOSE_SUBMISSIONS → REVEAL_RESULTS (auto-scores Multiple Choice) ] × N →
COMPLETE_SESSION
```

A completed Session may also produce a **successor Session** (a
same-participants rematch), and participants may independently leave
one Session and join an unrelated one — see "What's implemented" below
for the full picture. See governing documents (Account Intelligence,
CLAUDE.md, Project Genesis) for broader context; this README covers
only how to run what exists in this software repository.

The repository was historically named `level33-mvp`. That name remains valid only in historical implementation reports, old deployment evidence, and migration records. It is not the current product or repository identity.

## What's implemented

Six vertical slices, each adding one platform capability on top of the
last (full detail, including what evidence validated each and what
architectural risk remains open, is in `PLATFORM_CAPABILITY_REVIEW.md`):

1. **Sequential Interaction lifecycle** — a Session runs any number of
   interactions in sequence, each with its own independent state
   machine.
2. **Cross-engine scoring** — a session-scoped point ledger any engine
   can write to, automatically or via host discretion, producing one
   combined leaderboard regardless of which engine(s) ran.
3. **Multi-engine architecture** — Multiple Choice trivia as a second
   Interaction Engine alongside Open Response, proving the
   generic-instance-plus-extension-table pattern.
4. **Passive synchronization** — host and participant clients poll
   automatically; the "Check for updates" button is a manual recovery
   tool, not part of normal play.
5. **Session Continuity** — a host may create a linked successor
   Session (a rematch) from a completed one; still-connected
   participants get a "Join Next Session" prompt requiring their own
   explicit confirmation, never a silent transfer. Independently, a
   participant may leave any session and join a different one via
   "Join Another Session."
6. **Authoring Workspace** — a Create/Import/Review workflow for
   preparing Multiple Choice content before a session, replacing a
   one-at-a-time form that real hosts had outgrown; engine-agnostic at
   the workspace level so a future Interaction Engine can plug in its
   own editor without the workspace itself changing.

**UI Convergence, Tier 1** (Constitutional Layer) has also landed:
`host.html` and `participant.html` now use the URBANO Brandbook's
actual palette (charcoal/gold/ivory), typography (Montserrat), and mark
— see "Current UI state" below. **Tier 2** (the Experience Layer —
purple accent, reveal/celebration animation, and similar) is
deliberately **not** implemented yet; see `UI_CONVERGENCE_REVIEW.md`
and `UI_CONVERGENCE_IMPLEMENTATION_RECORD.md` for why and what happens
next.

## Prerequisites

- Node.js (v18+ recommended)
- A Supabase project (URL + service role key)

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy the environment template and fill in real values:
   ```
   cp .env.example .env.local
   ```

3. Apply every migration in `supabase/migrations/` to your Supabase
   project, in numerical order (via the Supabase SQL editor or the
   Supabase CLI). All of them are required — later migrations depend
   on tables and functions created by earlier ones. A few early
   migrations are forward-fixes for bugs found only against a live
   database (ambiguous-column-reference errors, and `RETURNS TABLE`
   shape changes `CREATE OR REPLACE` can't apply in place) — see each
   file's own header comment for specifics.

## Running tests

Primary suite — exhaustive behavioral coverage against an in-memory
repository double, no live database required:
```
npm test
```

Contract suite — proves the atomic Postgres functions behind every
command actually execute correctly against a real, live Supabase
database (requires `.env.local` to be populated and all migrations
applied):
```
npm run test:contract
```

Note: `npm test` runs an explicit file list in `package.json`, not a
glob — a newly added `__tests__/*.test.ts` file must be added to that
list by hand or it will silently not run under `npm test` (it still
runs fine under a plain `npx vitest run`). This has already caused one
test file to be missed; check `package.json`'s `test` script whenever
a new test file is added.

## Running the app locally

```
npm run dev
```

This serves the API routes under `/api/sessions/...` and two static
pages once `.env.local` is populated and all migrations have been
applied:

- `http://localhost:3000/host.html` — the host interface: create a
  session, author Multiple Choice content (or type an ad-hoc Open
  Response prompt), lock the lobby, run any number of interactions,
  award points, complete the session, and optionally create a rematch.
- `http://localhost:3000/participant.html` — the participant
  interface: join with a room code, answer whatever interaction is
  currently active, watch reveals and standings, and independently
  join a different session once done.

## Current UI state

Both pages implement the URBANO Brandbook's actual visual identity
(charcoal `#0A0A0A` / gold `#D4AF37` / ivory `#F5F1E8`, Montserrat, the
"U" mark) rather than a generic placeholder theme — see
`UI_CONVERGENCE_REVIEW.md` for the review that produced this and
`UI_CONVERGENCE_IMPLEMENTATION_RECORD.md` for exactly what changed.
Developer-only diagnostics (a passive-sync debug panel and a raw
last-response viewer) are hidden by default; append `?debug=1` to
either page's URL to see them. `host.html`'s "Session (dev info)" card
(raw `sessionId`/`hostToken`) is gated the same way.

Bearer tokens (`hostToken`, `participantToken`) are still held in
`sessionStorage`, not displayed on screen by default anymore, but the
underlying mechanism remains a development-appropriate one — there is
still no real cross-device credential recovery story. See
`HANDOFF.md`'s "Deferred architectural questions" for the standing
identity constraints this project operates under.
