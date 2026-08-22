# Soccer Predictions v2 — Bounded Correction Implementation Record

Local implementation and local acceptance only. No production migration was applied, no production data was mutated, no Product XP values or participation allowances were configured, and no Category Rating/Achievements/other feature work was begun. This record documents what changed and why; it does not claim production deployment.

## 1. Why v2 exists — the defect in precise terms

Migration `0056` introduced `predictions.predicted_goal_minute integer`, a single flattened field intended to represent "which minute a goal happens in," compared against `official_goal_events` by summing that table's own `(minute_regulation, minute_stoppage)` pair into one integer. That migration's own comment claimed the flattening lost no ambiguity — only the "which period" distinction.

That claim is false for first-half stoppage time specifically. `45 + 10 = 55`, which is the same sum as the ordinary second-half minute `55`. A member predicting the true event — a goal at first-half stoppage minute 10 — and a member predicting an unrelated ordinary-minute-55 goal were indistinguishable to the settlement logic; both compared equal to an official event recorded as `(45, 10)`. The claim happens to hold for second-half stoppage (`90 + N` never collides with any legal ordinary minute, since ordinary minutes cap at 90), which is likely why the error went unnoticed, but it does not hold in general, and it is silently wrong exactly where it matters most: stoppage time is precisely when late goals cluster.

This is not a hypothetical. Migration `0094`'s own goal-time redesign and the test suite added in this Slice reproduce the exact collision: a first-half-stoppage goal at `(45, 10)` does **not** satisfy a prediction of ordinary minute `55`, despite both summing to `55` under the old scheme.

## 2. Canonical Goal-Time representation (0094)

`predictions.predicted_goal_minute` is replaced with:

- `predicted_goal_minute_regulation integer null`
- `predicted_goal_minute_stoppage integer null`

mirroring `official_goal_events.minute_regulation` / `minute_stoppage` — the same shape members are being asked to predict against, not a parallel format members must mentally translate.

Enforced by three CHECK constraints:

| Constraint | Rule |
|---|---|
| `predictions_goal_minute_regulation_range` | `regulation` is null, or `1 <= regulation <= 90` |
| `predictions_goal_minute_stoppage_positive` | `stoppage` is null, or `stoppage > 0` |
| `predictions_goal_minute_stoppage_requires_boundary` | `stoppage is null or (regulation is not null and regulation in (45, 90))` |

The third constraint is written with an explicit `regulation is not null` guard rather than relying on `regulation in (45, 90)` alone, because `NULL IN (45, 90)` evaluates to `NULL`, not `FALSE` — a naive version of this constraint would silently accept `(regulation: null, stoppage: 5)`, a nonsensical state. This was caught during authoring, not after a test failure.

`(null, null)` remains legal and means **No Goal**, unchanged in meaning from v1.

**No maximum stoppage offset is enforced.** No Product authority has specified a ceiling, so none was invented. `(90, 50)` is a legal Prediction under this schema.

**`official_goal_events` is deliberately untouched.** It already carried `(minute_regulation, minute_stoppage)` correctly, already supports `minute_regulation` values above 90 for extra time, and that extra-time representational capability is preserved — this Slice does not remove the ability to record what actually happened in a match that went to extra time. What changes is only how *Predictions* are compared against that existing official record, via the regulation-time eligibility rule below. No competing representation was created on the official side.

The displayed minute (`46'`, `45+1'`, `90+6'`) is derived at render time from `(regulation, stoppage)` by one shared formatting helper (`formatGoalMinute` in `public/soccer-predictions.html`) — it is never a second persisted source of truth.

## 2a. Canonical official-goal timestamp audit (acceptance-gate finding, closed)

Before local acceptance, the authoritative official-result side (`official_goal_events`, its result-entry validation, the admin API/domain logic, the admin UI, and the test suite) was independently audited for the same class of defect §2 fixed on the Prediction side: could a semantically-invalid `(minute_regulation, minute_stoppage)` tuple — a stoppage offset attached to a minute that is not itself a period boundary, e.g. `(46, 1)`, `(55, 3)`, `(70, 2)` — be persisted as authoritative evidence?

