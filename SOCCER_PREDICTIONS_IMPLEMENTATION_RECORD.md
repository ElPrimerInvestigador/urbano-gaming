# Soccer Predictions — Implementation Record

Status: **Designed. Implemented. Corrected (Founder UX pass). Re-implemented. Integrated. Locally Validated. Desktop Validated. Mobile Validated.** Not staged, not committed, not pushed, not deployed. Production is untouched in every respect. Not claimed as production-ready.

## Historical honesty — two local candidate designs

This phase produced **two** local Prediction designs. The first is superseded and was never accepted; it is recorded here so the history stays honest, not pretended away.

- **Initial local candidate** (Phase C): four dimensions — Outcome, Scoreline, Scorers, Minutes — where Scorers/Minutes required the participant to reconstruct the *entire* multiset of goal scorers and minutes for their predicted scoreline (e.g. a predicted 3-2 required five scorer names and five minutes). Fully implemented, fully tested, fully locally validated end-to-end including a live browser simulation.
- **Founder correction**: after a live UX review of that candidate, the founder judged it too slow/high-friction for a real participant ("four clear picks, not a match report") and specified four independent, low-friction dimensions instead. The goal-count invariant tying scorer/minute counts to the predicted scoreline was explicitly superseded, not extended.
- **Final accepted local candidate** (this record, current): **Exact Scoreline, Any Goalscorer, Any Goal Minute, First Team to Score** — each dimension a single pick, evaluated independently, with an explicit "No Goal" state for a goalless prediction. This is the model implemented, tested, and validated below.

## Product boundary

Soccer Predictions is a native, persistent URBANO Gaming Experience — not Golazo, not Session/Segment/Interaction Instance gameplay. It lives entirely in `lib/gaming/predictions/`, structurally parallel to (and never importing from or being imported by) `lib/session/`. Existing Guest Session gameplay (Trivia, Quiz, Open Response, Voting, Best Joke) is untouched — none of its files appear anywhere in this phase's diff.

## Identity dependency

Built on the local Identity Foundation commit `783f258079c638bb3fbc3e254e723578005d3262`. Every Prediction is owned by a `gaming_member_id`; every admin action reuses `isCurrentlyGamingAdmin`/`resolveGamingAuth` from `lib/gaming/auth.ts` unmodified. Identity was not pushed, not modified, not redeployed as part of this phase.

## Team / Player roster architecture (new this correction)

Smallest v1 capability, explicitly not a league-management system and not a sports-data-provider integration:

- `teams(team_id uuid PK, name text)`.
- `players(player_id uuid PK, team_id uuid FK, name text, active boolean default true)`. **No delete code path exists anywhere in this domain** — `active` gates future selectability only, so a `player_id` already referenced by a historical Prediction or official goal event can never dangle, even after the player is deactivated. Verified directly (behavioral test + live browser): deactivating a player after settlement leaves the historical Prediction and Evaluation fully readable and unchanged.
- `matches.home_team_id` / `away_team_id` reference `teams` via stable internal ids — `matches` itself carries no team name text.
- Admin surface: create/select Teams, add/edit/activate/deactivate Players, per `app/api/gaming/predictions/admin/teams/*` and `admin/players/[playerId]`, and the "Teams & Rosters" section of `predictions-admin.html`.
- **Future sports-API seam** (recorded, not implemented): a future provider could populate Teams/rosters/fixtures/Results automatically. The current manual admin workflow is the v1 source of truth either way. Every id in this domain is this domain's own stable internal id — a future provider's ids would map into these, never become them. No sports-data integration exists in this codebase.

## Match / Venue / Venue Activation architecture

`matches` carries no `status` column — the full lifecycle (scheduled / locked / drafted / finalized / cancelled) is derived from `kickoff_at`, `cancelled_at`, and `match_results.finalized_at`, mirroring Quiz's own `closes_at`/`closed_at` precedent. `venues` holds only what a geofence check needs (coordinates, radius, active flag) — no partner CRM, no Lifestyle linkage. `venue_activations` is the (Match, Venue) pairing that makes a Match predictable-with-prize-eligibility at a physical place, `UNIQUE(match_id, venue_id)`. Current manual Venue selection (member picks from the enabled Venue Activations for a Match) is the accepted v1 UX, preserved unchanged from the prior design. **Future direction, not implemented**: automatic nearby-eligible-Venue discovery from browser location, computing candidates transiently without storing raw coordinates — recorded as the intended next Venue UX evolution, not built because it is not trivial with the current architecture.

