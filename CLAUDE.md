# Claude Operating Context — URBANO Gaming

This file is the repository-level operating contract for Claude. Read it before taking any implementation action.

## Current Identity

- Product: **URBANO Gaming**
- Legal and organizational owner: **TecnoMovi**
- Product lineage: `TecnoMovi → URBANO → URBANO Gaming`
- Canonical local repository: `Projects/Urbano Gaming/Software/urbano-gaming/`
- Canonical GitHub repository: `hiltontoro/urbano-gaming`
- Production: `https://urbano-gaming-playtest.vercel.app`
- Supabase project display name: `URBANO Gaming`

`Level 33`, `level33-mvp`, and old deployment URLs are historical terminology. Preserve them in event-time evidence and Git history, but never use them as current or public identity. No future Level 33 mode exists unless a separate Genesis or ADR authorizes it.

## Activation Source

Read `BOOTSTRAP_PACKAGE_Claude_URBANO_Gaming_Reentry_v1.0.md` first. It supersedes stale activation and current-state claims in older bootstraps or transfers. Historical implementation evidence remains valid for the event it records.

## Required Reading Order

1. `BOOTSTRAP_PACKAGE_Claude_URBANO_Gaming_Reentry_v1.0.md`
2. `PROJECT_STATUS.md`
3. `HANDOFF.md`
4. `PLATFORM_CAPABILITY_REVIEW.md`
5. `ENGINEERING_PATTERNS.md`
6. `README.md`
7. `../../Architecture/Architecture_Decision_Record.md`
8. `../../../../Knowledge OS/Repository_Migration_Manifest.md`
9. `../../../../Knowledge OS/Transfers/Knowledge Transfers/KT-URBANO-GAMING-2026-001_Level_33_MVP_Implementation_Continuity.md` for historical implementation genealogy

Resolve all paths from this repository. If a referenced source is unavailable, report it rather than inventing its contents.

## Authority Order

1. Explicit founder instruction from Hilton Toro.
2. Frozen URBANO constitutional artifacts within their owning subjects.
3. Accepted URBANO Gaming architecture and ADR genealogy.
4. Current Slice or implementation authorization.
5. Repository implementation evidence, tests, and engineering patterns.
6. Historical transfers and implementation records.

Later current authority controls when sources conflict. Historical sources remain evidence; they do not regain current authority through age or detail.

## Ownership Boundaries

Claude may implement, test, review, document, and deploy URBANO Gaming software when explicitly authorized.

Claude must not independently:

- redefine URBANO’s Brandbook, Operations Book, Business Model, Reward Economy, or Partner Package Architecture;
- decide commercial deployment, partner qualification, pricing, legal, or marketing policy;
- treat game rewards as authority for the wider URBANO Reward Economy;
- create a future Level 33 mode;
- absorb Roberto’s authority as TecnoMovi lead engineer;
- expose secrets, service-role credentials, tokens, or private user data;
- rename or delete historical evidence merely to improve consistency.

Return cross-workspace contradictions through a Knowledge Transfer or Evidence Transfer Package when they genuinely affect another owner.

## Current Implementation Baseline

- Branch: `integrate/join-session`
- Canonical remote branch: `origin/main`
- Pre-bootstrap implementation baseline: `dafafb9`; the active HEAD may contain the committed Claude re-bootstrap documents above this ancestor.
- Slices 001–006 are implemented.
- UI Convergence Tier 1, Structural Tier 2, Experience Layer v1, host hierarchy refinements, and URBANO Gaming identity normalization are committed.
- Database migrations exist through `0029`.
- MIG-005 is complete across the local repository, GitHub, Vercel, and Supabase.
- The architecture freeze governs repository structure but does not prohibit authorized product implementation.

No new implementation Slice is authorized by this file. Recommendations such as Experience Composition remain recommendations until the founder explicitly selects or authorizes work.

## Implementation Method

Before changing code:

1. Inspect Git status, branch, recent commits, and relevant implementation records.
2. Distinguish a defect, bounded implementation task, Slice, experiment, and architectural change.
3. Identify the governing authority and whether the task is actually authorized.
4. Preserve validated behavior and historical evidence.
5. State contradictions or missing authority before implementing across a boundary.

During implementation:

- follow the domain → repository interface → in-memory/Supabase implementations → thin API route pattern;
- keep state transitions atomic in Postgres where partial completion would be unsafe;
- add behavioral tests and, where database behavior changes, contract evidence;
- update the explicit `npm test` file list when adding a new test file;
- keep credentials outside source control;
- treat migrations as append-only after deployment;
- avoid force-pushing or rewriting accepted history.

Before completion:

```text
npm test
npx tsc --noEmit
npm run build
```

`npm test` is the complete in-memory behavioral suite and must include every behavioral test file explicitly. Do not use an unscoped `npx vitest run` as a supposedly local check: in this repository it also discovers the live Supabase contract suite. Run `npm run test:contract` only when live Supabase mutation is authorized and the correct environment is available. Deploy only when explicitly authorized, then verify the canonical URBANO Gaming production URL.

## Re-entry Instruction

On a fresh Claude session:

1. Read the required sources.
2. Verify that the repository identity, branch, remote, HEAD, working tree, and public deployment match this bootstrap.
3. Classify pre-existing untracked or modified files without discarding them.
4. Report any drift.
5. If the baseline is valid, declare **Bootstrap Ready** and begin only the founder-authorized task.

Do not restart architecture normalization. Do not continue from an obsolete Level 33 path. Do not infer the next Slice from a recommendation.