**Finding: yes.** `official_goal_events`' own two original constraints (0058) — `minute_regulation between 1 and 120` and `minute_stoppage is null or > 0` — constrain each field independently but never their relationship. Every canonical write path (`SupabasePredictionsRepository.saveDraftMatchResult`'s plain `.insert()`, the in-memory mirror, `adminCatalog.ts`'s `saveDraftResult`/`startResultCorrection`, the `POST /api/gaming/predictions/admin/matches/[matchId]/result` route, and the admin UI's raw number inputs) passed such a tuple through with zero rejection anywhere. This is not cosmetic: because 0098/0099's Goal Minute comparison is structural (`regulation` equality AND `stoppage IS NOT DISTINCT FROM`), an official event mis-recorded as `(46, 1)` would silently fail to match a Prediction correctly naming ordinary minute 46 (`stoppage: null`) — a data-entry slip masquerading as a wrong Prediction. Classified per the gate's own decision rule as "canonical application paths can genuinely author invalid official tuples" — a bounded Predictions-v2 correctness defect, fixed before commit, not deferred.

**Fix — smallest correct solution, three layers:**

1. **New migration `0100_official_goal_events_stoppage_boundary.sql`** (0058 is already production-applied at ceiling 0093, so it was not edited): adds `official_goal_events_minute_stoppage_requires_boundary`, `check (minute_stoppage is null or minute_regulation in (45, 90, 105, 120))`. `minute_regulation` is already `not null` on this table, so — unlike 0094's equivalent constraint on the nullable Predictions side — no extra `is not null` guard is needed to dodge the `NULL IN (...)` gotcha.
2. **New `InvalidOfficialGoalMinuteError`** (`lib/gaming/predictions/types.ts`), mapped to HTTP 400 in `statusForPredictionsError`.
3. **A single shared TypeScript guard**, `validateOfficialGoalEvents`, added to `lib/gaming/predictions/adminCatalog.ts` and called from both `saveDraftResult` and `startResultCorrection` — the one place both repository backends and both entry paths (first-time draft, correction) already converge, since (unlike Predictions' own `upsert_prediction_atomically` RPC, directly callable by any authenticated Gaming Member's own client) official goal events have no direct-RPC exposure: `adminCatalog.ts` is already the sole write path, so one non-duplicated check here is sufficient — no repository-level duplication was added.

The widened legal-boundary set for official evidence — `{45, 90, 105, 120}` rather than Predictions' own `{45, 90}` — is deliberate, not an oversight: official evidence must retain the ability to record genuine extra-time stoppage (`105+N`, `120+N`) operationally. **This does not change Predictions-v2 settlement scope in any way** — the regulation-time eligibility predicate (§3) still reads only `minute_regulation between 1 and 90`; a `(105, 2)` event remains fully excluded from all four Prediction dimensions, exactly as before. No stoppage-offset ceiling was introduced, matching every other stoppage constraint in this schema.