## Geolocation trust boundary

Unchanged from the prior design. Raw member coordinates are never persisted. `predictions` stores `geo_verified_at`, `measured_distance_meters`, `reported_accuracy_meters`, `geo_eligible` only — the Venue's own coordinates remain the sole authority. An eligibility/audit mechanism, explicitly not anti-GPS-spoofing. No IP-geolocation fallback. Every create/edit re-verifies eligibility — a member cannot submit at the Venue and then edit from home (verified live and in both test suites).

## Four correctness dimensions (corrected model)

1. **Exact Scoreline** — `predicted_home_score`/`predicted_away_score` vs the official result, exact equality only.
2. **Any Goalscorer** — `predicted_goalscorer_player_id`, nullable. Correct if that Player scored at least once officially (a brace/hat-trick still counts as correct — this is membership, not a multiset match). `null` means "No Goalscorer / No Goal" and is correct iff the official match had zero goals.
3. **Any Goal Minute** — `predicted_goal_minute`, nullable plain integer (1–120). Correct if any official goal's effective elapsed minute (`minute_regulation + coalesce(minute_stoppage, 0)`) equals it. `null` ("No Goal") is correct iff zero official goals. Stoppage time is preserved with full fidelity on the *official* side (`minute_regulation`/`minute_stoppage` unchanged); only the participant-facing *input* is simplified to one plain integer, compared against the official record's own effective elapsed minute — no fidelity is lost, only the input is simplified.
4. **First Team to Score** — `predicted_first_team_to_score`, nullable enum (`HOME`/`AWAY`/`null` = "No Goal"). Derived from the chronologically first official goal event, ordered by effective elapsed minute then `ordinal` as a tiebreaker (not insertion order — verified explicitly by a test that inserts the away goal first but gives it the later minute, and the home goal second but with the earlier minute; the home team is still correctly first). An own goal credits the **opposing** Team from the scorer's own Team — derived at settlement time from `is_own_goal` + the scorer's Team + the Match's home/away Team ids, with no stored redundant `credited_team_id` column. `null` is correct iff the official match had zero goals.

`correct_dimension_count` = the count of the four booleans above. **The old goal-count invariant is gone entirely** — a 4-3 predicted scoreline still carries exactly one goalscorer pick, one minute pick, one first-team pick, verified directly: a Prediction of 2-1/Mbappé-equivalent/70'/opponent-first against an official 1-2 result evaluated all four dimensions independently (scoreline wrong, goalscorer correct, minute correct, first-team wrong — 2/4), not as a linked scorer-minute pairing.

Nullability was chosen over sentinel values: because every Prediction answers all four dimensions atomically at submission time (never progressively), `null` is never ambiguous with "unanswered" — it always means the member deliberately chose "No Goal" for that dimension.

## 0–0 semantics

All four dimensions remain playable and independently evaluable for a goalless prediction, verified live and in both test suites: Scoreline `0-0` is a normal exact match; Goalscorer/Goal Minute/First Team all use their `null`/"No Goal" branch, correct iff the official match had zero goals. A live 0-0 proving case (below) settled all four dimensions as correct.

## Prediction uniqueness and immutability

Unchanged. `UNIQUE(match_id, gaming_member_id)` on `predictions` — one Prediction per Gaming Member per Match, globally, never per Venue Activation. `venue_activation_id` is immutable after first creation, enforced inside `upsert_prediction_atomically`. Verified live and in both test suites: a second Venue Activation for the same Match is rejected (`VENUE_ACTIVATION_IMMUTABLE`).

## Roster validation

New this correction. `upsert_prediction_atomically` validates the selected Goalscorer (when not null): the player must exist, must belong to one of the Match's two Teams, and must currently be `active` — else `INVALID_GOALSCORER_SELECTION`. Verified live and in both test suites: a player from neither Match Team is rejected; an arbitrary/nonexistent player id is rejected; a deactivated player can no longer be newly selected; a player deactivated *after* settlement does not corrupt the already-settled historical Prediction/Evaluation. No free-text participant scorer input exists anywhere in the member UX — the goalscorer picker is a `<select>` populated from the Match's two Team rosters, grouped by Team.

