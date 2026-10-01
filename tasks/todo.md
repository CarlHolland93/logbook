# logbook — todo

Plan mirrors SPEC.md §13. A step is done when its test runs, not when the code exists.

## 0. Decisions
- [x] Name: `logbook`
- [ ] Confirm npm scope
- [ ] Confirm the inversion: record is the product, card is the reference UI

## 1. Schemas and fixtures
- [x] `schema/card.schema.json`
- [x] `schema/record.schema.json`
- [x] Fixture cards: one valid decision, one prose fallback, three invalid (missing check_in; six evidence lines; recommended id not in options)
  - plus two invalid for the 09-30 schema fixes: duplicate option ids, decision card carrying `prose`
- [x] Fixture records: one per status, including expired and abandoned
  - plus four invalid: answered without `answered`, closed without `hypothesis`, closed without `outcome.source`, outcome_pending without `outcome`
- [x] CI: validate every fixture against its schema; invalid fixtures must fail (each for its named reason)
  - `.github/workflows/ci.yml` green on first push

## 2. Core on the mock adapter
- [x] `validate.ts`: schema validation + id checks (recommended ∈ options, unique ids) + the three semantic checks, returning `warnings[]` (check 4 dropped 10-01, see SPEC §5.2); `buildCard()` is the shared prose-fallback path for every adapter
- [x] `loop.ts`: state machine, snapshot-per-transition writer; `JsonlFileSink` in `src/sinks/` to keep `loop.ts` browser-safe
- [x] `adapters/mock.ts`: deterministic by context hash; two built-in outputs
- [x] Test: full loop shown → answered → chosen → outcome_pending → closed on the mock adapter; assert five lines in the log, last line has status closed
- [x] Test: abandoned and expired paths
- [x] Mutation-checked 09-30: reverting each schema fix / id check / holdout / override-reason guard turns a test red

## 3. OpenAI-compatible adapter
- [x] Model-facing card schema (`model-schema.ts`): no `card_id` / `schema_version` / `kind`, no `if`/`then`/`allOf`, no lookahead in `due_in`, no `maxLength` (Ollama truncates mid-word to satisfy it); `buildCard()` validates against the full schema
- [x] `openai-compatible.ts` with `response_format: json_schema`; probe once, fall back to prompt-only + strict validation
  - the probe checks the reply, not the HTTP status: Ollama answers 200 to a `response_format` it ignores
- [x] Versioned prompt template (`template_version`), wording pinned by hash in the test
- [x] Test against Ollama with one small model (`pnpm test:live`, llama3.2:3b on Ollama 0.35.0); test the prose fallback by feeding the validator garbage
- [x] Log `model.name` / `version` as the runtime reports them (Ollama digest, else `system_fingerprint`)
- [x] Mutation-checked 09-30: 12 guards in the adapter, model schema and template each turn a test red when broken
- Measured 10-01, 4 cases × 3 seeds, template t1 (word-count limits, nulls dropped): valid cards / cards with option ids borrowed from the prompt example
  - qwen2.5:7b: json_schema 10/12, 0 borrowed; prompt_only 9/12, 0 borrowed
  - llama3.2:3b: json_schema 11/12, 11 borrowed; prompt_only 7/12, 7 borrowed
- [x] Model choice for the example (step 6): `qwen2.5:7b` (4.7 GB). llama3.2:3b validates as often but copies the example's option ids into nearly every card
- Remaining json_schema failures on qwen are labels a word or two over 40 characters; the prompt says "2 to 5 words" because models cannot count characters
- [ ] `ComposeInput.candidates` is ignored by both adapters until the step 4 decision on pairs
- [ ] `model_declined` is in the card schema's prose reasons but nothing produces it

## 4. Scripts
- [x] Decided 10-01: card-vs-card pairs are not emitted in v1 (no evidence of a comparison in the record); `--card-vs-card` refuses. Open decision recorded in SPEC §12
- [x] Added `check_in.confirms` (required): which check-in answer means the signal came true. Without it the reliability plot has no y-axis
- [x] `materialise.ts`: last snapshot per record_id
- [x] `records-to-pairs.ts`: within-card pairs, labelled incl. `signal_confirmed`
- [x] `reliability.ts`: confidence × agreed × outcome on ~200 synthetic records → SVG (not PNG: no native deps, crisp, diffable); also pick rate per option
- [x] `synth.ts`: seeded synthetic log made by driving the real `Loop`; every snapshot validates
- [x] Test: pair counts on the fixture log (2) and the synthetic log ((options − 1) × chosen records)
- [x] Mutation-checked 10-01: 9 guards; two survivors fixed (redundant status check removed, holdout counts now asserted)
- Use `pnpm -s` when redirecting script output; pnpm's banner otherwise lands in the file
- At 200 records the holdout line has no drawable bin (10% holdout, 5 bins, min 5 cases). Say so in the README

## 5. React
- [x] Decided 10-01: the tap is logged at once; the override reason is a later snapshot via `loop.explain()` (SPEC §4, §5.3 rule 5)
- [x] `useLoop()` hook wrapping `loop.ts` through `subscribe()` + `useSyncExternalStore`; takes options or a shared `Loop`; `pending` / `error`, actions never throw into the UI
- [x] `PostSink` for the browser: keepalive when the record fits under the 64 KiB browser limit
- [x] Headless primitives: Signal, Evidence, Ask, Choice, CheckIn, Prose, plus OverrideReason (Ask reused); `<Card>` composer
- [x] Default skin (`src/skin/default.css`): light and dark, own tokens, band widths tested against `CONFIDENCE_BANDS`
- [x] Tests for the seven rendering rules, in `test/react.test.tsx` (jsdom)
- [x] Found by mutation-testing 10-01: overlapping `Loop` calls logged two choices for one card. `Loop` now refuses a transition while another is saving
- [x] Mutation-checked 10-01: 15 mutants across the rules, hook and loop guard; two survivors became tests, one was dead code and was removed
- [x] Looked at in Chromium, light, dark and 375px: no console errors, no horizontal scroll; options now equal height (rule 1)
- `evidence_expanded` is never written: the default skin does not collapse evidence
- Rule 1's "same size" is CSS, so only the screenshot check covers it, not the unit tests

