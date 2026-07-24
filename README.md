# level33-mvp — Level 33 session/game engine

Implements the full first-playable Level 33 session lifecycle:
`CREATE_SESSION → JOIN_SESSION → LOCK_LOBBY → START_SESSION →
SUBMIT_RESPONSE (with revision) → CLOSE_SUBMISSIONS → REVEAL_RESULTS →
COMPLETE_SESSION`. See governing documents (Account Intelligence,
CLAUDE.md, Project Genesis) for full context — this README covers only
how to run what exists.

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
   on tables and functions created by earlier ones, and two
   (`0013`, `0014`) are forward-fixes for bugs found in earlier ones.

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

## Running the app locally

```
npm run dev
```

This serves the API routes under `/api/sessions/...` and two static
developer harness pages once `.env.local` is populated and all
migrations have been applied:

- `http://localhost:3000/host.html` — host interface: create a
  session, drive it through the lifecycle, reveal and complete it.
- `http://localhost:3000/participant.html` — participant interface:
  join with the displayed room code, wait, submit/revise a response,
  view the reveal.

Both are developer validation tools, not a production UI — see the
inline comments in each file for their intended scope and
limitations (e.g. bearer tokens are shown on screen and persisted in
`sessionStorage`, which is acceptable only in this isolated, dev-only
context).