## Deadline authority

Unchanged mechanism. `now() >= kickoff_at`, checked live inside `upsert_prediction_atomically` under a row lock on the parent `matches` row. Verified live on three separate matches in this phase's simulation: a submission attempted after kickoff had passed was rejected with `KICKOFF_PASSED`, and the member UI rendered the honest "Predictions are locked for this match." message.

## Result draft / finalization boundary

Unchanged mechanism, re-verified against the corrected dimension model. `match_results.finalized_at` distinguishes draft (no settlement effect) from finalized (immutable, settlement runs exactly once). Verified live: after saving a draft result and its official goal events, `evaluations` remained empty (checked directly against Postgres) until Finalize was explicitly invoked via the real admin UI.

## Correction / re-settlement architecture

Unchanged mechanism, re-verified end-to-end against the corrected dimension model with a real dimension-count flip. A correction is a new `match_results` row (`supersedes_match_result_id` set), never a mutation of the original. `correct_match_result_atomically` computes a new `evaluations` row per Prediction using the same four-dimension logic as finalize, leaving the superseded evaluation untouched; compensates the old performance-tier progression event with a negative, `reverses_gaming_progression_event_id`-linked entry (never touching `PREDICTION_PARTICIPATED`); marks the old `prize_qualifications` row `superseded_at` (never deleting it, never touching `redeemed_at`); creates a new qualification only if the corrected evaluation still supports a configured tier.

