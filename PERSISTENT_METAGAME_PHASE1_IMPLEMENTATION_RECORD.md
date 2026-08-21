# Persistent Metagame — Phase 1 Implementation Record

Local-only. Not staged, not committed, not pushed, per explicit founder instruction. This record documents the smallest safe implementation of `FINALIZED EXPERIENCE SUMMARY → GENERALIZED GAMING XP LEDGER → SOCCER PREDICTIONS FIRST ADAPTER`, authorized against canonical Product/Architecture authority at `Product/Persistent_Metagame_Architecture.md` and ADR-035. It does not implement Category Competitive State, Achievements, Poker/Trivia/Quiz XP, or any Global Leaderboard — those remain out of scope, exactly as authorized.

## Starting state

Local repository: branch `integrate/join-session`, HEAD `f79c4e606d436a1cca539801cbf77f536eda4270` (the prior documentation-closure commit), local migration ceiling `0081`. Production (verified read-only via `supabase migration list --linked` before and after this phase): migration ceiling `0081`, untouched throughout — every migration in this phase (`0082`–`0092`) was applied only via `supabase db reset --local`, never `db push --linked`.

## Exact files changed

**New migrations**: `supabase/migrations/0082`–`0092` (11 files, listed in full below).

**New domain surface**: `lib/gaming/metagame/types.ts`, `lib/gaming/metagame/db/metagameRepository.ts`, `lib/gaming/metagame/db/inMemoryMetagameRepository.ts`, `lib/gaming/metagame/db/supabaseMetagameRepository.ts`, `lib/gaming/metagame/recordExperienceSummary.ts`, `lib/gaming/metagame/processExperienceSummaryConsequences.ts`.

**Modified Predictions files**: `lib/gaming/predictions/types.ts` (`MatchRecord.activityClassification`, `MatchNotClassifiedError`, `ActivityClassificationLockedError`), `lib/gaming/predictions/db/predictionsRepository.ts` (`setMatchActivityClassification` added to the interface), `lib/gaming/predictions/db/supabasePredictionsRepository.ts` (implementation + error translation + `mapMatch`), `lib/gaming/predictions/db/inMemoryPredictionsRepository.ts` (implementation + classification gate in `upsertPrediction` + `finalizeMatchResult`/`correctMatchResult` rewritten to call the composed `InMemoryMetagameRepository` instead of the old direct progression-event writes), `lib/gaming/predictions/adminCatalog.ts` (`setMatchActivityClassification` command).

**Tests**: `__tests__/persistentMetagame.test.ts` (new, 24 tests), `__tests__/persistentMetagameSupabaseRepository.contract.test.ts` (new, 7 tests), `__tests__/predictions.test.ts` (updated — classification-gate fixture additions, 4 assertions redirected from the old ledger to the new one, none removed), `__tests__/predictionsSupabaseRepository.contract.test.ts` (updated — same treatment), `package.json` (both new test files registered).

**Explicitly untouched**: Identity Foundation, Poker (Foundation and Gameplay), Session `point_awards`, every existing Session engine, `progression_rule_points`/`gaming_progression_events` (left in place, deprecated, no new writes).

## Actual final schema

- `matches.activity_classification` (`text null`, check-constrained to `TRAINING`/`CASUAL`/`RANKED`/`OFFICIAL`) — `0082`.
- `set_match_activity_classification_atomically` — `0083`.
- `upsert_prediction_atomically` replaced to require classification before accepting a Prediction — `0084`.
- `experience_summaries` — `0085`.
- `gaming_category_participation_policy` — `0086`.
- `gaming_xp_rules` — `0087`.
- `gaming_xp_events` — `0088`.
- `record_experience_summary_atomically` — `0089`.
- `process_experience_summary_consequences_atomically` — `0090`.
- `finalize_match_result_atomically` replaced to author a Summary and call Metagame processing instead of writing `gaming_progression_events` directly — `0091`.
- `correct_match_result_atomically` replaced likewise, correction-aware — `0092`.

## Classification semantics