**Also corrected while auditing this exact class of error:** `InvalidGoalMinuteError`'s own message was stale, left over from v1's `predicted_goal_minute integer` field (which shared `official_goal_events`' 1–120 range) — it still claimed "must be between 1 and 120" after v2 narrowed the Predictions side to 1–90 with the 45/90-boundary rule. Corrected to state the actual v2 rule.

**Verification:** 4 new behavioral tests (in-memory, both entry paths, plus proof that all four legal boundary minutes — including extra-time 105/120 — remain writable, and that a null-stoppage extra-time event is unaffected) and 2 new real-Postgres contract tests (one proving the live 0100 constraint rejects `(46, 1)` by asserting the Postgres error message names the constraint itself, not merely "something threw" — an initial version of this test used an invalid `enteredByGamingMemberId` string and passed for the wrong reason, a UUID-syntax error unrelated to 0100, caught and corrected before this record was written; one proving all four boundary minutes are accepted end-to-end against real Postgres).

## 3. Regulation-time eligibility — one predicate, applied everywhere

`predictions-v2` settles regulation time only. Extra time and penalty shootouts are explicitly out of scope for the four Prediction dimensions (see §7 for the one dimension where this scope boundary is not yet fully closed).

The eligibility predicate is exactly:

```
official_goal_events.minute_regulation BETWEEN 1 AND 90
```

This correctly includes first-half stoppage (`minute_regulation = 45`, any `minute_stoppage`) and second-half stoppage (`minute_regulation = 90`, any `minute_stoppage`), and correctly excludes extra time (`minute_regulation` 91–120, however an Official Event operator chooses to record it).

The predicate is applied identically to all four reads of official goal evidence, in both SQL functions and the TypeScript in-memory mirror:

1. Total regulation-time goal count (drives the No-Goal / No-Goalscorer / No-Team derivation for Goal Minute, Goalscorer, and First Team to Score).
2. Any Goalscorer's existence check.
3. Any Goal Minute's existence check.
4. First Team to Score's chronologically-first-goal derivation.

Implemented as a single named TypeScript helper (`regulationTimeEligibleGoalEvents` in `lib/gaming/predictions/db/inMemoryPredictionsRepository.ts`) and as the same inline filter repeated at each of the four call sites in both `finalize_match_result_atomically` (0098) and `correct_match_result_atomically` (0099), so a future reader can verify by inspection that no read of official goal evidence was missed.

## 4. Dimension settlement semantics (all four)

| Dimension | Scope | Own goal | Comparison |
|---|---|---|---|
| Exact Scoreline | Whole-match score fields (`home_score`, `away_score`) — **not** filtered by regulation-time eligibility; unchanged from v1 | N/A | Numeric equality |
| Any Goalscorer | Regulation-time eligible goals only | **Excluded** — an own goal never satisfies a Goalscorer prediction naming that player | Player-id equality against a non-own-goal eligible event |
| Any Goal Minute | Regulation-time eligible goals only | **Included** — an own goal at a matching minute does satisfy a Goal Minute prediction | Structural: `official.minute_regulation = predicted.regulation AND official.minute_stoppage IS NOT DISTINCT FROM predicted.stoppage` |
| First Team to Score | Regulation-time eligible goals only; credits the team that actually benefits (own goals credit the *opponent*) | Credits the opposing/receiving side | Team of the chronologically-first eligible goal |

The Goal Minute comparison is the load-bearing change of this Slice: it is **never** a summed/flattened integer comparison. In SQL (0098, 0099):

```sql
official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
  and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
```

`is not distinct from` (rather than `=`) is required because both sides are nullable — ordinary time predictions/events have `minute_stoppage = null`, and ordinary SQL `NULL = NULL` is `NULL`, not `TRUE`. In TypeScript (`inMemoryPredictionsRepository.ts`):

```ts
e.minuteRegulation === prediction.predictedGoalMinuteRegulation &&
  (e.minuteStoppage ?? null) === (prediction.predictedGoalMinuteStoppage ?? null)
```

**Exact Scoreline is intentionally unchanged and remains regulation/extra-time-scope-agnostic** — see §7.

## 5. Cancelled/abandoned Match settlement prohibition

No new Match-status state was introduced. The existing `matches.cancelled_at` (nullable timestamp, already present) is sufficient: `cancelMatch()` has no timing precondition and behaves identically whether called before kickoff or after a draft Result already exists, which is exactly the "cancelled before kickoff" and "abandoned mid-play" cases the Founder asked to be covered by one field.

`finalize_match_result_atomically` and `correct_match_result_atomically` (both SQL, 0098/0099, and the TypeScript mirror) now raise `MATCH_CANCELLED` — reusing the exact error string already used by `upsert_prediction_atomically` for the same condition, not a new error code — the moment they resolve the Match and find `cancelled_at is not null`, before any other write.

**TypeScript-specific correctness note:** in SQL, any exception raised later in the same function rolls back the entire enclosing transaction, including writes made earlier in that same call — exact guard placement is a "fail fast" nicety there, not a correctness requirement. The `InMemoryPredictionsRepository`'s `Map.set()` writes are **not** automatically rolled back on a later `throw`. The cancelled-Match guard is therefore placed explicitly before any `this.matchResults.set(...)` mutation in both `finalizeMatchResult` and `correctMatchResult` — not merely "somewhere before the function returns." This was identified and corrected during authoring, before it could manifest as a bug.

A cancelled Match therefore produces zero Evaluation rows, zero Experience Summary rows, zero XP events, and zero Prize Qualification rows for any attempted finalize/correct — proven directly (§10, §13).

## 6. Dimension fact contract — `correct_dimension_count` / `correct_dimension_keys[]`

Added to the shared, Experience-agnostic `experience_summaries` table (migration 0095):

- `correct_dimension_count integer null`
- `correct_dimension_keys text[] null`

The table-level CHECK constraint (`experience_summaries_dimension_count_matches_keys`) enforces **only** the universal cardinality/nullability invariant: both null together, or both non-null with `count = cardinality(keys)`. It deliberately does **not** enforce:

- the Predictions-specific band-key string format (`CORRECT_<n>_OF_4`),
- which four strings are legal members of `correct_dimension_keys`,
- or a fixed key order.

Enforcing any of those at the shared table level would make the generic, cross-Experience Metagame table implicitly Predictions-specific — precisely the coupling ADR-035 exists to prevent, and precisely the mistake this Slice was authorized to avoid repeating. Those three invariants are Predictions-adapter invariants instead, enforced by construction (the band key and the key array are both derived from the same four booleans, in the same code path, in both the SQL functions and the TypeScript mirror) and locked in by tests (§10), not by a shared-table constraint.

The fixed canonical key order is:

```
EXACT_SCORELINE, ANY_GOALSCORER, ANY_GOAL_MINUTE, FIRST_TEAM_TO_SCORE
```

implemented as a `DIMENSION_KEY_ORDER` static array in TypeScript and as explicit sequential `if` statements in SQL — never derived from evaluation order or insertion order. A live proving case (§13) demonstrates that a 2-of-4 mask with the *second* and *third* dimensions true still produces `["EXACT_SCORELINE", "ANY_GOAL_MINUTE"]` in that fixed order.

`record_experience_summary_atomically` (0097) accepts these as two new, trailing, nullable, `default null` parameters, passed straight through to the insert — no additional validation beyond the table's own CHECK constraint, because this function is intentionally Experience-agnostic and must not know what a "dimension" is.

## 7. `predictions-v2` and the Exact Scoreline gap (explicitly not solved)

`ruleset_version` for every new Evaluation/Summary produced by `finalize_match_result_atomically` / `correct_match_result_atomically` is now the literal `'predictions-v2'`, replacing `'predictions-v1'`. Historical v1-era rows are untouched and keep their original `ruleset_version` — this record does not retroactively claim v1 ever behaved this way.

**Explicitly preserved, not solved:** Exact Scoreline compares `match_results.home_score`/`away_score` directly, with no regulation-vs-extra-time provenance at all. If a Founder-authorized future Match Result schema distinguishes a regulation-time score from a full-time (including ET/shootout) score, Exact Scoreline would need to pick one explicitly; today there is only one score pair, and nothing in this schema records whether it includes extra time. This gap was identified in the prior audit gates as a genuine open question requiring a real schema decision, not a settlement-logic bug — it is called out here again so it is not lost, and no test in this Slice claims the regulation-vs-extra-time distinction is structurally testable for Exact Scoreline, because it is not: the score fields carry no such provenance to test against.

## 8. The corrections proving case — live, not merely unit-tested

Proven three independent times: an in-memory behavioral test, a real-Postgres contract-style flow (via structural comparison assertions), and a full live browser/API operational simulation (§13). The scenario:

1. A Prediction is submitted for ordinary ballpark minute `46` (i.e. `regulation: 46, stoppage: null`).
2. Result Version 1 is finalized with the official goal recorded (mis-recorded, in the live simulation) as the same ordinary minute `46`. Goal Minute is correct.
3. Result Version 2 corrects the official goal to its true value, `(regulation: 45, stoppage: 1)` — the Prediction is **not** resubmitted; it remains ordinary `46`.
4. Goal Minute is now incorrect.

Verified in every proving run:

- Evaluation 1 is preserved exactly, byte-for-byte, never mutated or deleted.
- Evaluation 2 is a genuinely new row, with a different `evaluation_id`, referencing the correction's own `match_result_id`.
- Experience Summary 2 supersedes Summary 1 (`supersedes_experience_summary_id` set correctly) with a **different** `correct_dimension_keys[]` (Summary 1 contains `ANY_GOAL_MINUTE`; Summary 2 does not).
- With zero Gaming XP configuration in effect, zero XP events exist before or after the correction — no fabricated award, no fabricated reversal.
- `getCurrentEvaluationForPrediction` / the member-facing recap reflects Version 2 after the correction, not Version 1.

## 9. Migrations (0094–0100)

All seven are new files; **no migration `0001`–`0093` was edited**. Every SQL function replacement follows this codebase's existing `drop function if exists ...; create function ...` precedent as a new migration, never an in-place edit of a production-applied file.

| Migration | Change |
|---|---|
| `0094_predictions_v2_goal_time_representation.sql` | Drops `predicted_goal_minute`; adds the `(regulation, stoppage)` pair and its three CHECK constraints on `predictions` |
| `0095_experience_summaries_dimension_facts.sql` | Adds `correct_dimension_count`/`correct_dimension_keys[]` and the universal cardinality CHECK on `experience_summaries` |
| `0096_upsert_prediction_atomically_goal_time_v2.sql` | Drop/recreate of `upsert_prediction_atomically`: new parameter shape, three new `INVALID_GOAL_MINUTE` validation raises; every other check (kickoff lock, venue activation, geo, roster validation) unchanged from `0084` |
| `0097_record_experience_summary_atomically_dimension_facts.sql` | Drop/recreate of `record_experience_summary_atomically`: two new trailing nullable parameters, passed straight through |
| `0098_finalize_match_result_atomically_predictions_v2.sql` | Drop/recreate of `finalize_match_result_atomically`: cancelled-Match guard, regulation-time eligibility filtering on all four official-evidence reads, own-goal exclusion for Goalscorer, structural Goal Minute comparison, dimension-key construction, `ruleset_version` bump |
| `0099_correct_match_result_atomically_predictions_v2.sql` | The same set of changes applied to the independently-inlined correction-path copy of the same evaluation logic |
| `0100_official_goal_events_stoppage_boundary.sql` | Adds the `official_goal_events_minute_stoppage_requires_boundary` CHECK constraint (§2a) — the acceptance-gate canonical-timestamp-audit fix |

All seven applied cleanly to local Postgres via `supabase db reset --local`, from a completely fresh reset, with zero SQL errors, both during initial implementation and again during final regression (§11).

## 10. Tests

**Behavioral (in-memory), `npm test`: 494/494 passing across 23 files** (up from 466 before this Slice; +28 new tests — 24 from the initial implementation, +4 from the acceptance-gate timestamp-audit fix, §2a).

`__tests__/predictions.test.ts` (+14 tests):
- Goal-Time validation: ordinary 1–90 accepted; `(null, null)` accepted as No Goal; regulation-null-with-stoppage rejected; stoppage-at-non-45/90-base rejected; zero/negative stoppage rejected; regulation > 90 rejected; no artificial stoppage ceiling (a `+50` offset at minute 90 accepted).
- Own goal rules: an own goal does not satisfy Any Goalscorer for the scoring player; the same own goal does satisfy a matching Any Goal Minute prediction.
- Regulation-time boundary: an extra-time goal (`minuteRegulation: 101`) does not satisfy Goalscorer/Goal-Minute/First-Team and does not break a scoreless-regulation No-Goal/No-Goalscorer/No-Team prediction; a prediction naming the extra-time scorer/minute exactly is still not satisfied by it.
- Cancelled/abandoned Match: cancelled before kickoff blocks finalize; cancelled with a draft Result already present still blocks finalize; a correction attempt after cancellation is blocked; zero Evaluation/XP rows result.
- The three stoppage-specific tests rewritten in place of the one v1 test whose own meaning was now factually wrong (see prior turn's summary).

`__tests__/persistentMetagame.test.ts` (+10 tests):
- Dimension fact contract: all four single-dimension-correct cases, plus representative 0/4, 2/4 (proving fixed key order independent of which two dimensions are true), 3/4, and 4/4 masks; `correct_dimension_count === correct_dimension_keys.length` invariant; `performance_band_key` suffix agreement.
- The explicit corrections proving case (§8), run against the real `InMemoryPredictionsRepository`/`InMemoryMetagameRepository` pair.

**Contract (real local Postgres), `npm run test:contract` (env-overridden to local): 96/96 passing across 9 files** (up from 88 before this Slice; +8 new tests — 6 from the initial implementation, +2 from the acceptance-gate timestamp-audit fix, §2a), including a fresh full run after a from-scratch `supabase db reset --local`:

`__tests__/predictionsSupabaseRepository.contract.test.ts` (+4 tests): an invalid Goal-Time shape rejected by the real CHECK constraint; the structural `46` vs `(45, stoppage 1)` distinction proven against real Postgres with two independent Predictions; own-goal Goalscorer-exclusion/Goal-Minute-inclusion against real Postgres; a cancelled Match blocking finalize against real Postgres with zero resulting Evaluation rows.

`__tests__/persistentMetagameSupabaseRepository.contract.test.ts` (+2 tests): `correct_dimension_count`/`correct_dimension_keys` round-trip through the real `record_experience_summary_atomically` RPC and table; the real `0095` CHECK constraint rejects a cardinality-inconsistent `(count, keys)` pair supplied directly to the RPC.

`__tests__/predictions.test.ts` (+4 tests, acceptance-gate §2a fix): a non-boundary official stoppage tuple `(46, 1)` rejected on first-time draft entry and on a correction; all four legal period-boundary tuples — including extra-time `(105, 1)` and `(120, 3)` — accepted; a null-stoppage extra-time event (`minuteRegulation: 101`) unaffected.

`__tests__/predictionsSupabaseRepository.contract.test.ts` (+2 tests, acceptance-gate §2a fix): the real `0100` CHECK constraint rejects `(46, 1)` — asserted by matching the constraint's own name in the thrown Postgres error, not merely "something threw"; all four legal boundary tuples accepted end-to-end against real Postgres.

No test claims the Exact Scoreline regulation-vs-extra-time distinction is structurally testable (§7) — none was written to pretend otherwise.

## 11. Final regression (this turn, in order; re-run again after the §2a fix)

1. `npx tsc --noEmit` — clean.
2. `npm test` — **494/494** passing, 23 files.
3. `npx supabase db reset --local` — fresh reset, migrations `0001`–`0100` applied in order, zero SQL errors.
4. `npm run test:contract`, explicitly targeted at local Postgres via a shell env override of `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` (target printed before the run; verified resolved to `http://127.0.0.1:...`, never `.env.local`'s production URL) — **96/96** passing, 9 files.
5. `npm run build` — clean, no errors.
6. `git diff --check` — clean, no whitespace errors.
7. Independent isolated re-runs (vitest `-t` filters, not merely the full-suite pass above): first-half stoppage collision test, own-goal settlement tests, cancelled-settlement tests, the 46→45+1 correction/supersession test, the Summary dimension-fact contract test, the structural Goal Minute real-Postgres contract test, and all six new §2a timestamp-validity tests (behavioral and contract) — all pass in isolation.

## 12. Operational simulation (live, local Postgres, real browser)

Run against a `next dev` instance whose Supabase credentials were overridden at process-start to the local stack (never `.env.local`'s production project), confirmed via `GET /api/gaming/config` returning `http://127.0.0.1:54421` before any other action. No Product XP values were seeded for this simulation — `gaming_xp_events` remained at zero rows throughout.

1. Two Teams, one Player each, one Venue (radius large enough to make geo-eligibility deterministic for this simulation without faking the venue's own logic), created via the real admin UI (`predictions-admin.html`) after real OTP-email sign-in (code retrieved from the local mail catcher, matching this session's established pattern) and a real `gaming_admins` grant.
2. Two Matches created and classified `RANKED` via the real admin flow / the real `set_match_activity_classification_atomically` RPC (no HTTP admin route exists yet for classification — same "test/fixture seam, no admin route" posture already established elsewhere in this codebase for policy/rule configuration), each with an enabled Venue Activation.
3. Signed in as a real Gaming Member on `soccer-predictions.html`; submitted an ordinary-minute Prediction (`46, null`) on the first fixture and a first-half-stoppage Prediction (`45, 1`) on the second — both via the real `POST /predict` route, both confirmed via a direct read of the `predictions` table to carry the correct two-column shape.
4. The rendered UI correctly disables the stoppage input at every regulation minute except 45/90 and enables it at 45 — verified both visually and via direct DOM inspection (`.disabled` state) before and after changing the regulation input.
5. Both Matches finalized via the real admin UI / real `finalize_match_result_atomically` RPC. Both recap cards render `46'` and `45+1'` respectively via the one shared `formatGoalMinute` helper, both show Goal Minute ✓.
6. The corrections proving case (§8) executed live: the ordinary-fixture Match corrected from official `46` to true `(45, 1)` via the real admin correction flow (`startResultCorrection` → `correctMatchResult`); the member recap flipped from `3 of 4 correct` (Goal Minute ✓) to `2 of 4 correct` (Goal Minute ✗) without any change to the stored Prediction. Confirmed directly against the database: original Evaluation preserved unchanged, a new Evaluation row created, the new Experience Summary's `supersedes_experience_summary_id` pointing at the original Summary, `correct_dimension_keys` differing correctly, and zero rows in `gaming_xp_events` throughout.
7. Mobile viewport (375×812) validated on both the finalized-recap view and the live Prediction-authoring form (a third fixture created for this check) — no horizontal overflow, the regulation/stoppage input pair and its hint text remain legible and usable, 44px-minimum touch targets preserved, no redesign.

**Not independently re-proven live:** Prize Qualification's independence from XP configuration — already proven directly by both the in-memory "Missing-policy boundary" test and the real-Postgres contract test's correction scenario (`oldQualificationAfterCorrection`/`newQualification` assertions), so it was not considered necessary to re-click through manually as well.

The dev server and its background process were stopped, and both browser tabs closed, at the end of this simulation. Local Postgres retains the simulation's Team/Match/Prediction/Evaluation/Summary rows as ordinary local dev data — no cleanup was required or performed, since none of it is production state.

## 13. Production / backfill state at local acceptance (pre-deployment)

Reconfirmed read-only three times: at the start of local implementation, at the start of the acceptance gate, and immediately before staging/commit — production migration ceiling remained `0093` throughout this entire local-implementation engagement; `predictions`, `match_results`, `official_goal_events`, `evaluations`, `experience_summaries`, and `gaming_xp_events` all confirmed empty (zero rows, `content-range: */0`) at every check. The `0094`/`0095` reads (whether `predicted_goal_minute_regulation`/`correct_dimension_count` exist) were also re-probed at the acceptance gate and confirmed absent (`42703 column does not exist`), while the old `predicted_goal_minute` column was confirmed still present — independent, read-only, schema-level proof (not merely a migration-history read) that no `0094+` migration was live at that time. See §15 for the subsequent, separately-authorized production deployment.

## 14. Explicit non-goals (as of local acceptance)

Not done, not attempted, not implied by anything above §15:

- No Product Gaming XP values configured (points, band weights, jackpot rules) — `0/1/4/10/20` remains research-only.
- No daily participation allowance configured for production.
- No Category Rating, Achievements, or any feature beyond this bounded correction.
- No resolution of the Exact Scoreline regulation-vs-extra-time gap (§7) — explicitly deferred pending a real schema decision; the §2a acceptance-gate audit reconfirmed this gap is unchanged, not worsened, by the `official_goal_events` boundary fix.

This local implementation was staged and committed locally at the acceptance gate as `27ac429cc5c02dee4f10e59d7f541df392f7710b` — local commit only, nothing pushed, at that point in the engagement. See §15 for what happened next.

## 15. Production Deployment (2026-08-21)

A separate, later, explicitly-authorized gate (the "Production Deployment + Coordinated Window Validation Gate") deployed this local implementation. This section documents that gate; it does not retroactively claim any earlier section of this record described a deployed state.

**Compatibility classification — stated plainly, not softened:** this deployment is **not backward compatible** across the v1↔v2 boundary. `predicted_goal_minute` was dropped, not retained; `upsert_prediction_atomically`'s old signature was replaced, not extended. A prior readiness gate classified this `OLD_SOURCE_NEW_SCHEMA_PARTIALLY_COMPATIBLE` / `NEW_SOURCE_OLD_SCHEMA_PARTIALLY_COMPATIBLE`, and this deployment proceeded on exactly that basis — a real, temporarily-incompatible window, deliberately minimized (migrations pushed, verified, then source pushed immediately), not a claim of compatibility, and not a compatibility bridge (none was built; none was warranted — see that gate's own cost/benefit analysis).

**A. Locally proven before deployment:** everything in §1–§12 above — all Predictions-v2 settlement semantics, the `official_goal_events` boundary fix, 494 behavioral and 96 contract tests, the full operational simulation including the live `46`→`45+1` correction proving case, all run against local Postgres and a local dev server, never against production.

**B. Production-deployed and directly validated, live, without manufacturing any Gaming Member:**
- Migrations `0094`–`0100` applied via `supabase db push` (dry-run confirmed the exact 7-file inventory first, no seeds, no roles); production migration ceiling is now **`0100`**.
- Commit `27ac429cc5c02dee4f10e59d7f541df392f7710b` fast-forward pushed to `origin/main` (`bb5f71c..27ac429`); Vercel deployment confirmed successful via GitHub's own deployment-status check; the live site confirmed serving the new source (the new stoppage-boundary UI copy is present in the live `soccer-predictions.html`).
- Schema shape: old `predicted_goal_minute` column gone; new `predicted_goal_minute_regulation`/`predicted_goal_minute_stoppage`/`correct_dimension_count`/`correct_dimension_keys` all present and selectable.
- RPC shape: the new `upsert_prediction_atomically` signature accepted a real call (reaching `MATCH_NOT_FOUND`, a real domain error, not a signature error); the old signature now returns `PGRST202` (function not found) live; `finalize_match_result_atomically`/`correct_match_result_atomically` retain their unchanged external signatures and reach real domain logic (`MATCH_RESULT_NOT_FOUND`); `record_experience_summary_atomically` correctly accepted an old-shaped 14-parameter call (its two new parameters defaulted), reaching a real FK check.
- All four live CHECK constraints proven by name, via real (rejected, zero-row) write attempts: Prediction regulation range, Prediction/official stoppage-boundary requirement (both directions), and Summary dimension cardinality each rejected an invalid payload with that exact constraint's name in the response; a large stoppage offset at a legal boundary (`(90, 999)` official, `(90, 999)` prediction) was accepted by the CHECK layer in both cases (rejected only by an unrelated foreign key on the deliberately-fabricated id) — proving no ceiling was introduced on either side.
- Existing-game regression, each run end-to-end directly against production post-deployment: Guest Open Response (create→join→lock→start→submit→close→reveal), Voting (create→join→lock→start→cast valid vote), Quiz (prepare→lock→start-quiz→submit→close), Guest Poker (create→join×2→deal) — all passed cleanly, no regression. (Real Session/Poker rows were created by this regression and were not deleted, matching this repository's established precedent — there is no canonical delete mechanism for this evidence.)
- `soccer-predictions.html` and `predictions-admin.html` both `200`; the public match-list endpoint `200` with `{"matches":[]}`; an unauthenticated admin route cleanly `401`; `GET /api/gaming/config` still `500` (unchanged, pre-existing, unrelated to this deployment).
- `gaming_category_participation_policy`, `gaming_xp_rules`, `gaming_xp_events`, and `gaming_members` all remain at **zero rows** after deployment — none seeded or manufactured. `GET /api/gaming/leaderboard` → `{"entries":[]}`, honestly empty. This deployment does not activate Gaming XP.

**C. Still pending because Auth is unavailable — classified as pending, not converted into a defect:** the full authenticated v2 Prediction→Evaluation→Summary→correction path against real production data (ordinary `46` vs `45+1` submission, member recap rendering from a real persisted Prediction, a real Evaluation, a real Summary's `correct_dimension_count`/`correct_dimension_keys`, correction/supersession, zero-XP settlement against production's empty XP configuration, Prize Qualification independence) is already proven locally (§A) but genuinely unproven in production. `SUPABASE_ANON_KEY` remains unconfigured in the Vercel environment (`GET /api/gaming/config` → `500`), blocking both Gaming Member and Gaming Admin browser sign-in identically — a pre-existing, unrelated operational gap this deployment did not touch, did not configure, and did not work around by manufacturing identity.

**D. Exact Scoreline regulation-only limitation — reconfirmed, not resolved:** `match_results.home_score`/`away_score` still carry no structural regulation-vs-extra-time provenance in production. The live admin Result UI's score inputs were inspected this gate and still carry only generic "Home score"/"Away score" placeholders — no explicit instruction that the value must exclude extra time and penalties. Classified as **DEPLOYMENT-ADJACENT CLARIFICATION RECOMMENDED**: a small future UI/copy change, not a blocker, and not implemented in this gate.

**E. The temporary v1↔v2 incompatibility window and its closure:** opened the moment migrations `0094`–`0100` were applied while `bb5f71c` (old source) was still live; confirmed open via a direct probe (`GET /api/gaming/config` unchanged, zero unexpected `gaming_members`/`predictions` rows); closed the moment the `27ac429` Vercel deployment was confirmed live and serving the new source. Total elapsed time between migration application and confirmed new-source deployment was minutes, not hours, matching the "deliberately short" instruction. At no point during the open window was an authenticated Soccer Prediction submission attempted. Both `OLD_SOURCE_NEW_SCHEMA` and `NEW_SOURCE_OLD_SCHEMA` no longer apply as of this deployment — production schema and source are now both v2, consistently.

**Correction to this record's own earlier RLS characterization:** an earlier version of this record's acceptance-gate audit (see the gate's own report, not restated in the numbered sections above) stated no RLS was enabled anywhere in this schema, based on a migration-file-text grep finding zero explicit `enable row level security` statements. `SOCCER_PREDICTIONS_IMPLEMENTATION_RECORD.md`'s own prior production deployment record documents that Supabase auto-enables RLS on newly created tables at the platform level (confirmed there via `supabase db dump --linked` showing all 13 Predictions tables RLS-enabled with zero explicit policies, and empirically via a denied live anon-key `INSERT`) — independent of whether the migration's own SQL text contains an explicit statement. This is accurate context missed by the earlier grep-only check. It does not change any conclusion: 0094–0100 create zero new tables (only `ALTER TABLE`/`CREATE FUNCTION`), so this ambient, platform-level RLS state — whatever it is — is unchanged by this Slice, and all server-side access in this codebase uses `service_role`, which bypasses RLS regardless.
