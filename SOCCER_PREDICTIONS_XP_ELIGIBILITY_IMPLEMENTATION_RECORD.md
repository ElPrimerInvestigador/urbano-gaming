# Soccer Predictions — XP Eligibility / Calibration Support Implementation Record

Local implementation and local acceptance only. No production migration was applied, no production data was mutated, no Product XP values were configured, no Match was activated for XP in production, and no Gaming XP was activated anywhere. This record documents the one bounded infrastructure gap identified by the accepted XP Activation / Calibration Classification gate; it does not claim, authorize, or perform activation.

## 1. Product boundary this Slice creates

**PLAYABLE MATCH != XP-ELIGIBLE MATCH.**

Before this Slice, nothing in the schema distinguished "a Match Predictions can be submitted against" from "a Match whose Predictions are eligible to generate persistent Gaming XP." Activity Classification only ever separated TRAINING (never XP) from everything else; every classified CASUAL/RANKED/OFFICIAL Match would attempt XP consequence processing the moment any category-level policy/rule existed, regardless of which specific Match was involved. Research's own controlled-v1 recommendation — a small, curated, initially XP-eligible catalog, controlling Soccer's opportunity-volume advantage over categories with a naturally smaller event supply — had no architecture to express it. This Slice adds exactly that one missing distinction, and nothing else.

## 2. Chosen XP-eligibility representation

**A nullable Match-level boolean, `matches.xp_eligible`, mirroring `activity_classification`'s own existing shape and locking discipline exactly** — not a boolean-only shape that loses the "no decision made yet" state, and not a separate catalog/junction table.

Three considered options, in order of what the gate asked to compare:

- **Boolean + `declared_at` provenance column:** rejected. `activity_classification` itself — the closest existing precedent, created for an almost identical Product need — carries no separate `declared_at` column; immutability is derived from evidence (Prediction/Result existence), not from a timestamp, and the row's own `created_at` plus the immutable Evaluation/Summary evidence trail already gives complete historical provenance once real evidence exists. Adding a redundant timestamp here would repeat exactly the "avoid redundant state if derivable" mistake this codebase's own `official_goal_events` migration comment already warns against.
- **A separate curated-catalog/junction entity:** rejected. XP eligibility is a single boolean fact about one Match, not a many-to-many relationship or a versioned policy value; a dedicated table would be schema complexity with no corresponding Product need at this scale.
- **A plain nullable boolean on `matches`, mirroring `activity_classification`:** accepted. `NULL` = no eligibility decision made yet (a genuinely distinct, common state — most Matches will remain undeclared indefinitely); `true` = declared eligible; `false` = explicitly declared not eligible, distinguishable from "forgotten." Locking (immutable once Prediction or Result evidence exists) is enforced inside a new atomic function, matching this repository's own established convention of enforcing invariants inside atomic functions rather than a trigger or a new mechanism class.

At the `experience_summaries` layer, the representation is deliberately simpler: a **`not null default false`** boolean, mirroring how `activity_classification` is nullable on `matches` but `not null` on `experience_summaries` — richer, nullable provenance at the source; a single normalized, always-present, fail-closed fact at the shared Metagame boundary. A Summary is only ever authored once real evidence exists, at which point the governing Match-level fact is already resolved to a concrete boolean; "undeclared" and "explicitly false" both collapse to `false` at this layer, because from the consequence processor's own perspective both cases mean identically "zero XP" — the richer three-state distinction only matters for Match/catalog management, not for consequence selection.

## 3. Declaration authority and locking

A new atomic function, `set_match_xp_eligibility_atomically(p_match_id, p_xp_eligible)`, is the sole write path for `matches.xp_eligible` — byte-for-byte the same locking discipline as `set_match_activity_classification_atomically` (0083): freely settable/re-settable while no Prediction or Result evidence exists for the Match, locked (rejecting any *changed* value, idempotently accepting the *same* value) the instant either exists, enforced by the database itself via `select ... for update` plus an `exists(...)` check against `predictions`/`match_results`, not by application-only logic.

Unlike Activity Classification, there is **no precondition for Prediction submission** — `upsert_prediction_atomically` was not touched by this Slice and has, and needs, zero dependency on this column. A Match can be fully playable (classified, activated, accepting real Predictions) with `xp_eligible` left `NULL` indefinitely; declaring it is optional, but once declared, the identical evidence-based lock applies, which is precisely what prevents previously non-XP activity from ever being retroactively converted into XP-eligible activity, and prevents a currently-eligible Match from being quietly un-curated after members have already earned real recognition under it.

