# Global Gaming XP Leaderboard — Implementation Record

Local-only. Not staged, not committed, not pushed, per explicit founder instruction. This record documents the first canonical Global Gaming XP Leaderboard — a read-only projection of the Persistent Metagame ledger (Phase 1, `0085`–`0092`) — authorized against `Product/Persistent_Metagame_Architecture.md`'s "Global Leaderboard vs. Category Leaderboards" section and the two readiness/reconciliation gates that preceded this implementation.

## Starting state

Local repository: branch `integrate/join-session`, HEAD `36d5fb784ef0480ff32b5afd9d0b952b346c1b47` (the Phase 1 production documentation-closure commit), local and production migration ceiling `0092`. No Global leaderboard implementation existed anywhere in the repository; the only leaderboard code was `lib/gaming/predictions/leaderboard.ts`, already confirmed (Product/ADR authority, and the prior readiness gate) to be a Predictions-specific, pre-Phase-1 read model, not canonical.

## Architecture implemented

A single new read-only PostgreSQL function, `get_global_gaming_xp_leaderboard()` (migration `0093`), is the canonical source of truth. It:

- sources only `gaming_xp_events`, joined to `gaming_members` for `display_name` only;
- computes `SUM(points) GROUP BY gaming_member_id`, with `HAVING SUM(points) > 0`;
- ranks with `RANK() OVER (ORDER BY total_xp DESC)` — competition ranking, ties share a rank;
- orders its final output by `total_xp DESC, gaming_member_id ASC` — the `gaming_member_id` secondary key is used only for deterministic tied-row print order and never appears in the function's own `RETURNS TABLE` shape.

## Why database-side aggregation was required

The initial readiness report recommended fetching all `gaming_xp_events` rows via `supabase-js` and aggregating in TypeScript. The reconciliation gate reopened this and proved it wrong empirically, not by reasoning alone: `supabase/config.toml` configures PostgREST's `max_rows = 1000`. Directly against local Postgres (fixture created and cleaned up in the same script — one auth user, one Gaming Member, one Experience Summary, one XP rule, 1500 real `gaming_xp_events` rows, all for one member, 1 point each):

```
Inserted 1500 gaming_xp_events rows. True total should be 1500.
[PLAIN .select(), no count/range option] rows returned: 1000
[PLAIN .select()] naive SUM of returned rows: 1000 (TRUE total is 1500)
[PLAIN .select()] SILENTLY WRONG: true
```

A plain unpaginated `.select()` silently truncates with no error. A separate probe (a disposable local-only SQL function returning `generate_series(1,1500)`, created and dropped directly against local Postgres) confirmed the same cap also applies to an RPC function's own *output* rows — so the safety of `get_global_gaming_xp_leaderboard()` does not come from "RPC calls are exempt" (they are not); it comes from Postgres aggregating the *complete* underlying `gaming_xp_events` table internally (no cap applies inside the database engine, only at the PostgREST response-serialization layer) and returning one row per **distinct Gaming Member with positive Global XP**, not one row per event — a materially slower-growing quantity than raw event count.

## Public projection

`{ rank, displayName, globalXp }` only. `gaming_member_id`/UUID, `auth_user_id`, email, XP-event history, `category_key`, `source_reference`, `evidence`, activity dates, and venue history are never returned — confirmed both by a behavioral test asserting the exact key set of a returned entry and by direct inspection of the live JSON response during the operational simulation.

## Tie/rank semantics

Confirmed live end-to-end (operational simulation, real local Postgres, real running Next.js server, real HTTP response): two members with identical XP (100 each) both show `rank: 1`; the next distinct member (80 XP) shows `rank: 3`, never `rank: 2` — proving competition ranking, not dense ranking, is what's actually returned, not merely what was intended.

## Net-zero exclusion

Founder-confirmed Product decision, implemented via `HAVING SUM(points) > 0`: a member whose full XP history nets to exactly zero (an award fully reversed, with no reissue) is **absent** from the leaderboard entirely — never shown at `0`. Confirmed in the behavioral suite, the real-Postgres contract suite, and live in the operational simulation (a fixture member with `+50` then a full `-50` reversal never appeared in the rendered UI or the raw API response).

A genuinely **negative** net total was determined to be structurally unconstructible and is documented as such (test H) rather than faked: `gaming_xp_events`' own schema constraint (`points >= 0 OR reverses_gaming_xp_event_id IS NOT NULL`) combined with this ledger's reversal-issuance code always inserting exactly `-original.points` means no member's ledger can ever sum below zero — there is no punitive/negative-only consequence class anywhere in this architecture.