## 6. Example
- [x] `examples/local-model`: one process (`server.ts`) serving the Vite app, the record server writing `records.jsonl`, the in-process check-in scheduler and a `/v1` proxy to the model (keeps any API key server-side)
- [x] Record store refuses writes that fail the schema (400) or cannot follow the record's last snapshot (409, via `followProblem` in `loop.ts`); writes are queued so two for one record cannot both pass
- [x] `--demo`: a shared, shiftable clock and a separate `records.demo.jsonl`, so demo timestamps never reach real data
- [x] Leaving the page abandons an undecided card (keepalive POST); found when a crashed run left a record at `shown`
- [x] `hypothesis.json` with example values
- [x] One command from clean clone against Ollama; `qwen2.5:7b` documented in `examples/local-model/README.md`
- [x] `test/example.test.ts`: the server over HTTP with a real `Loop` and a stand-in model (10 tests); mutation-checked, three survivors became tests
- [x] Driven end to end in Chromium against qwen2.5:7b 10-01: override + reason, second card, +1 week, both check-ins answered; 16 log lines, all valid successors; no console errors
- [x] One repair round in the adapter. Problems go back as path, value and rule; the record keeps `shown.repair` (problems + first reply); `input.messages` stays the original prompt; template bumped to t2; pairs carry `repaired`
  - Measured 10-01, 16 unseeded qwen2.5:7b cards: 12/16 valid before, 16/16 after (5 repaired, all over-long labels); repaired cards take about twice as long
  - Mutation-checked: 8 guards; one survivor (the validator's "must match then" noise filter) now pinned by an exact problem list
- Seen 10-01: a repaired card cited "delays ranging from 3 to 5 days" as data when the input said 3, 6, 4, 5. The semantic check confirms a cited ref exists, not that the line matches it; a quote-fidelity check is a possible later rung
- [x] Fixed a race in three React tests: they clicked a button in the moment it is disabled after a write (failed about 1 run in 7; 0 in 12 after)

## 7. Front door
- [x] Static demo on a stand-in model with a records pane (newest lines, the newest line as written, download of the whole log); `pnpm demo`, `pnpm demo:build` → `out/demo`
  - the example app moved to `examples/shared/` behind a `Backend` interface: HTTP for the local example, in-memory for the demo, same record store and checks in both
  - stand-in model returns a written card per example situation, through `buildCard` like a real reply; each is valid with no warnings
- [x] Checked in Chromium from the static build: every situation, override + reason, +1 week, check-ins, download (valid JSONL), light, dark, five widths with no horizontal scroll, no console errors
  - found and fixed: unwrapped JSON pushed the side panel off screen (grid children need `min-width: 0`); the demo called itself "example"
- [x] GIF of the card with the log growing beside it: `docs/demo.gif`, 22 s, 960 px, 3.7 MB
- [x] README: diagram, one real record line (qwen2.5:7b, repaired, closed on the demo clock), one derived pair, demo link, sixty-second pitch; snippet type-checked
- [x] `LICENSE` (MIT)
- [x] Pages workflow, manual only (`.github/workflows/pages.yml`); CI now builds the demo too
- [x] Reliability plot regenerated: the synthetic log changed shape in step 5 (reason as its own snapshot)
- Holdout rate checked after three of four GIF takes came up held out: 10.3% over 2,000 cards in Node, 4 of 40 in the browser. Bad luck, not a bug

## 8. Demo and example app
- [x] The demo and the local example are a chat, because that is where the card lives: an example conversation plays out, the assistant looks things up a step at a time, and the card arrives as its reply. The follow-up arrives later as a new message in the same thread
- [x] The conversation is data as well as display: `buildMessages({ question, history })`, template t3, so the record's prompt holds every turn
- [x] `<Card status={false}>` so a chat host can say the status as its own message; `<CheckIn>` rendered as a separate message
- [x] A second window, "What is being stored": the conversation word for word (`input.messages`), then each step beside its field (`shown.card`, `answered`, `chose`, `chose.override_reason`, `outcome`), the number of lines written to `records.jsonl`, the raw record and a download
- [x] A held-out card keeps its recommendation out of that window until the choice is made
- [x] Local example: scripted opening and a real card; a typed question works; the records the assistant can look up are editable
- [x] Default skin: one surface, evidence as a timeline whose nodes repeat the basis, options as one list with the recommendation marked at the side
- [x] Re-measured qwen2.5:7b with the conversation in the prompt: 12 of 12 valid cards
- [x] Checked in Chromium: demo and local example, six widths with no horizontal scroll, reduced motion, the skin standalone in light and dark, options equal in size within every card
- [ ] One decision per conversation. A thread with several decisions needs past cards kept on screen read-only

## Publishing
- [x] Schema `$id`s point at the copies published with the demo (`.../schema/0.1/`)
- [x] GitHub Pages serves the demo, deployed by the `pages` workflow
- [ ] Decide whether to publish the package to npm, and under which scope

## Review
_Fill in when shipped: what landed, what was cut, caveats._