No HTTP admin route was added, matching Activity Classification's own established precedent exactly (Phase 1 has no admin route for that either) — the same "test/fixture seam, called directly via service role" posture, not an oversight. This is deliberately the minimum administrative capability: a domain-layer function (`setMatchXpEligibility` in `adminCatalog.ts`) and a repository method on both backends, with no new UI surface and no URBANO Gaming Admin Console work begun.

## 4. Summary propagation

`finalize_match_result_atomically` and `correct_match_result_atomically` each read `matches.xp_eligible` alongside the Match's already-read `activity_classification`, in the exact same query, and pass `coalesce(xp_eligible, false)` through to `record_experience_summary_atomically`'s new trailing `p_xp_eligible` parameter — every Evaluation and every Finalized Experience Summary is still authored exactly as before, for every Prediction, regardless of eligibility. A non-eligible Match's Predictions still settle normally and still produce immutable finalized evidence (Evaluation, Summary, dimension facts); only the resulting Summary's own `xp_eligible` fact differs, and the consequence processor (§5), not Summary authorship, is what turns that into zero XP.

Because `xp_eligible` is locked the moment Prediction or Result evidence exists, and both finalize and any later correction only ever run after that evidence already exists, a correction reads the *identical, unchanging* fact the original finalization read. **A correction can never change which side of the eligible/not-eligible line its own Match falls on** — this is not a runtime check added to the correction path; it is a structural consequence of the locking rule in §3, proven live in the operational simulation (§9.J).

`record_experience_summary_atomically` gained one new trailing parameter, `p_xp_eligible boolean default false` — a backward-compatible extension mirroring 0097's own precedent for `p_correct_dimension_count`/`p_correct_dimension_keys` exactly (trailing, defaulted, never a required-parameter break). The default is `false`, not `true`: any caller that omits this parameter — a test/fixture seam, or a future Experience adapter not yet updated — produces a non-XP-eligible Summary, never a silently XP-eligible one. Predictions' own finalize/correct functions always pass it explicitly and never rely on the default.

## 5. Consequence-processing behavior

`process_experience_summary_consequences_atomically` gained exactly one new early guard, placed immediately after the existing TRAINING guard and shaped identically to it:

```sql
if not v_xp_eligible then
  return query select null::uuid, null::text, null::integer, null::uuid, false where false;
  return;
end if;
```

A non-eligible Summary produces zero PARTICIPATION and zero PERFORMANCE consequences, unconditionally, regardless of what `gaming_xp_rules`/`gaming_category_participation_policy` rows exist. This function still never inspects any Experience's own runtime tables — `matches.xp_eligible` is never queried here; only the already-copied, always-present `experience_summaries.xp_eligible` fact is read, preserving the canonical boundary this function's own governing comment already states. One guard, read once, rather than duplicating an eligibility condition inside each of the two independent consequence blocks below it — matching the gate's own explicit preference.

Everything else is byte-for-byte unchanged: allowance accounting, Performance-remains-eligible-after-Participation-allowance-exhaustion independence, the missing-policy silent no-op, and correction-aware reversal/reissue logic. An eligible Summary's correction is always itself eligible (§4), so this guard never needed a correction-specific special case — that state is structurally unreachable, not merely untested.

## 6. Predictions adapter

Predictions reads its own Match fact and reports it; it does not, and per grep-verified source inspection never did or does, reference `gaming_xp_rules` or `gaming_category_participation_policy` anywhere in `lib/gaming/predictions/`. It does not choose an XP amount. The canonical boundary — Predictions reports facts, Metagame selects consequences — is unchanged and, if anything, more sharply demonstrated by this Slice: eligibility is a fact Predictions *reports* (read from its own `matches` table), never a consequence it computes.

## 7. Facts-vs-consequences boundary — verified, not assumed

Verified directly via source grep, not merely asserted:

- `grep -rln "gaming_xp_rules\|gaming_category_participation_policy\|GamingXpRule\|GamingCategoryParticipationPolicy" lib/gaming/predictions/` → zero matches.
- `grep -rn "\"matches\"" lib/gaming/metagame/db/*.ts` → zero matches (Metagame never queries the `matches` table).
- The only two mentions of `lib/gaming/predictions` anywhere under `lib/gaming/metagame/` are both inside doc comments stating the boundary rule itself, not real import statements.
- Direct inspection of both `processExperienceSummaryConsequences` implementations (SQL and the in-memory mirror) confirms neither reads `correct_dimension_count`/`correct_dimension_keys` for consequence purposes — those dimension facts remain persisted and available for a future, prospective, versioned dimension/combination-bonus policy without ever needing to rewrite historical Summaries, exactly as the classification gate required be preserved.

## 8. Migrations (0101–0107)

All seven are new, additive files; **no migration `0001`–`0100` was edited**.

| Migration | Change | Classification |
|---|---|---|
| `0101_add_xp_eligible_to_matches.sql` | `matches` gains `xp_eligible boolean null` | Additive column |
| `0102_create_set_match_xp_eligibility_atomically.sql` | New function, mirrors `set_match_activity_classification_atomically` exactly | New function |
| `0103_add_xp_eligible_to_experience_summaries.sql` | `experience_summaries` gains `xp_eligible boolean not null default false` | Additive column |
| `0104_record_experience_summary_atomically_xp_eligibility.sql` | Drop/recreate: one new trailing, defaulted parameter | Backward-compatible replacement |
| `0105_process_experience_summary_consequences_xp_eligibility.sql` | Drop/recreate: one new early guard | Function replacement, external signature unchanged |
| `0106_finalize_match_result_atomically_xp_eligibility.sql` | Drop/recreate: reads and passes through `xp_eligible` | Function replacement, external signature unchanged |
| `0107_correct_match_result_atomically_xp_eligibility.sql` | Drop/recreate: identical change on the correction path | Function replacement, external signature unchanged |

All seven applied cleanly to local Postgres via `supabase db reset --local`, from a completely fresh reset, with zero SQL errors, verified twice during this Slice (once mid-implementation, once immediately before this record was written).

**Compatibility analysis, matching the same rigor as the prior Soccer Predictions v2 readiness gate:**