## Reversal semantics

No row-type filtering of any kind — a reversal is always the exact negation of the award it reverses, so a plain `SUM(points)` over every row (original, reversal, and any reissue) already nets correctly. Proven with the exact worked example from both readiness gates, `+100` original → `-100` reversal → `+40` corrected reissue → **effective Global XP = 40**, both in-memory and against real local Postgres (contract test), and live in the operational simulation's rendered UI (`OpSim-Reissued`, `40`).

## Legacy Predictions leaderboard disposition

Retained unchanged in behavior and URL. Its doc comments and its route's doc comment were corrected — it now explicitly states it is Predictions-specific, pre-Persistent-Metagame, reads the legacy `gaming_progression_events` ledger (which receives no new writes since Phase 1), and is **not** the canonical Global Gaming XP Leaderboard, matching `Persistent_Metagame_Architecture.md`'s and ADR-035's own language almost verbatim. No functional change, no route rename — nothing was found depending on its current path or wording.

## Tests

**Behavioral** (`__tests__/persistentMetagame.test.ts`, 12 new tests, 41 total in that file): empty ledger; one member; multiple members with correct descending totals; competition ties (100/100/80 → 1/1/3); deterministic tied-row ordering stable across repeated calls, with the secondary key never affecting the tied rank itself; the exact `+100/-100/+40 = 40` reversal/reissue arithmetic; full-reversal net-zero exclusion; the structural-impossibility-of-net-negative documentation case; no `gamingMemberId`/private field in the returned shape; source-level boundary assertions (never queries `gaming_progression_events`/`point_awards`, never imports Predictions runtime state); the route's `GET` handler takes zero parameters, structurally incapable of inspecting any header including `Authorization`; per-event category attribution retained even though the Global aggregate crosses categories.

**Contract** (`__tests__/persistentMetagameSupabaseRepository.contract.test.ts`, 2 new tests, 10 total in that file, real local Postgres): a combined tie/reversal/net-zero-exclusion/no-UUID-in-output proving case against the real `get_global_gaming_xp_leaderboard()` RPC; and the load-bearing >1000-row proving case — 1500 real `gaming_xp_events` rows for one member, first demonstrating a raw `.select()` over just that member's own rows already silently truncates below 1500, then proving `repo.getGlobalLeaderboard()` — the actual repository implementation under test, not a bypass — still returns the correct, complete total of exactly 1500.

## Operational simulation

Run against a real local Next.js dev server (`next dev -p 3011`, started with explicit local-Postgres environment overrides — never `.env.local`, which points at production) and real local Postgres:

1. Empty ledger → `GET /api/gaming/leaderboard` returned `{"entries":[]}`, HTTP 200 — confirmed before seeding anything.
2. Seeded 5 real Gaming Members (real `auth.users` rows via the Admin API, real `gaming_members` rows) with real XP events: two tied at 100, one at 80, one fully reversed to net 0, one reversed-then-reissued to net 40.
3. Verified the raw JSON response directly: `Alex 100 (rank 1), Jordan 100 (rank 1), Sam 80 (rank 3), Reissued 40 (rank 4)` — the fully-reversed member correctly absent.
4. Tie confirmed: both `rank: 1` rows present simultaneously.
5. Reversal confirmed: the fully-reversed member never appears.
6. Reissue confirmed: the reversed-then-reissued member appears once, at its corrected total (40), not its original (100) and not duplicated.
7. Raw response body contained exactly `rank`/`displayName`/`globalXp` per entry — verified directly, no other keys.
8. Desktop screenshot: existing URBANO Gaming shell fully preserved, `Global` tab renders a real ranked table, `By Game` tab confirmed untouched (still its original static placeholder).
9. Mobile screenshot at 375×812: table renders cleanly, no horizontal overflow, no layout regression.
10. Unauthenticated access confirmed throughout — every request above, including the seed script's own reads, used no `Authorization` header on the `GET /api/gaming/leaderboard` calls themselves.

All fixture data (5 Gaming Members, their `auth.users` rows, `experience_summaries`, `gaming_xp_rules`, `gaming_xp_events`) was created and verified entirely against **local** Postgres, then removed by the closing full `supabase db reset --local`. No Product XP rule, participation allowance, or cap value was activated to make this simulation interesting — every award used disposable, clearly-labeled `OPSIM`-prefixed test fixtures.

## Deviations from the accepted architecture