Lives on `matches` (not `venue_activations`), per the founder's explicit reasoning: one Gaming Member has one logical Prediction per Match regardless of Venue Activation, and Venue Activation owns venue eligibility/prize context, not competitive classification. `set_match_activity_classification_atomically` allows free changes while no `predictions` or `match_results` row exists for the Match, and hard-locks (raising `ACTIVITY_CLASSIFICATION_LOCKED`) the instant either exists — re-declaring the *same* value once locked is treated as an idempotent no-op, not an error. `upsert_prediction_atomically` now raises `MATCH_NOT_CLASSIFIED` if `activity_classification is null`. No Official Event organizer/approval behavior was built — `OFFICIAL` is accepted purely as a legal enum value. The Phase 1 proving case uses `RANKED`.

## Finalized Experience Summary contract

`experience_summary_id`, `gaming_member_id` (**`NOT NULL`** — see disposition below), `experience_key`, `category_key`, `activity_classification`, `authority_tier`, `occurred_at`, `finalized_at`, `meaningful_participation` (boolean), `performance_band_key` (nullable text), `source_reference` (opaque), `ruleset_version`, `supersedes_experience_summary_id` (nullable, self-referencing), `idempotency_key` (unique per `experience_key`), `evidence` (jsonb, narrowed to Experience-owned debugging/provenance only — never the sole home of a fact policy needs).

For Soccer Predictions: `experience_key = category_key = "SOCCER_PREDICTIONS"`; `occurred_at` = the Prediction's own `created_at` (the first accepted submission — confirmed this required zero new columns, since `predictions.created_at`/`updated_at` already existed and `upsert_prediction_atomically` already upserted in place); `meaningful_participation` is always `true` for every row Predictions' own settlement loop processes, since every such row already passed `upsert_prediction_atomically`'s full validation by construction; `performance_band_key` is the plain factual label `CORRECT_<n>_OF_4`, computed by Predictions' own `correct_dimension_count` — Predictions never selects a rule or points value, only reports this fact.

## Allowance concurrency mechanism (the mandatory correction)

The originally-proposed "lock/count existing rows" design was rejected before implementation, per the founder's own explicit correction, because it is unsafe when zero qualifying rows exist yet — nothing to lock, so two concurrent transactions could both observe `count < N` and both insert. The implemented mechanism: `process_experience_summary_consequences_atomically` first locks the `gaming_members` row itself (`for update`), serializing every consequence-processing call for that member regardless of which Summary it came from; the subsequent count-then-insert is therefore race-free by construction. **This was verified against real concurrent Postgres transactions**, not merely reasoned about — see the operational simulation below.