- `finalize_match_result_atomically` and `correct_match_result_atomically` keep their exact external signatures and return shapes (only `record_experience_summary_atomically`'s *internal* call gained one argument) — an old caller invoking either function by its existing RPC name and existing parameters would still succeed syntactically.
- `record_experience_summary_atomically`'s new parameter is trailing and defaulted — an old-shaped 16-parameter call (the pre-Slice shape) still matches this new 17-parameter function and succeeds, defaulting `xp_eligible` to `false`.
- `process_experience_summary_consequences_atomically`'s external signature (`p_experience_summary_id uuid`) is completely unchanged.
- No migration in this Slice creates a new table, alters an existing column's type, or removes any column — every change is additive at the schema level and backward-compatible at the RPC level, unlike the genuinely breaking `predicted_goal_minute` change in the prior Slice. **A coordinated deployment window is not anticipated to be required for this Slice specifically** — old source calling the new schema would simply never populate `xp_eligible` (defaulting to `false`, fail-closed) rather than erroring; new source calling old schema would fail at the two new RPC calls (`set_match_xp_eligibility_atomically` not existing, and the new trailing parameter being rejected by the old function signature) but only for the eligibility-specific calls, not for baseline Predictions functionality. This analysis is provided for completeness; it does not authorize or schedule any deployment — that remains a separate, later, explicitly-authorized decision, exactly as it was for the prior Slice.

## 9. Tests

**Behavioral (in-memory), `npm test`: 507/507 passing across 23 files** (up from 494 before this Slice; +13 new tests, all in `predictions.test.ts`'s new "XP eligibility declaration" describe block):

1. A freshly created, classified Match has undeclared (`null`) XP eligibility.
2. Explicit eligible declaration succeeds pre-evidence.
3. Explicit non-eligible declaration succeeds pre-evidence — a distinct state from undeclared.
4. Idempotent redeclaration of the same value, once locked, returns success rather than erroring.
5. Eligibility cannot change once a Prediction exists.
6. Eligibility cannot change once Result evidence exists, even with zero Predictions ever submitted.
7. No retroactive not-eligible → eligible upgrade after evidence exists.
8. Activating/enabling a second Venue Activation for the same Match never alters Match XP eligibility.
9. An eligible Match's finalized Summary preserves `xpEligible: true` and produces the applicable fixture XP.
10. A non-eligible Match's finalized Summary preserves `xpEligible: false` and produces zero XP even with valid fixture policy/rules configured (a genuinely perfect 4/4 prediction, deliberately).
11. An undeclared (`null`) Match behaves identically to explicitly non-eligible — fail-closed, never silently eligible.
12. TRAINING still produces zero XP even when the Match is declared XP-eligible.
13. Correction preserves the Match's own eligibility fact on the superseding Summary too.

All 26 existing `recordExperienceSummary(repo, {...})` fixture call sites across `persistentMetagame.test.ts` (Gaming Day, allowance, rule-versioning, missing-policy-boundary, and Global Leaderboard tests) gained `xpEligible: true`, and `setupMatchAndVenue` (`predictions.test.ts`) plus `setupRankedMatch`/`setupRankedMatchNoXpConfig` (`persistentMetagame.test.ts`) each gained a `setMatchXpEligibility(repo, match.matchId, true)` call — all fixture setup, never Product configuration — so every pre-existing test keeps exercising the exact XP-producing paths it always has. This is documented here explicitly rather than silently: without this update, those tests would have failed not because of a regression, but because the new fail-closed default correctly suppressed XP for fixtures that had never previously needed to declare eligibility at all. (Re-verified by direct recount during the final local-acceptance gate: 26 `xpEligible: true` call sites in `persistentMetagame.test.ts`, matching the earlier implementation-turn count exactly — a prior draft of this record understated it as 25.)

**Contract (real local Postgres), `npm run test:contract`: 98/98 passing across 9 files** (up from 96 before this Slice; +2 new tests), including a fresh full run after a from-scratch `supabase db reset --local`:

- `predictionsSupabaseRepository.contract.test.ts`: declaration succeeds pre-evidence, locks after a Prediction exists (idempotent redeclaration of the locked value succeeds, a changed value is rejected) — all against the real database; a non-eligible Match produces zero XP against the real database even with real fixture policy/rules configured, an eligible Match produces the applicable XP, and the Summary round-trips the fact — proven with a deliberately 0/4-scoring prediction to avoid a PERFORMANCE-rule collision with an unrelated, still-standing fixture from an earlier test in the same file (a real pitfall caught and documented, not merely avoided silently).
- One existing test (the "full settlement pipeline") required the same `setMatchXpEligibility` fixture addition as the in-memory suite, for the same reason.
- `persistentMetagameSupabaseRepository.contract.test.ts`: all 18 existing `meaningfulParticipation`-bearing fixture call sites updated identically.

## 10. Operational simulation (local only, real browser, real Postgres)

Run against a `next dev` instance whose Supabase credentials were overridden at process-start to the local stack (confirmed via `GET /api/gaming/config` returning `http://127.0.0.1:...`), with a real Gaming Admin signed in via real OTP (Mailpit). No Product-final numerical values were used — the fixture points (5 Participation, 20 Performance) are the same illustrative values already used throughout this engagement's research discussion, not asserted here as accepted.

1. Two Matches created and classified RANKED via the real admin flow.
2. Match A declared XP-eligible (`true`); Match B declared explicitly not eligible (`false`) — both via the real `set_match_xp_eligibility_atomically` RPC.
3. Both Matches activated at the same Venue; confirmed directly against the database that activation created the expected `venue_activations` rows without altering either Match's `xp_eligible` value.
4. Equivalent Predictions submitted for both Matches via the real, authenticated `POST /predict` route.
5. Both Matches finalized via the real admin flow with identical, deliberately perfect (4/4) correctness. Both produced valid Evaluation and Finalized Experience Summary evidence.
6. With real fixture policy/rules configured (Participation 5pts, Performance `CORRECT_4_OF_4` 20pts): the eligible Match produced exactly one PARTICIPATION (+5) and one PERFORMANCE (+20) event; the non-eligible Match, despite the identical perfect correctness, produced **zero** additional events — confirmed by a direct before/after `gaming_xp_events` count.
7. An attempt to change the eligible Match's declaration after its own Prediction/Result evidence existed was rejected by the real database with `XP_ELIGIBILITY_LOCKED`.
8. A correction was run against the eligible Match (score corrected from 1-0 to 2-0, dropping the Prediction from 4/4 to 3/4 since Exact Scoreline was no longer correct). Confirmed directly against the database: the superseding Summary preserved `xp_eligible: true`; the original PARTICIPATION event was preserved untouched (an ordinary correctness correction never removes Participation XP); the original PERFORMANCE event was correctly reversed (a real `-20` row referencing the original event's id); no reissue event fired, correctly, since no fixture rule exists for `CORRECT_3_OF_4` in this simulation (the pre-existing missing-policy silent no-op, unrelated to and unaffected by this Slice).
9. `GET /api/gaming/leaderboard` correctly showed the member's net effective XP (5 — the standing Participation award; the Performance award net to zero after its reversal) — computed entirely by the pre-existing `get_global_gaming_xp_leaderboard()` function, unaware of and unmodified for the `xp_eligible` concept, confirming no leaderboard code change was required.

One real timing subtlety was caught and corrected live during this simulation, not silently worked around: the very first eligible/non-eligible pair of Matches was finalized *before* the fixture Participation/Performance rules were inserted, and since rule lookups resolve "the rule version effective at the Summary's own `occurredAt`" (not "current"), that first pair correctly produced zero XP for a reason unrelated to eligibility. A second, fresh pair of Matches (created and finalized after the fixture rules already existed) was used to prove item 6 above; the first pair remained useful for, and was used for, items 7–8 (locking and correction), which do not depend on real XP having fired.

The dev server, its background process, and both browser tabs were stopped/closed at the end of this simulation. Local Postgres retains the simulation's Match/Prediction/Evaluation/Summary/XP rows as ordinary local dev data — no cleanup was required or performed, since none of it is production state; a fresh `supabase db reset --local` was run afterward anyway as part of final regression (§11), which discards it regardless.

## 11. Telemetry implication

Confirmed, not built: the new `xp_eligible` fact makes "XP-eligible catalog size," "eligible vs non-eligible Prediction counts," and "Performance XP per eligible Match" derivable from existing tables via a straightforward query (`count(*) from matches where xp_eligible`, joined against `experience_summaries`/`gaming_xp_events` as needed) — no new persisted fact is required for any of them. "Predictions after Participation allowance exhaustion" and "Soccer XP volume" remain exactly as derivable as the prior gate's own audit already found (§8 of that gate's report); this Slice changes nothing about that conclusion. No telemetry table was built in this Slice.

## 12. Explicit non-goals

Not done, not attempted, not implied by anything above:

- No Product Gaming XP values configured in production or anywhere outside test/simulation fixtures.
- No `gaming_category_participation_policy` or `gaming_xp_rules` row inserted in production.
- No real Match activated for XP in production.
- No Gaming Member seeded in production.
- No production deployment, migration, or data mutation — confirmed read-only, immediately before this record was written, that `matches.xp_eligible` still does not exist in production (`42703`).
- No Category Rating, Achievements, seasons, boosters, Gaming Plus, currency/store, rarity multiplier, Goal Minute jackpot, Category Leaderboard, or other game engine.
- No URBANO Gaming Admin Console work begun — the one new declaration capability is a domain function and a direct-RPC seam, matching Activity Classification's own existing precedent, not a new UI.
- **Gaming XP remains NOT ACTIVATED** — this Slice adds the mechanism that will make a future, separately-authorized activation *safely scoped*; it does not itself activate anything. The activation boundary defined by the prior classification gate (inserting a PERFORMANCE `gaming_xp_rules` row, or both a policy and a PARTICIPATION rule together, in production) remains untouched by this Slice.

## 13. Production Deployment (2026-08-22)

A separate, later, explicitly-authorized gate (the "Production Deployment + Validation Gate") deployed this local implementation. This section documents that gate; it does not retroactively claim §12 above described a deployed state — §12's "no production deployment" statement was accurate as of local acceptance and is preserved unedited as an honest historical record.

**Compatibility classification — stated plainly:** unlike the prior Soccer Predictions v2 deployment, this Slice's migrations and RPC changes are genuinely additive/backward-compatible (see §8's own compatibility analysis). A prior readiness gate nonetheless identified one concrete, if currently inert, `NEW_SOURCE_OLD_SCHEMA` risk (a named-parameter mismatch on the direct `record_experience_summary_atomically` RPC path, and a hard failure on `set_match_xp_eligibility_atomically`, had source been pushed before migrations) and recommended migrations-first ordering to avoid it entirely, rather than relying on the additive classification alone. This deployment followed that ordering.

**A. Locally proven before deployment:** everything in §1–§12 above, re-verified fresh immediately before this deployment — 507 behavioral and 98 contract tests, a from-scratch `supabase db reset --local` through `0107`, clean typecheck/build/diff-check, and isolated re-runs of every load-bearing XP-eligibility case, all run against local Postgres, never against production.

**B. Production-deployed and directly validated, live, without manufacturing any Gaming Member or Match:**
- Migrations `0101`–`0107` applied via `supabase db push --linked` (dry-run confirmed the exact 7-file inventory first, no seeds, no roles); production migration ceiling is now **`0107`**.
- Commit `9bd6e8e4aa5a0487199eee0f5b88f287141ddc88` fast-forward pushed to `origin/main` (`27ac429..9bd6e8e`); Vercel deployment confirmed successful via GitHub's own commit-status check for this exact SHA (`state: success`, "Deployment has completed").
- Old-source/new-schema checkpoint verified, not assumed: with schema already at `0107` and source still `27ac429`, public Soccer Predictions surfaces and all four Guest engines were confirmed live and error-free before source was pushed.
- Schema shape: `matches.xp_eligible` and `experience_summaries.xp_eligible` both present and selectable.
- RPC shape: `set_match_xp_eligibility_atomically` reached real domain validation (`MATCH_NOT_FOUND`) against a nonexistent Match id; `record_experience_summary_atomically`'s new `p_xp_eligible` parameter resolved against the live function (reaching its own `INVALID_ACTIVITY_CLASSIFICATION` validation, not a parameter-resolution error); `finalize_match_result_atomically`/`correct_match_result_atomically` retained their unchanged two-parameter external signatures and reached real domain logic (`MATCH_RESULT_NOT_FOUND`).
- Existing-game regression, each run end-to-end directly against production post-deployment: Guest Open Response (create→join→lock→start→submit→close→reveal), Voting (create→join→lock→start→cast valid vote), Quiz (prepare→lock→start-quiz→submit→close), Guest Poker (create→join×2→deal) — all passed, no regression. (Real Session/Poker rows were created by this regression and were not deleted, matching this repository's established precedent — there is no canonical delete mechanism for this evidence. One malformed request in the Voting proving script — a missing `promptText` on the VOTING `turnConfig` — was the API correctly rejecting an invalid client request, corrected and re-run, not a production defect.)
- `soccer-predictions.html` and `predictions-admin.html` both `200`; the public match-list endpoint `200` with `{"matches":[]}`; `GET /api/gaming/leaderboard` → `{"entries":[]}`; `GET /api/gaming/config` still `500` (unchanged, pre-existing, unrelated to this deployment).
- `gaming_xp_rules`, `gaming_category_participation_policy`, `gaming_xp_events`, and `matches` all remain at **zero rows** after deployment — none seeded, no real Match declared XP-eligible, none manufactured. This deployment does not activate Gaming XP.

**C. Still pending because Auth is unavailable — classified as pending, not converted into a defect:** authenticated Match XP-eligibility administration through the normal admin UI, real authenticated Soccer Prediction submission, real eligible-vs-non-eligible Summary comparison, real XP event issuance, Global Leaderboard population, and correction/reversal against real authenticated evidence all remain genuinely unproven in production. `SUPABASE_ANON_KEY` remains unconfigured (`GET /api/gaming/config` → `500`) — the same pre-existing, unrelated operational gap already documented for Soccer Predictions v2 and Persistent Metagame Phase 1, not caused or worsened by this deployment.

**D. Admin Control Plane downstream implication:** `matches.xp_eligible` declaration is a consequential-finalizer administrative action — evidence-locked once real gameplay begins, like Activity Classification, though it configures no Product XP value itself. A future Admin Control Plane A0/A1 must eventually preserve, at minimum, acting admin identity, declaration timestamp, the Match, old/new value, success/failure, and lock status/reason if rejected — none of which the current schema captures (deliberately, for this test/fixture-seam-scoped Slice). No audit infrastructure was added in this deployment.
