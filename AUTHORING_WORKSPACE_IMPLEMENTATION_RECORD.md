# Authoring Workspace — Implementation Record

## Objective (as accepted)

Replace the one-at-a-time Multiple Choice authoring form — which real playtest usage had already pushed past its limits, to the point that `PLAYTEST_READINESS.md` recommended a DevTools console workaround for more than a handful of questions — with a small Authoring Workspace that separates three distinct workflows (Create, Import, Review), scales to 100+ items without becoming an unwieldy page of live forms, and keeps the workspace itself engine-agnostic so a future Interaction Engine (Pictionary, Photo Challenge, ...) can plug in its own editor without the workspace changing.

No backend, migration, or domain-layer change. This is a `host.html`-only slice — `PREPARE_QUESTIONS` / `prepareQuestions()` / `createPreparedQuestions()` are called exactly as before.

## Design decisions carried into the implementation

- **Workspace vs. editor**: the workspace (`draftItems`, the queue, import, filter, save) never references a Multiple-Choice-specific field. Everything that needs to know what an item's fields actually are goes through `ITEM_EDITORS[item.engineType]` — today exactly one key (`MULTIPLE_CHOICE`), each with `createBlank()`, `validate()`, `summary()`, `renderFields()`. A second engine adds a second key; nothing else in the workspace changes.
- **Three distinct workflows, not one form wearing three hats**: a dedicated, persistent "Create New Item" compose card; a separate "Import Many Items" paste box; a "Review Queue" that is a compact, scannable list by default. Creating and editing share the same underlying `renderFields()` function (no reason to hand-duplicate field markup), but they are different entry points — Create is never repurposed as the queue's own edit mechanism.
- **Scale**: at most one queue row is ever expanded into its full editor at a time (`expandedDraftIndex`). Editing a field mutates the item directly and updates only that row's warning state and the Save button — it never re-renders the whole queue (which would tear down and rebuild the very inputs being typed into, reintroducing the exact destructive-rerender bug already fixed once in this codebase for the old option-row logic). A client-side filter (`itemFilterText`) narrows the visible rows without touching the underlying array.
- **Import format**: structured tables (tab-delimited, native to copying a spreadsheet/Notion/Airtable selection; pipe-delimited as the fallback, chosen specifically because a chat UI's copy behavior often collapses literal tabs but reliably preserves `|`). Correct answer is matched by *text* against that row's own options, not by index — closer to how someone fills out a spreadsheet by hand. A first row that fails to parse while later rows succeed is treated as a header and dropped silently rather than reported as broken.
- **Import is forgiving, not all-or-nothing**: a row that doesn't resolve cleanly (e.g. its correct-answer column doesn't match any option) still becomes a queue item — flagged, editable in place via the same `Edit` action as any other item — rather than rejecting the whole pasted batch over one bad row. This is a deliberate departure from `PREPARE_QUESTIONS`'s own all-or-nothing contract: importing into the workspace and actually persisting are different operations with different stakes, and only the latter needs to block on validity (`Save Items` stays disabled while any flagged item remains).
- **Copy AI Prompt**: a canned, pipe-delimited-format prompt copied to the clipboard, so content from ChatGPT/Claude lands in exactly the same import path as a spreadsheet paste — deliberately not an attempt to parse arbitrary AI prose.
- **Terminology**: the workspace's own vocabulary (item, queue, Create/Import/Review) is engine-agnostic, in both UI copy and code (`draftItems`, not `draftQuestions`). Multiple Choice's own field names (Question, Options, Correct Answer, Points) stay exactly as concrete as they are — genericizing the data shape was explicitly out of scope.

## Files changed

- **`public/host.html`** — the entire "Trivia Questions" card replaced with the Authoring Workspace (Create New Item / Import Many Items / Review Queue / Save Items), `ITEM_EDITORS.MULTIPLE_CHOICE` added, old global one-at-a-time form logic (`qf-*` ids, `optionRowCount`, `addDraftQuestion`/`renderDraftQuestions`/`saveQuestions`) removed entirely, `switchToNewSession()`'s reset block updated for the new state (`draftItems`, `expandedDraftIndex`, `itemFilterText`, `createDraftItem`), two new CSS rules (`.draft-item-row.invalid`, `.notice-info`) plus small additions for the filter input and import card.

Nothing else changed — no migration, no `lib/session/*` change, no API route change, `participant.html` untouched (authoring is host-only).

## Validation Evidence