The count itself is over currently-*effective* `PARTICIPATION` awards only (`points > 0` and no other event's `reverses_gaming_xp_event_id` pointing at it) — a real bug (the first implementation counted every positive row regardless of reversal status) was found while writing the in-memory behavioral test for "reversal restores allowance," before it ever reached a contract test, and fixed in both the SQL function and its in-memory counterpart before any test run.

`gaming_day` is persisted directly on each `gaming_xp_events` row — the one deliberate exception to "derive, don't persist" in this schema, for the same reason `poker_hands.street` is: it is what the concurrency-gated count filters on directly. Computed once, server-side, from `occurred_at` converted into the category policy's own `gaming_day_timezone` (`America/Tegucigalpa` in every seeded/tested case) — never client-supplied.

## XP-rule versioning and participation-policy versioning

Kept as two separate, independently-evolving concepts, per the founder's explicit correction against collapsing them: `gaming_xp_rules` (category-scoped, `consequence_class` + `performance_band_key` keyed, versioned by `effective_at`/`superseded_at`) governs only fact→points mapping; `gaming_category_participation_policy` (category-scoped, versioned the same way) governs only the daily allowance size and the Gaming-Day timezone authority. Both are resolved "as of" the Summary's own `occurred_at`, never "as of now" — verified directly: a rule-value change made after an event was awarded does not alter that event's already-persisted `points`, in both the behavioral suite and, separately, against real Postgres.

Each `gaming_xp_events` row snapshots three provenance references: `experience_summary_id` (transitively carries `activity_classification`/`ruleset_version`), `gaming_xp_rule_id` (which points-mapping version fired — required, even on a reversal, copied from the event being reversed), and `gaming_category_participation_policy_id` (which allowance version governed the check — only for `PARTICIPATION`-class events, `null` for `PERFORMANCE`).

## TRAINING boundary

A real gap found while planning the required test matrix, not present in the original migration draft: `meaningfulParticipation` is always `true` for a valid Prediction regardless of the Match's classification, so without an explicit guard a `TRAINING` Match would still have attempted a `PARTICIPATION` award. Fixed by making `process_experience_summary_consequences_atomically` (and its in-memory counterpart) refuse to produce *any* consequence — participation or performance — whenever `activity_classification = 'TRAINING'`, regardless of what facts the Summary reports. This is a Metagame policy decision, not something any Experience adapter has to remember to suppress itself.

## Correction/reversal evidence

Traced directly against the existing, already-proven `correct_match_result_atomically` pattern and generalized without changing its actual behavior: a correction authors a new Summary with `supersedes_experience_summary_id` pointing at the prior one; `PERFORMANCE`-class events tied to the superseded Summary are always reversed and reissued against the corrected fact (unconditional, mirroring the existing performance-tier reversal Predictions already shipped); `PARTICIPATION`-class events are reversed only when `meaningful_participation` itself flips from `true` to `false` — an ordinary correctness correction leaves participation, and its XP, standing exactly as originally awarded. The mechanism is generic enough to reverse *either* class given the right input — verified directly by constructing a `meaningfulParticipation: true → false` correction in both test suites and confirming the participation event is correctly reversed and the freed allowance slot becomes available again the same Gaming Day, with neither the original nor the reversal row ever deleted.

## Legacy Predictions ledger disposition

`gaming_progression_events` and `progression_rule_points` (`0060`/`0061`) were **not** dropped, renamed, or altered — left in place, deprecated, receiving no new writes from `finalize_match_result_atomically`/`correct_match_result_atomically` as of this phase. Verified explicitly, both in the behavioral suite and against real Postgres: `listProgressionEventsForMember` returns an empty array for every Prediction settled after this phase, while the new `gaming_xp_events` ledger correctly receives the real awards.

## Tests

**Behavioral** (`__tests__/persistentMetagame.test.ts`, 29 tests): Summary idempotency and authorship; `occurred_at` anchored to first submission; classification gate (unclassified rejects, RANKED accepts, free-to-change before evidence, locked after Prediction, locked after Result evidence with zero Predictions, locked symmetrically in both directions); TRAINING zero-XP unconditionally, including non-consumption of other classifications' allowance; Gaming Day boundary either side of Tegucigalpa midnight, both for a fresh-allowance case and a shared-day case; configurable N=1 and N=2 fixtures; Casual/Ranked/Official sharing one allowance; continued recording after exhaustion; independent performance-XP eligibility under allowance exhaustion; rule-version historical immutability; reversal-restores-allowance with neither row deleted; three source-level boundary assertions (Predictions' SQL and TypeScript never reference the XP-rule/policy tables; `lib/gaming/metagame` never imports from `lib/gaming/predictions`); and the missing-policy boundary correction matrix (six tests — see "Missing-policy boundary correction" below).

**Contract** (`__tests__/persistentMetagameSupabaseRepository.contract.test.ts`, 8 tests, real local Postgres): the same idempotency, Gaming Day boundary, TRAINING suppression, rule-version immutability, and reversal-restores-allowance cases re-proven against the real database — plus the one test that matters most for this phase's own stated highest risk: **two genuinely concurrent `process_experience_summary_consequences_atomically` calls, via `Promise.all` against real Postgres, for the same member/category/day under an N=1 allowance, asserted to produce exactly one award between them.** This passed on the first real run. Also includes the NO CONFIGURATION and PARTIAL CONFIGURATION (policy-only) proving cases for the missing-policy boundary correction, re-run independently against real Postgres.

**Existing regression**: `__tests__/predictions.test.ts` (46 tests, all passing — four were updated to assert against the new ledger instead of the old one, since the old one no longer receives writes; none were deleted; one new test, "gaming_progression_events receives no new writes," makes that fact explicit) and `__tests__/predictionsSupabaseRepository.contract.test.ts` (4 tests, all passing, same treatment) both required one new setup step across every match fixture — declaring `RANKED` classification before predicting — which is a genuine new precondition this phase introduces, not a regression in evaluation math.