None. The one deliberate addition beyond the reconciliation report's own explicit scope is `InMemoryMetagameRepository.registerGamingMemberDisplayName()` — a small, synchronous test/fixture seam (matching this file's own existing `createCategoryParticipationPolicy`/`createGamingXpRule` seam convention) needed because `MetagameRepository` correctly has no independent visibility into Gaming Member identity data (`gaming_members` belongs to `lib/gaming/db`); the real Postgres implementation needs no such seam, since it `JOIN`s `gaming_members` directly inside the SQL function itself.

## Explicit non-goals (confirmed absent from this diff)

By Game / Category leaderboards; My Circles / friends leaderboards; filters; seasons; pagination; leaderboard snapshots or caching; a materialized view; a category-eligibility/governance registry table (the existing `gaming_xp_rules` configuration boundary already serves this role — see the reconciliation report); any new table, column, or index beyond the one read-only function; any Product XP value, daily participation allowance value, category rating algorithm, Achievement, geography, booster, Gaming Plus, or store/currency concept; any change to `gaming_category_participation_policy`/`gaming_xp_rules` row counts (both remain empty in this environment's own fixture-free baseline, confirmed by the closing full reset); any SMTP/Auth configuration change.

## Production boundary

Not touched. `supabase db push --linked` was never run; `git push` was never run; no Vercel deploy was triggered; no production row was inserted, read for anything beyond the pre-existing read-only migration-ceiling check, or otherwise mutated. Production migration ceiling independently reconfirmed at `0092` (unchanged) via `supabase migration list --linked` after this implementation's local work completed. `origin/main` independently reconfirmed unchanged at `2e3cf2f`.

## Local automated totals

`npx tsc --noEmit` — clean. `npm test` — **464/464** (452 pre-existing + 12 new in `persistentMetagame.test.ts`). `npm run test:contract` (target explicitly printed and confirmed `http://127.0.0.1:54421` before every run) — **88/88** (86 pre-existing + 2 new in `persistentMetagameSupabaseRepository.contract.test.ts`, including the >1000-row proving case against real Postgres); one transient "invalid response from upstream server" failure appeared on an unrelated, pre-existing `supabaseSessionRepository.contract.test.ts` test on one run immediately following a fresh `db reset --local` (Docker cold-start), reproduced clean on an immediate full rerun against the already-warm stack — the same documented, non-blocking flakiness class recorded in the Phase 1 and Phase 1 correction implementation records, not touched by this diff. `npm run build` — clean, both new routes (`/api/gaming/leaderboard` and the corrected `/api/gaming/predictions/leaderboard`) present in the build manifest. `git diff --check` — clean. A full `supabase db reset --local` (all 93 migrations, from scratch) completed with zero errors, three times across this implementation.

## Final acceptance gate — independent re-verification (2026-08-21)

Before staging/commit, a separate acceptance pass re-verified the above from scratch rather than trusting this record: migration `0093` re-read directly against the required semantics line by line (exact match, no discrepancy); the three classic failure cases (`+100/-100/+40 = 40`, `+100/-100` → excluded, `100/100/80` → ranks `1/1/3`) independently re-proven via raw SQL directly against local Postgres (`docker exec ... psql`, transactions rolled back, no TypeScript involved at all) as a genuinely different verification method from the test suite; every domain/repository/API/UI file re-read directly to confirm the delegation-to-RPC boundary, the privacy projection, and the untouched "By Game"/"My Circles" placeholders; the full verification suite re-run fresh (`npx tsc --noEmit`, `npm test`, a full local reset, `npm run test:contract`, `npm run build`, `git diff --check`) with the load-bearing >1000-row test and the tie/reversal/net-zero/privacy test both re-run a second time in isolation; and a second, independent operational sanity pass run end-to-end (empty → seeded → tie → reissue → reversed-member-absent → desktop → mobile → unauthenticated) against a freshly-reset local database on a different port, reaching the same result as the original implementation turn's simulation. Nothing required correction as a result of this pass.

## Recommendation

**ACCEPT_LOCAL_IMPLEMENTATION.** Every required gate passes; the one load-bearing correctness risk identified in the reconciliation gate (silent PostgREST truncation) is proven both to be real (an unmitigated application-side approach would have been wrong) and to be fully closed by the selected architecture (proven against a real >1000-row local Postgres ledger, not merely reasoned about, and reconfirmed independently in the final acceptance gate above). No production, migration, deployment, Auth, SMTP, or Product-value boundary was crossed. **This record documents local implementation and acceptance only — production has not been accepted, targeted, or scheduled by this record; that remains a separate, later, explicitly-authorized gate**, consistent with every prior phase of this engagement.