- **Type-check** (`npx tsc --noEmit`): clean.
- **Full test suite** (`npx vitest run`, including the live contract suite): 208/208 passing — unaffected, as expected for a client-only change.
- **Production build** (`npm run build`): clean.
- **Live verification**, against the running dev server and a real Supabase-backed session:
  - Created an item via **Create New Item** (prompt, two options, correct-answer selection) — landed correctly in the queue as a compact summary row, and the compose form reset itself for the next item.
  - Pasted a tab-delimited block via **Import Many Items** containing a header row, one well-formed row, and one row missing a points column with numeric options — the header was correctly dropped, the well-formed row parsed with the right correct answer and points, and the numeric-options row correctly resolved through the points/correct-answer fallback logic (verified directly against `buildItemFromColumns()` as well as through the UI).
  - Pasted a deliberately broken row (correct-answer text matching none of its options) — it was added to the queue **flagged**, not rejected, with `Save Items` correctly disabled while it remained invalid.
  - Opened that flagged row via **Edit**, corrected the answer selection — the row's invalid state cleared and `Save Items` re-enabled immediately; confirmed the other option fields' values were untouched by the edit (the destructive-rerender bug class did not reappear).
  - Filter box: typing "planet" correctly narrowed the queue to only the matching item; clearing it restored the full list.
  - **Save Items** with all three items valid → `PREPARE_QUESTIONS` returned `200`, the queue cleared, and the persisted "Question Queue" display showed all three questions with correct answers and point values, `Start Next Question` became available — full round-trip confirmed against the live backend.

## Known deferred items (unchanged from the design review, not addressed by this slice)

- Reordering queued items.
- Editing or reordering already-*saved* (persisted) prepared questions.
- Reusable content collections spanning sessions.

## Note found during the prior architectural review, unrelated to this slice

`package.json`'s `test` script explicitly enumerates test files and does not include `__tests__/createSuccessorSession.test.ts` (it runs correctly under plain `vitest run`, just not under `npm test`). Not touched here since it's outside this slice's scope — flagging again since it's still unresolved.

## Addendum: First-Time-Host Walkthrough

Before committing, a deliberate walkthrough of the complete authoring experience — empty session, ~20 items authored across every workflow (Create, Import, Review, Edit, Remove, Filter, Save) — looking only for UX friction, not correctness. Two real defects and four smaller friction points were found; all six were judged high-leverage enough to fix without expanding scope. Ranked by leverage:

1. **Option 1 was pre-selected as the correct answer on every new Create item.** A host who didn't notice or think to change it could save a wrong answer with no validation error, since a technically valid selection was always present. Fixed by defaulting `correctOptionIndex` to `null` — `validate()`'s existing check already rejects that, so an explicit choice is now required with no other logic change.
2. **`Remove` was styled identically to `Edit`** (`btn-ghost`, sitting directly adjacent) despite being the one destructive, unrecoverable action in the row. Restyled to `btn-danger`, matching this file's own existing convention (`End Session`) rather than introducing a new one. A confirmation dialog was considered and deliberately not added — `Remove` is also the normal way to discard an intentionally-flagged bad import row, and a dialog on every use would add friction to that common, correct case; visual distinction was judged sufficient.
3. **`Save Items` was silent on success.** The draft queue simply emptied with no confirmation, leaving a first-time host to notice, unprompted, that a *different* section further down the page had changed. Fixed with a brief confirmation notice — which surfaced a second, real bug: `hostRefresh()` unconditionally clears the notice banner on every successful poll, so the confirmation was being wiped out before it could ever be seen. Fixed by showing it *after* the post-save `hostRefresh()` call rather than before; it now stays visible until the next automatic sync tick.
4. **`Save Items` simply disabled itself while any item was flagged**, leaving "N need attention" as the only clue — at 20 items, finding which one meant scanning the whole list. Changed so clicking it while items are invalid jumps straight to (expanding, scrolling to) the first flagged item, clearing an active filter first if it would otherwise hide it.
5. **"Create New Item" was encountered before "Import Many Items"** in reading order, despite the entire reason this slice exists being that the one-at-a-time form doesn't scale — a host skimming top-down could commit to the slow path before ever reaching the fast one. Reordered; no logic change.
6. **The import textarea's placeholder only demonstrated the tab-delimited format**, with no visible link to the pipe-delimited format the "Copy AI Prompt" button actually produces. Added one line of caption text stating both are accepted.

Considered and deliberately left alone: "Add to Queue" vs. "Save Items" wording (judged already disambiguated by the repeated "Queue" language throughout); an empty-state hint for an empty Review Queue (too short-lived in practice to matter); auto-scrolling to a newly created item (mitigated by fix 5 de-emphasizing manual entry as the bulk-authoring path); the exact wording of which column's text a flagged import row's error message quotes when both parsing interpretations fail (the flagging itself is correct either way, and `Edit` is the fix regardless of phrasing); and the `Copy AI Prompt` label's clarity (judged adequate from its surrounding context).

Re-verified after these fixes: `tsc`, the full test suite, and `npm run build` all clean; a fresh live walkthrough (empty session → 19 items via Create + Import, one deliberately broken → Remove/Edit/Filter exercised → Save correctly redirected to the flagged item → fixed it → Save again → confirmation shown, persisted queue correct).