**Precise wording, corrected**: `finalize_match_result_atomically` and `correct_match_result_atomically` were *not* left byte-for-byte unchanged — both were replaced (drop-then-recreate, `0091`/`0092`), and their bodies now author a Finalized Experience Summary and call Metagame consequence-processing in place of the old direct `gaming_progression_events` inserts. What *is* unchanged, and is what the passing test suite actually proves: the four-dimension correctness evaluation math (`evaluations` computation — scoreline, goalscorer, goal minute, first-team-to-score, own-goal credit derivation), the `evaluations` row shape and versioning-by-new-row-never-mutate discipline, and Prize Qualification's own supersession/redemption semantics are all identical to their pre-Phase-1 behavior. The actual Product-visible change is exactly two things: a Match now requires a pre-play Activity Classification before it will accept a Prediction, and the XP consequence of a settled Prediction is now decided by the new Summary/Metagame boundary instead of being computed inline by Predictions' own function.

## Operational simulation

Run twice: once as an ad-hoc SQL smoke test directly against local Postgres during initial development (a full Table Foundation → Hand A normal game → correction sequence, confirmed evaluation/summary/XP math correct on the first real execution before any TypeScript layer existed), and again as the two committed automated test suites above, which subsume and formalize it. The founder's own suggested 19-step proving case is fully covered across those two test files: Gaming Member + RANKED Match + explicit policy/rule fixtures + Prediction submission + pre-kickoff revision (occurred_at unchanged) + finalize + Summary/XP verification + a second same-day Experience proving the configurable allowance + a Result correction + performance reversal and reissue verification + corrected total verification + Prize Qualification confirmed independent + a direct participation-reversal case confirming the allowance is restored + confirmation the legacy ledger received no writes.

## Missing-policy boundary correction (post-implementation)

Discovered during a subsequent Local-to-Production Readiness Gate and corrected under a separate founder directive, before this record was ever staged: `process_experience_summary_consequences_atomically` and its in-memory counterpart originally raised a hard exception (`NoParticipationPolicyConfiguredError`/`NoXpRuleConfiguredError`) whenever no applicable category participation policy or XP rule was configured. Because this function runs as a nested call inside the calling Experience's own transaction, that exception rolled back the *entire* transaction — including Evaluation and Prize Qualification, which have nothing to do with XP. Since Soccer Predictions always reports `meaningful_participation: true`, this meant any real settlement in an environment with zero configured XP policy failed outright.

Corrected boundary, now enforced in both `0090` and `InMemoryMetagameRepository`: absence of a category participation policy, a PARTICIPATION rule, or a PERFORMANCE rule for a given `performance_band_key` is a valid, silent no-op — never an error. Explicitly:

- **missing XP configuration is a valid no-consequence state**, not an invalid Experience result;
- **Experience finalization never depends on XP configuration existing** — Result, Evaluation, Finalized Experience Summary, and Prize Qualification all succeed identically whether or not any policy/rule row exists;
- **empty `gaming_category_participation_policy`/`gaming_xp_rules` tables are safe at deployment** — no Product XP numbers or daily allowance number are required for the schema to go live;
- **deploying the Metagame infrastructure does not activate XP awards** — those are separate decisions; XP only begins appearing once URBANO Gaming explicitly configures an applicable policy/rule;
- **no retroactive XP backfill is authorized** — a rule configured after the fact never reaches back to award XP for historical Summaries that predate it; any such mechanism would require separate, explicit Product authorization.

No fallback point values, no fabricated allowance, and no zero-value seeded rules were introduced to satisfy this correction. The same-transaction architecture is unchanged; only what counts as an error versus a valid no-op within that transaction changed. Full verification evidence (test matrix, isolated re-runs against real Postgres, production-ceiling reconfirmation) is recorded in the correction's own gate report, not duplicated here.

## Local automated totals