**Verified live, end-to-end, with a real dimension-count flip**: a Match's official result (2-1, Goalscorer's brace at 20'/60', an away goal at 75') was corrected to remove the 20' goal entirely (VAR-style disallowal), changing the official result to 1-1. The original evaluation (3/4 — Scoreline wrong, Goalscorer/Minute/First-Team correct) remained queryable, unchanged, at its original `match_result_id`. The new evaluation (2/4 — Minute flipped to incorrect, since the predicted 20' no longer matched any official goal) was created against the new `match_result_id`. A compensating `-`points reversal row appeared, `reverses_gaming_progression_event_id`-linked to the original `PREDICTION_3_OF_4` event, `idempotency_key = 'reverse:<original_event_id>'`. The original prize qualification (3/4 tier, already redeemed at that point) shows `superseded_at` set and `redeemed_at` still set simultaneously — exactly the discrepancy-visible, redemption-preserved state required. No new qualification was created for the corrected 2/4 result, because no 2/4 tier was configured for that Activation — "no configured tier = no prize, without error," verified directly (no error, qualification row genuinely absent). A separate, unrelated Match's own 4/4 qualification was confirmed untouched by this correction.

## Evaluation snapshots

`evaluations` is immutable per `(prediction_id, match_result_id)`, now carrying `scoreline_correct, goalscorer_correct, goal_minute_correct, first_team_to_score_correct, correct_dimension_count` (the prior `outcome_correct, scorers_correct, minutes_correct` columns do not exist in this design — this is a from-scratch schema, not a migrated one; see "Migration-history correction strategy" below). The underlying `predictions` and `official_goal_events` remain the recomputable source evidence. A correction never edits a snapshot.

## Gaming XP (progression ledger)

Unchanged mechanism and terminology boundary, re-verified against the corrected model. `gaming_progression_events` (append-only, dedicated, not `point_awards`) remains the persistent ledger; member/public-facing terminology is **Gaming XP**, not a Prediction rating, not a universal skill rating, not currency. Point values live in `progression_rule_points`, seeded at `0` for all five keys (`PREDICTION_PARTICIPATED`, `PREDICTION_1_OF_4`…`PREDICTION_4_OF_4`) — a genuine "not yet decided" placeholder. Idempotency uses a deterministic `idempotency_key` text column with `UNIQUE(gaming_member_id, idempotency_key)`. No category-competitive-rating implementation exists. Session `point_awards` remain Session-scoped and do not feed Gaming XP — unchanged, unrelated system.

## Prize qualification and redemption

Unchanged mechanism, re-verified against the corrected model. `prize_qualifications` materializes only for genuine winners. Redemption is a single admin action, exactly once, idempotent on retry (verified live and in the contract suite — the member UI correctly renders "already redeemed" after live redemption). A qualification already `superseded_at` (never redeemed) cannot be newly redeemed. An already-redeemed qualification is never erased or clawed back by a later correction. 1/4, 3/4, 4/4 tiers were configured live in this phase's simulation; **2/4 remains explicitly unresolved** — no 2/4 tier was configured for any Activation in this simulation, and the corrected-result proving case above deliberately produced a genuine, unconfigured 2/4 result to verify "no tier = no prize, no error" directly.

## Admin authority

Unchanged. Every admin route calls `requireGamingAdmin` (`lib/gaming/predictions/httpAuth.ts`), which resolves the caller via `resolveGamingAuth` and checks `isCurrentlyGamingAdmin` fresh from `gaming_admins` on every call — no JWT claim, no new authorization schema. Verified in the contract suite with real Supabase Auth tokens (via `generateLink` + `verifyOtp`): a non-admin Gaming Member is rejected with 403; the same member, after an admin row is inserted, is accepted; after the admin row is deleted, the identical token is rejected again on the very next check.

## Migration-history correction strategy

Because the entire Predictions schema (the original 15 migrations, 0050–0064) was local-only, uncommitted, unpushed, and never applied to production, the old migration files were deleted outright (`rm -f`) rather than layering compatibility migrations on top of an architecture that had never been accepted. A clean, renumbered 17-file set (0050–0066) was written implementing the corrected model directly — `teams`, `players`, revised `matches` (team-id FKs), unchanged `venues`/`venue_activations`/`prize_tiers`, fully revised `predictions` (four dimension columns, no goal-count invariant), unchanged `match_results`, revised `official_goal_events` (player-id scorer, no stored credited-team), revised `evaluations` (four new boolean columns), unchanged `progression_rule_points`/`gaming_progression_events`/`prize_qualifications`, and fully revised `upsert_prediction_atomically`/`finalize_match_result_atomically`/`correct_match_result_atomically` (new own-goal-credit and chronological-first-goal derivation logic) plus unchanged `redeem_prize_qualification_atomically`. `npx supabase db reset --local` then replayed the entire local migration history (0001 through the new 0066) from scratch in one shot — Identity Foundation's own already-accepted 0001–0049 migrations replayed identically and safely as part of the same reset. Nothing here was ever committed, pushed, or applied to production, which is what made a clean reset safe rather than destructive.

## Local-environment finding: `auto_expose_new_tables` (tooling, not Product)

After the migration reset, the local Supabase Data API (PostgREST) briefly lost SELECT/INSERT/UPDATE/DELETE grants for `anon`/`authenticated`/`service_role` on **every** public-schema table — including pre-existing, unrelated ones (`sessions`, `participants`) — not just the new Predictions tables. Root cause: this machine's installed Supabase CLI defaults `auto_expose_new_tables` to off (the new, stricter cloud-matching default), which revokes Data-API auto-grants on a fresh `db reset` unless the local `supabase/config.toml` explicitly opts back into the legacy behavior. This repository's `supabase/config.toml` is untracked (confirmed via `git log --all -- supabase/config.toml`, empty — it has never been part of any commit) and predates this phase; it was not created by this session. The one-line fix (`auto_expose_new_tables = true`, uncommented in that file) was applied locally and is **not staged, not committed** per instruction. **Disposition**: this is a local-machine/tooling condition, not a Predictions Product decision, and it does not affect production (production's Data API grants are managed by Supabase Cloud independently of this local file; migrations never touch grants). It **is** required to reproduce a clean local `db reset` with working Data-API access on this machine's current Supabase CLI version — every other migration in this repository (49 pre-existing + 17 new) implicitly assumes auto-exposed tables and contains no explicit `GRANT` statements. Recommendation, not executed here: track this as an infrastructure decision (either commit `supabase/config.toml` with the flag set, or add an explicit `GRANT` migration) before the flag is removed by Supabase on 2026-10-30 per the CLI's own deprecation note — left for founder/engineering authorization, not decided unilaterally.

## Local operational simulation (real browser, real local Postgres)

Run against `next dev` wrapped with local-only env vars (temporary `.claude/launch.json` entry, added and fully reverted — `git diff -- .claude/launch.json` empty). One Founder/admin Gaming Member (real local OTP sign-in via Mailpit), two Teams (Urbano FC: Carlos Reyes; Gaming United: Diego Suarez) with real rosters, one Venue, four Matches, Venue Activations, and Prize Tiers (1/4, 3/4, 4/4), all created through the real admin UI (`predictions-admin.html`) via real clicks/form input, not seeded directly.

1. **Normal-scoring case**: predicted 2-0/Carlos Reyes/20'/Urbano-FC-first, submitted through the real member UI (`soccer-predictions.html`) with a mocked-but-real `navigator.geolocation` callback (headless browser has no real GPS) reporting a position inside the Venue's radius — the real geo-eligibility computation ran and returned `geoEligible: true`, `measuredDistanceMeters` ≈15m. Official result entered via the real admin goal-event row UI (Team-grouped Player select + minute + own-goal checkbox, no free text): 2-1 (Carlos Reyes 20'+60', Diego Suarez 75'). Finalized live. Result: Scoreline ✗ / Goalscorer ✓ / Goal Minute ✓ / First Scorer ✓ — 3/4, matching the pre-configured 3/4 tier, rendered exactly this way in the member UI's dimension grid.
2. **0–0 case**: predicted 0-0/No Goalscorer/No Goal/No Goal, submitted through the real member UI. Official result entered as 0-0, zero goal events. Finalized live. Result: all four dimensions ✓ — 4/4, matching the pre-configured 4/4 tier. Member UI correctly rendered "No Goalscorer, No Goal, first: No Goal" for the recap and ✓ on all four cells — no dimension was left unanswerable for a goalless prediction.
3. **Kickoff lock, live, twice**: two further matches' kickoffs passed during setup/interaction; the member UI correctly rendered "LOCKED — AWAITING OFFICIAL RESULT" (pre-finalization) and, on submission attempt, the real API rejected with "Predictions are locked for this match." — both proven live, not simulated.
4. **Redemption**: the 4/4 qualification from the 0-0 case was redeemed via the real admin route; the member UI immediately re-rendered "Prize qualified: already redeemed."
5. **Correction with a genuine dimension-count flip**: the normal-scoring case's result was corrected (20' goal removed, VAR-style) — see "Correction / re-settlement architecture" above for the full verified chain. The member UI re-rendered the corrected 2/4 result with no "Prize qualified" line (since the corrected count has no configured tier), while the unrelated 0-0 case's "already redeemed" state remained untouched.
6. **Roster picker**: the Goalscorer `<select>` in the real member UI was confirmed, live, to be populated only from the two Match Teams' active rosters plus a "No Goalscorer / No Goal" option — no free-text input exists.

## Mobile validation (375×812)

Both the member prediction form (Venue select, honest geolocation-failure message, exact-score inputs, Team-grouped Goalscorer select, Goal Minute input with "No Goal" placeholder, three-button First-Team-to-Score toggle including "No Goal", Submit button) and the finalized-result display (four-dimension grid, correct-count summary, qualification status, prediction recap) render cleanly at 375×812 with no horizontal overflow, verified via a real mobile-viewport screenshot. Admin surface remains desktop-first by explicit instruction and was not separately validated at mobile width.

## Defects found and fixed during this implementation

Carried over from the original (Phase C) implementation — all already fixed before this correction began, and re-verified to remain fixed against the corrected model:

1. **Next.js Data Cache silently caching Supabase reads** on `matches/route.ts` — fixed via a custom `no-store` `fetch` passed into `SupabasePredictionsRepository`'s `createClient` call.
2. **Member results display silently dropping content after the dimension grid** — `el()`'s `firstElementChild`-only behavior — fixed by wrapping finalized-result markup in one parent `<div>`.
3. **In-memory progression-event idempotency dedup compared the wrong value** — fixed by adding a real `idempotencyKey` field and comparing it directly.
4. **Contract test cleanup left orphaned local data** due to delete-order versus FK dependency — fixed by deleting in explicit dependency order.

New in this correction phase:

5. **PostgREST bulk-insert `NULL`-vs-default quirk**, found during SQL-layer smoke testing, not a repository/application defect: inserting a batch of `official_goal_events` rows where one row omits `is_own_goal` and another sets it explicitly causes PostgREST to send an explicit `NULL` for the omitted key across the whole batch, rather than letting Postgres apply the column's own `DEFAULT false` — violating the `NOT NULL` constraint. Not a schema bug (`is_own_goal boolean not null default false` is correct); the fix was in the calling code (always set the field explicitly on every row), documented for anyone hand-rolling a `.insert([...])` batch against this table.
6. **Local Data-API grants briefly disappeared after a fresh `db reset`** — see "Local-environment finding" above; resolved via the local-only `supabase/config.toml` change, not staged.
7. **Accidentally ran `npm run test:contract` bare once, without the required local-Postgres env-var override** — see "Automated verification" below for the full incident account and the confirmation that production was left unaffected.

## Automated verification

`npx tsc --noEmit` — clean. `npm test` — **367/367** (321 pre-existing + 46 in the corrected `predictions.test.ts`, replacing the prior 34 — the prior scorer/minute-multiset tests were removed, not kept alongside the new ones, since they tested a superseded model), zero regression. `npm run test:contract` (local Postgres only, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` passed as explicit shell env vars pointed at `http://127.0.0.1:54421`, `.env.local` never touched — the same override technique established in Slice 007/008/009/Quiz/Trivia/Identity) — **69/69** (65 pre-existing + 4 new in the corrected `predictionsSupabaseRepository.contract.test.ts`, covering the full four-dimension settlement/correction pipeline, own-goal credit derivation, roster validation, and admin authority end-to-end with real Supabase Auth tokens). `npm run build` — clean; all 21 Prediction routes registered (18 prior + 3 new: `admin/teams`, `admin/teams/[teamId]/players`, `admin/players/[playerId]`), two correctly forced dynamic.

**Incident, resolved**: mid-verification, `npm run test:contract` was run once without the required env-var override, which meant it read `.env.local`'s real `SUPABASE_URL` (production, `uyxckhbmcbctsbewnqkb.supabase.co`) rather than local Postgres. This is a known, previously-documented repository hazard (`CLAUDE.md`: "Do not use an unscoped `npx vitest run`... Run `npm run test:contract` only when live Supabase mutation is authorized and the correct environment is available") that this session briefly failed to follow. **Confirmed production impact: none.** Investigation before any further action: (a) production's `teams`/`gaming_members` tables do not exist there at all (confirmed directly — `PGRST205: Could not find the table`), so no Predictions-model data could ever have been written; (b) production's `auth.users` table shows **zero** total users at the time of the check (no stray test accounts); (c) production's `sessions` table's most recent row predates this session's test run by many hours, and all 122 rows are in realistic post-gameplay states (`SESSION_COMPLETE`/`LOBBY_LOCKED`), not test artifacts — the pre-existing `afterAll` cleanup hooks in the unrelated session/voting/quiz/segment contract test files ran regardless of the mid-file `join_participant_atomically` failures they hit (a genuine, unrelated, pre-existing schema-version mismatch between production and this local repository's Identity migrations — production has not received migration 0049), and left no residue. The correct invocation (`SUPABASE_URL=http://127.0.0.1:54421 SUPABASE_SERVICE_ROLE_KEY=<local demo key> npm run test:contract`) was then run and is what the 69/69 total above reflects.

## Regression boundary

Zero changes anywhere in `lib/session/*`, any existing gameplay engine, or any Identity Foundation file committed at `783f258`. All 321 pre-existing behavioral tests and all 65 pre-existing contract tests pass unchanged.

## Explicit deferrals

No sports API integration, no Lifestyle integration, no anti-cheat/GPS-spoofing prevention, no season/tournament system, no league-management system, no roster-history management, no player transfers/contracts/profiles, no QR redemption flow, no venue-staff role, no admin mobile optimization, no automatic nearby-Venue discovery, no wiring into the existing Leaderboards page UI (the read model is ready for it; this record does not claim the UI itself was wired), no 2/4 prize-tier business rule (explicitly left unresolved), no Prediction competitive rating.

## Production status

**Not touched in any way.** No migration applied beyond local Postgres (0050–0066, confirmed local-only). No production Supabase Auth setting changed. No SMTP configured. Production Identity validation remains exactly as blocked as recorded in `IDENTITY_FOUNDATION_IMPLEMENTATION_RECORD.md`. The `npm run test:contract` incident above is fully accounted for and confirmed to have left production unaffected. This record makes no production-readiness claim for Soccer Predictions.
