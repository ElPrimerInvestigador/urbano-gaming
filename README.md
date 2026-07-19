# level33-mvp — CREATE_SESSION vertical slice

Implements the CREATE_SESSION command per the finalized Session Engine
architecture and Session Data Model. See governing documents (Account
Intelligence, CLAUDE.md, Project Genesis) for full context — this README
covers only how to run what exists.

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

3. Apply the migration to your Supabase project:
   - Open the Supabase SQL editor (or use the Supabase CLI)
   - Run `supabase/migrations/0001_create_sessions.sql`

## Running tests

Primary suite (vitest — requires `npm install` to have succeeded):
```
npm test
```

Fallback validation harness (no external test framework dependency,
uses Node's built-in test runner against the same source files):
```
npm run test:manual
```

## Running the app locally

```
npm run dev
```

`POST /api/sessions` will create a session once `.env.local` is populated
and the migration has been applied.

## Scope note

This package contains only the CREATE_SESSION vertical slice: session
creation, room code and host token generation, and the event log write.
JOIN_SESSION, lobby presence, prompts, and all later commands are out of
scope and are not implemented here.