`npx tsc --noEmit` — clean. `npm test` — **452/452** (423 pre-existing + 29 in `persistentMetagame.test.ts`, including the missing-policy boundary correction matrix), stable across consecutive runs. `npm run test:contract` (target explicitly printed and confirmed `http://127.0.0.1:54421` before every run) — **86/86** (78 pre-existing + 8 in `persistentMetagameSupabaseRepository.contract.test.ts`); one unrelated, pre-existing `segmentSupabaseRepository.contract.test.ts` test showed a single transient "invalid response from upstream server" failure on one run during original Phase 1 development, immediately reproduced clean in isolation and in a full clean rerun — not touched by this phase, not a regression. `npm run build` — clean. `git diff --check` — clean. A full `supabase db reset --local` (all 92 migrations, from scratch) completed with zero errors, including after the missing-policy boundary correction to `0090`.

## Deviations from this authorization

The anticipated migration count grew from the originally-sketched 8 (`0082`–`0089`) to 11 (`0082`–`0092`), because implementation surfaced three needs the sketch hadn't separated: a dedicated `set_match_activity_classification_atomically` function (rather than a bare `UPDATE`, needed to enforce the lock atomically under the same row-lock discipline every other atomic function in this codebase already uses); `record_experience_summary_atomically` and `process_experience_summary_consequences_atomically` as two separate functions rather than one combined one, matching the founder's own explicit "Experience reports facts / Metagame selects consequences" two-step flow diagram literally; and `upsert_prediction_atomically`'s own replacement (`0084`) as a distinct migration, since adding the classification-gate check to the existing live function is itself one atomic, reviewable change. No historical migration was rewritten; every new migration is additive or a full function replacement following this repository's own established drop-then-recreate precedent.

## Unresolved Product questions (carried forward from the design gates, not resolved by implementation)

Whether `occurred_at` for Predictions should be submission time (implemented) or Match kickoff time was resolved by explicit founder decision before implementation began. Two items remain genuinely open, noted here rather than guessed at: the real numeric daily participation allowance and every real XP rule value remain entirely unconfigured (`gaming_category_participation_policy`/`gaming_xp_rules` hold zero real rows anywhere outside test fixtures); and whether a future allowance greater than 1 needs the count-based mechanism extended further (it already is a count, not a bare unique-constraint collision, so no further architecture change is anticipated, but this has only been proven at N=1 and N=2).

## Explicit non-implemented items

Confirmed absent from this diff, per the explicit non-goals list: Category rating algorithms, Category leaderboard, Achievements/catalog, Poker XP, Trivia XP, Quiz XP, Open Response XP, Voting XP, the Global Gaming XP leaderboard read model, any real daily-cap number, any real XP point value beyond test fixtures, field-strength formulas, geography, friends/social graph, external-result trust implementation beyond the four-tier taxonomy already named in Product authority, Lifestyle integration, XP spending/conversion, seasons, tournaments.

## Exact git/worktree state

Local repository only (`Software/urbano-gaming`), branch `integrate/join-session`. `git status --porcelain` shows exactly: the files listed under "Exact files changed" above, plus the same pre-existing, unrelated `QUIZ_EXPERIENCE_IMPLEMENTATION_RECORD.md`/`TRIVIA_GAME_COMPOSITION_IMPLEMENTATION_RECORD.md` drift and `supabase/config.toml`/`.gitignore`/`templates/` scaffolding present before this phase began. `git diff --check` is clean. Nothing is staged. Production migration ceiling independently reconfirmed at `0081` via `supabase migration list --linked` both before and after this phase's local work.

## Recommendation

**ACCEPT_LOCAL_IMPLEMENTATION**, including the subsequent missing-policy boundary correction. All required verification gates pass; the highest-named risk (allowance concurrency) is proven against real concurrent Postgres transactions, not merely reasoned about; three real defects were found and fixed before any test run recorded a false pass — the original two (side-pot-style effective-allowance counting and the TRAINING suppression gap), plus the missing-policy hard-failure coupling found in a later readiness gate and corrected as documented above. No production, migration, deployment, or configuration boundary was crossed. This record documents local implementation and correction acceptance only — it does not itself constitute a production-readiness determination; that remains a separate, later gate.
