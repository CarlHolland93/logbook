# logbook — spec

**Status:** v0.1 draft. A pattern with one reference implementation. Not a standard, not a protocol.
**Licence:** MIT.
**One line:** No training set? Let behaviour build one.

---

## 1. Thesis

A decision-support product built on an open-weight model usually starts with no data. This pattern makes the product itself the data-collection instrument:

- One decision people already make.
- A card with five fixed primitives, assembled by the model per case.
- A record of what the model was given, what the person saw, what they answered, what they chose, and what happened.

The record is the product. The card is the reference UI that produces it.

Three questions the pattern has to answer, and where each is answered:

| Question | Answered by |
|---|---|
| How do you start from what people do? | §3 Hypothesis → Behaviour → Primitives |
| How do you keep the loop going with little data? | §5 Card rules (basis tags, confidence band, ask) and §7 Adapter (rules of thumb first) |
| How does learning happen? | §6 Record and §8 Learning ladder |

---

## 2. Who this is for

**For:** product teams shipping a decision-support feature on a self-hosted or open-weight model (Ollama, vLLM, llama.cpp server, TGI, LM Studio), with no ML team and no labelled data.

**Not for:**

- Model companies. There is nothing here to badge or benchmark.
- General generative UI. If the model needs to lay out arbitrary interfaces, use json-render or A2UI. This pattern can be expressed as a catalog on either; see §9.
- Decisions that are not a single choice. v1 is a **single-choice decision card**: one signal, two to four options, one follow-up. Ranking, "how much", and side-by-side comparison do not fit and are out of scope.

---

## 3. Start from what people do

The stack reads bottom-up. Each layer picks the one above it.

### 3.1 Hypothesis

One line, five slots, stored as `hypothesis.json` and copied into every record:

```
In [context], if [who] sees [what] sooner, then [what_changes], by [by_how_much].
```

| Slot | What it fixes |
|---|---|
| `context` | The situation the card appears in. Keeps the model's prompt narrow. |
| `who` | The role that decides. One role per deployment. |
| `what` | The signal. What the card's headline is about. |
| `what_changes` | The behaviour you expect to move. |
| `by_how_much` | The measure. Should be observable from `check_in` or a system of record. |

If you cannot fill all five slots, you do not have a decision yet; you have a dashboard.

### 3.2 Behaviour

Five things the person already does, observed not invented. Each one earns exactly one primitive:

| Behaviour | Primitive it earns |
|---|---|
| Scans for risk | 1 Signal |
| Wants the why before trusting it | 2 Evidence |
| Knows context no system records | 3 Ask |
| Makes the call | 4 Choice |
| Looks back | 5 Check-in |

If a behaviour is not present in your context, drop its primitive rather than invent the behaviour. (`ask` is optional per card for this reason; the other four are required in v1.)

### 3.3 Primitives

Few, dumb, consistent. The model assembles; it never invents.

| # | Primitive | Speaks or listens | Renders as |
|---|---|---|---|
| 1 | Signal | speaks | headline + confidence band |
| 2 | Evidence | speaks | one to five lines, each with a basis tag |
| 3 | Ask | **listens** | a question with a text field or two to four chips |
| 4 | Choice | **listens** | two to four option tiles, at most one highlighted |
| 5 | Check-in | **listens** | a follow-up question delivered after `due_in`; one answer is marked as confirming the signal |
| — | Prose | fallback | plain text, when the model's output does not validate |

The three that listen are where the training set comes from.

---

## 4. The loop

```
        ┌────────────── What we think ──────────────┐
        │                                            ▼
     Model                    Card                Person
        ▲                                            │
        └── What happened ◄──── Agreed or overrode ──┘
```

State machine for one record:

```
shown ──► answered ──► chosen ──► outcome_pending ──► closed
  │           │                          │
  │           └──────────────────────────┼──► abandoned  (no choice within session)
  └──────────────────────────────────────┘
                                         └──► expired    (check-in not answered by due + grace)
```

| Transition | Trigger | Record fields written |
|---|---|---|
| → `shown` | adapter returns a card; UI renders it | `input`, `model`, `shown` |
| `shown` → `answered` | person answers or skips `ask` | `answered` |
| → `chosen` | person taps an option | `chose` (with `override_reason` if `agreed = false`) |
| `chosen` → `outcome_pending` | immediately after `chosen` | `outcome.due_at = chose.at + check_in.due_in` (the only `outcome` field until the record closes or expires) |
| `outcome_pending` → `closed` | person answers the check-in, or a system-of-record metric arrives | `outcome` with `source = self \| system` |
| `outcome_pending` → `expired` | `due_at + grace` passes unanswered | `outcome.source = none` |
| `outcome_pending` → `outcome_pending` | person gives a reason for an override (optional, once) | `chose.override_reason` |
| any → `abandoned` | session ends without a choice (the example logs it when the page is hidden) | — |

Every transition appends a full snapshot to `records.jsonl`. The last line per `record_id` is the current state. Transitions on one record never overlap: a call made while another is still being saved is refused, so two snapshots can never both claim to be the next state.

**Check-in delivery is part of the pattern, not an integration detail.** A deployment that cannot deliver the check-in cannot close the loop and should say so. The reference example ships an in-process scheduler; production deployments route `due_at` into whatever they already use for notifications.

---

## 5. Card contract (model → UI)

Schema: [`schema/card.schema.json`](schema/card.schema.json), published with the demo at `https://carlholland93.github.io/logbook/schema/0.1/card.schema.json`, which is also its `$id`. Summary:

```jsonc
{
  "schema_version": "0.1",
  "card_id": "…",
  "kind": "decision",                       // or "prose"
  "signal":   { "headline": "…", "level": "high", "confidence": 0.72 },
  "evidence": [ { "text": "…", "basis": "data", "ref": "ctx_14" },
                { "text": "…", "basis": "rule_of_thumb" } ],
  "ask":      { "question": "…", "kind": "text" },               // optional
  "choice":   { "options": [ { "id": "act_now", "label": "Act now" },
                             { "id": "wait",    "label": "Wait" } ],
                "recommended": "act_now" },
  "check_in": { "question": "Did it happen?", "due_in": "P3D",
                "options": [ { "id": "yes", "label": "Yes" }, { "id": "no", "label": "No" } ],
                "confirms": "yes" }                 // which answer means the signal was right
}
```

### 5.1 Structural rules (blocking)

Enforced by the schema:

- Render order is fixed: signal, evidence, ask, choice, check-in. JSON key order is irrelevant.
- `ask` may be omitted. Nothing else may be omitted, added, or renamed. A decision card never carries `prose`.
- `evidence`: one to five lines; every line has a `basis` from `data | rule_of_thumb | you | unknown`.
- `choice`: two to four options.
- `check_in.due_in` is an ISO 8601 duration measured from `chose.at`.
- `check_in.confirms` names the check-in option that means the signal came true. Without it the log cannot score confidence against outcomes (§8).

Enforced by `validate.ts`, because JSON Schema cannot compare one field to another:

- `choice.recommended` is one of the option ids, or `null`; `check_in.confirms` is one of the check-in option ids.
- Option ids are unique within `choice`, `ask` and `check_in`.

Anything that fails either list becomes `{ "kind": "prose", "prose": { "text": …, "reason": "schema_violation" } }`. The UI never shows a broken card and never hides that it fell back.

### 5.2 Semantic checks (enforced by the adapter, logged, not blocking)

Constrained decoding makes structural validity nearly free. These are the failures that matter:

- `basis = data` without a `ref` that exists in `input.retrieval_ids`. Fabricated evidence.
- `basis = you` on a card with no `ask`. The model claims the person told it something it never asked.
- `confidence` outside the band the `level` implies (`low` ≤ 0.4, `medium` 0.3–0.7, `high` ≥ 0.6). Overlap is deliberate.

A fourth check, "a recommendation with no real alternative to wait / do nothing", was dropped: act-or-wait is the most common real decision, and whether an alternative is real shows up in the log as an option nobody picks. The reliability script reports pick rate per option instead.

Each check writes a `warnings[]` entry on the adapter result; the reference UI surfaces a count in the dev skin only.

### 5.3 Rendering rules (enforced by the reference UI)

These are the diagram's rules turned into code. A skin may restyle them; it may not remove them.

1. **Override is one tap.** The recommended option is highlighted; every other option is the same size and one tap away. No confirm step on override.
2. **Holdout.** A configurable share of cards (default 10%) renders without the highlight. `shown.highlight_shown` records which. Without this you cannot separate preference from the nudge.
3. **Confidence is a band, not a point.** The bar shows the range the card's `level` stands for (`low` 0 to 0.4, `medium` 0.3 to 0.7, `high` 0.6 to 1): solid up to the band, lighter across it. Every card at one level looks the same, so `signal.confidence` never reaches the screen; the raw float goes to the log, where it can be calibrated later without changing the UI.
4. **Every evidence line shows its basis.** The tag is visible, not a tooltip. The default skin sets the lines as a short timeline, each a node joined to the next, and the node repeats the basis as a shape (solid for data, a ring for a rule of thumb, dashed for unknown); the text tag stays.
5. **Override asks why.** When `agreed = false`, the Ask primitive is reused for `override_reason`. Skippable, never blocking: the tap is logged first, so `time_to_choose_ms` measures the decision alone and a person who leaves at the question still leaves a choice in the log. The reason lands as a later snapshot. The question is worded the same with or without the highlight, so it never reveals a held-out recommendation.
6. **Check-in always has "Can't tell".** The UI appends `cant_tell` to `check_in.options`. Forced yes/no is how you get confident wrong labels.
7. **Prose fallback is visibly a fallback.** Plain text, no primitives, a small "couldn't build the card" note.

---

## 6. Record contract (UI → log)

Schema: [`schema/record.schema.json`](schema/record.schema.json). This is the part worth copying even if you use none of the code.

```jsonc
{
  "schema_version": "0.1",
  "record_id": "…", "card_id": "…",
  "status": "closed",
  "created_at": "…", "updated_at": "…",
  "actor":  { "user_hash": "…", "role": "…" },
  "input":  { "messages": [ … ],                  // the full prompt, not a reference
              "template_version": "t3",
              "card_schema_version": "0.1",
              "sampling": { "temperature": 0.2, "seed": 7 },
              "retrieval_ids": [ "ctx_14", "ctx_15" ],
              "context_hash": "…",
              "hypothesis": { "context": "…", "who": "…", "what": "…", "what_changes": "…", "by_how_much": "…" } },
  "model":  { "name": "…", "version": "…", "provider": "openai_compatible" },
  "shown":  { "card": { … }, "highlight_shown": true, "latency_ms": 840, "at": "…" },
  "answered": { "kind": "text", "text": "…", "at": "…" },
  "chose":  { "option_id": "wait", "recommended_id": "act_now", "agreed": false,
              "override_reason": "…", "time_to_choose_ms": 6400, "at": "…" },
  "outcome": { "source": "self", "option_id": "no", "due_at": "…", "at": "…" }
}
```

### 6.1 Why each part is there

| Field | Why it cannot be left out of v1 |
|---|---|
| `input.messages` (inline) | A reference to context goes stale in weeks. Without the prompt side, no record can become a training example. This is the only field that cannot be backfilled. |
| `input.template_version`, `sampling` | Same reason. Two records with different templates are not the same distribution. |
| `shown.highlight_shown` | Separates "preferred this" from "tapped the highlighted thing". |
| `chose.recommended_id` + `agreed` | The preference signal, kept honest by the field above. |
| `chose.override_reason` | An override without a reason is one bit. With a reason it is a label. |
| `chose.time_to_choose_ms` | Sub-second agreement on a highlighted option is not a considered preference. Lets you down-weight it. |
| `outcome.source` | Self-report by the person who chose is not the same as a system-of-record measurement. The log says which you have. |
| `shown.candidates[]` (optional) | Chosen-vs-rejected *options* inside one card are a within-set ranking signal, not a generation preference. Card-vs-card pairs need two sampled cards. Candidates mode records them. |
| `input.hypothesis` | Each record knows what it is measuring, so records from different deployments never get pooled by accident. |
| `shown.repair` (when present) | The card came from a second turn. A training set can keep it (it is a valid answer to the prompt) or drop it, and each first reply beside its fixed card is a ready-made example of a bad card. |

### 6.2 Storage

- One file: `records.jsonl`, append-only, one snapshot per transition, last line per `record_id` wins.
- No PII in the log: `actor.user_hash` only; `override_reason` and `answered.text` are free text and should be treated as sensitive by the deployment.
- Consumers materialise with a ten-line script (`scripts/materialise.ts`). Anything beyond a file is out of scope for v1.

---

## 7. Model adapter

```ts
interface Adapter {
  compose(input: ComposeInput): Promise<ComposeResult>;
}
type ComposeInput  = { messages: Message[]; hypothesis: Hypothesis; retrievalIds?: string[]; candidates?: 1 | 2 | 3 };
type ComposeResult = { card: Card; candidates?: Card[]; model: ModelInfo; sampling: Sampling; latencyMs: number; warnings: Warning[] };
```

**Default adapter: `openai_compatible`.** Chat completions with `response_format: { type: "json_schema", json_schema: … }`. Config is `BASE_URL`, `MODEL`, optional `API_KEY`. Covers the runtimes in §2; structured-output support and its exact flag vary by runtime and version, so the adapter probes once and falls back to prompt-only JSON with strict validation.

Three things the adapter does that are not obvious, each found by running it against Ollama:

- **The probe judges the reply, not the status.** A runtime without `json_schema` support tends to answer 200 and ignore the field. The probe asks for `{"probe":"ok"}` under a one-field schema and checks that it got exactly that.
- **The model gets a smaller schema than the UI does** (`model-schema.ts`, derived from `card.schema.json`). It has no adapter-owned fields (`card_id`, `schema_version`, `kind`) and no `if`/`then`/`allOf` or regex lookahead, which constrained decoders reject or silently drop. The full schema still judges the result.
- **No `maxLength` in the model's schema.** A constrained decoder enforces a length limit by cutting the text off mid-word, which produces a valid-looking broken card. The prompt states the limits; a card that exceeds them fails validation and becomes prose.

Two more, from the same runs, live in `validate.ts` so every adapter gets them: a null optional field (`"ask": null`, `"ref": null`) is treated as absent, since that is how models write "nothing here"; and limits are given to the model in words ("2 to 5 words") because it cannot count characters.

**One repair round.** When a reply fails validation, the adapter sends it back once, with each problem stated as path, value and rule ("`/choice/options/1/label` (\"Consider switching to a more reliable supplier\") must NOT have more than 40 characters"), and asks for the same card fixed. Only the second reply is used; if it fails too, the card is prose. The wording is part of the template, so changing it bumps `template_version`. The record keeps what happened in `shown.repair` (the problems and the first reply, verbatim), while `input.messages` stays the original prompt. On 2026-10-01 at the example's settings, this took `qwen2.5:7b` from 12 of 16 valid cards to 16 of 16; every repair was an over-long label, and a repaired card took about twice as long. `repair: false` turns it off.

An unreachable endpoint is also a prose card (`reason: adapter_error`), so the record shows what the person saw. `model.version` is the Ollama digest where the endpoint is Ollama, otherwise the `system_fingerprint` the runtime reports.

**Mock adapter.** Returns fixture cards, deterministic by `context_hash`. Used by tests and the hosted demo. Its existence is what proves the interface is model-agnostic.

**Prompt template.** Shipped, versioned (`template_version`), and short. It gives the model: the hypothesis, the input context with ids, the card's shape, and three rules: cite `ref` for `data`, use `rule_of_thumb` when there is no data, ask only when the answer would change the recommendation. When the card is the reply to a message in a conversation, the person's question follows the input in the user message ("The store manager asks: …"), and the earlier turns of the conversation go in between the instructions and that message, word for word (`buildMessages({ question, history })`). The record's prompt then holds the whole conversation as well as what was looked up. The shape is shown as one worked example from an unrelated domain plus the limits in words: small models copy placeholder text out of a skeleton. The template always carries the shape, so `input.messages` is the full prompt in both modes. A test pins a hash of the wording to `template_version`, so the text cannot change without a bump.

**Rules of thumb are how day one works.** With no data, evidence lines are `rule_of_thumb`, confidence is low, and `ask` does the work. The card's shape does not change as data arrives; only the basis tags and the confidence do.

---

## 8. Learning ladder

"Post-training" is the wrong word for the first year. What the log unlocks, in order, at the volumes a small product actually gets:

| Records | What you can do | Field that enables it |
|---|---|---|
| 0 | Regression eval set: replay `input` through a new model or template, diff the cards | `input.messages`, `template_version` |
| ~50 | Few-shot retrieval: put agreed, good-outcome cards into the prompt for similar `context_hash` | `chose.agreed`, `outcome` |
| ~200 | Reliability plot: `confidence` × `agreed` × `outcome`. Then calibrate (Platt / isotonic). | `signal.confidence`, `highlight_shown` |
| ~1,000 | Override classifier: predict `agreed = false` from input; use it to decide when to withhold the highlight | `chose`, `override_reason` |
| ≥1,000 clean | SFT on `input → shown.card` for records with `agreed = true` and `outcome` good | everything above |
| candidates mode, later | DPO on card-vs-card pairs | `shown.candidates`, `shown_index` |

v1 ships the first two rungs as working scripts and a reliability plot on ~200 synthetic records (`docs/reliability.svg`, from `pnpm synth`). The plot also reports pick rate per option, which is where a strawman option shows up. At 200 records with a 10% holdout, no confidence bin has five held-out cases, so the holdout line has nothing to draw: separating preference from the nudge needs closer to 1,000 records. It ships the last two rungs as a written plan, not code.

### 8.1 What "pairs" means here

- **Within-card pair:** chosen option vs rejected option, same card. A ranking signal for a small reranker. Never a generator preference.
- **Card-vs-card pair:** two sampled cards, one shown and chosen from. This is the only pair DPO should ever see, and v1 does not emit it: only one card is ever shown per decision, so the record holds no evidence that the person preferred it to the other candidate. Candidates mode records the other cards; what a fair comparison between them looks like is an open decision (§12).

`scripts/records-to-pairs.ts` emits within-card pairs, labelled with `agreed`, `highlight_shown`, `override_reason` and `signal_confirmed` (from `check_in.confirms`), and refuses `--card-vs-card`.

---

## 9. Relationship to existing work

- **json-render (Vercel Labs) and A2UI (Google).** Both constrain a model to a catalog of UI components and render it. Neither logs what the person chose or what happened. This pattern's card can be expressed as a five-component catalog on either; the record is what it adds. The reference UI does not depend on them so that the pattern stays readable on its own.
- **Mahdi Farra, "The blank box is a systems problem".** The primitives here follow his rule: few, dumb, consistent, assembled by the model. `ask` is his clarify chips. He leaves routing unsolved; the record is a way to learn it without frontier-scale data.
- **Tian Pan, "Feedback surfaces that actually train your model".** Same thesis in prose: feedback should be a side effect of use, not a widget. No schema or code. This repo is the concrete version.
- **LangSmith / Phoenix / Argilla / OpenPipe feedback formats.** All keep the full request alongside feedback; this record does too. What they do not have is `basis` per evidence line, `recommended_id` + `highlight_shown`, and a check-in with a `due`.

---

## 10. Reference implementation

One package. One example. One script. One CI test.

```
logbook/
  README.md                 # diagram, one records.jsonl line, one derived pair, link to hosted demo
  SPEC.md                   # this file
  schema/
    card.schema.json
    record.schema.json
  src/                      # the npm package
    adapters/openai-compatible.ts
    adapters/mock.ts
    loop.ts                 # state machine (pure transitions + Loop) + record writer
    validate.ts             # schema + id checks + semantic checks; prose fallback
    model-schema.ts         # the smaller schema the model is constrained to, derived from card.schema.json
    template.ts             # versioned prompt template: buildMessages()
    sinks/jsonl-file.ts     # JsonlFileSink; Node only, so loop.ts stays browser-safe
    sinks/post.ts           # PostSink for the browser
    react/                  # useLoop(), <Card>, five headless primitives, <Prose>
    skin/default.css
  fixtures/                 # cards/ and records/, each split into valid/ and invalid/
  test/logbook.test.ts      # the one CI test file (§10.3)
  test/react.test.tsx       # the seven rendering rules, in a DOM
  test/ollama.live.test.ts  # skipped in CI; `pnpm test:live` runs it against a real endpoint
  scripts/
    materialise.ts          # records.jsonl → latest snapshot per record
    records-to-pairs.ts     # within-card pairs, labelled; refuses card-vs-card
    reliability.ts          # confidence × agreed × outcome plot (SVG) + pick rate per option
    synth.ts                # ~200 synthetic records, made by driving the real loop
  docs/reliability.svg      # the plot on the synthetic log
  hypothesis.json           # the five slots, example values (used by the example and the demo)
  examples/shared/          # the app both of the below run, behind a small Backend interface
    App.tsx                 # chat shell: a conversation that plays out, the card as the reply, and a side panel of what is stored
    record-store.ts         # append-only log; refuses records that fail the schema or cannot follow the last one
    demo-adapter.ts         # the stand-in model: a written card per example situation
    local-backend.ts        # the whole backend in the browser tab, for the demo
  examples/local-model/     # Vite app + record server + in-process check-in scheduler; one command vs Ollama
    server.ts               # one process: app, /records, /check-ins, demo clock, /v1 proxy to the model
    http-backend.ts         # the app's Backend, over HTTP to server.ts
  demo/                     # static build of the example on the stand-in model; hosted on GitHub Pages (manual deploy)
  docs/demo.gif             # the card with the log growing beside it
  LICENSE
  tasks/todo.md
```

### 10.1 Hook

```ts
const loop = useLoop({ adapter, sink, hypothesis, holdoutRate: 0.1 });
loop.state                       // 'idle' | 'composing' | 'shown' | 'answered' | 'chosen' | 'outcome_pending' | 'closed' | 'expired' | 'abandoned'
loop.compose(input)              // → shown
loop.answer(answer)              // → answered
loop.choose(optionId)            // → chosen → outcome_pending, at the tap
loop.explain(reason)             // adds chose.override_reason; stays outcome_pending
loop.outcome(result)             // → closed
loop.abandon()                   // → abandoned
loop.card, loop.record, loop.warnings, loop.pending, loop.error
```

`useLoop` also accepts a `Loop` made elsewhere, so a scheduler can share it. The `Loop` owns the state machine and writes every transition through `sink` (`JsonlFileSink` in Node, `PostSink` in the browser); the hook subscribes to it. Actions never throw into the UI: a failure sets `loop.error` and leaves the card where it was, and an action called while another is saving is ignored.

Components are headless and take `loop` as a prop. A chat host turns the card's own status line off (`<Card status={false}>`) and says it as a message, and renders `<CheckIn>` as a later message of its own. They render plain HTML with `data-*` attributes and the seven rendering rules live in them; `skin/default.css` only styles. `<Card checkInOpen>` shows the check-in once the host has delivered it: delivery belongs to the host (§4), not the card.

### 10.2 Front door

- README opens with the diagram, one real `records.jsonl` line, and one derived pair. That is the sixty-second pitch.
- The hosted demo is a conversation, because that is where the card lives. It is two framed windows on a dark page: a chat in the manner of current assistants (the person's messages as pills on the right, the assistant's replies as plain text, a tray of conversations and a composer docked below), and beside it the log of what is being stored. An example conversation plays itself out (a question, a plain reply, then the question that reaches a decision). The assistant then looks things up one step at a time ("Searching records", "Read Supplier B delivery history", "Writing the reply"), the card arrives as the reply, and the visitor makes the call. A week later the follow-up arrives as a new message in the same thread. The second window shows what is being stored as it is stored: the conversation word for word, then each step, in plain words beside the record field that holds it, with a count of lines written to the log. The raw record and a download sit under it. It runs on a stand-in model with no install, on the same app, record store and checks as the local example, with the backend in the browser tab.
- A GIF of that is what gets shared.

### 10.3 CI

Two test files. `test/logbook.test.ts` validates fixtures against both schemas, runs the state machine end to end on the mock adapter, runs `records-to-pairs` on the fixture log and asserts pair counts. `test/react.test.tsx` needs a DOM, so it is separate: one test per rendering rule in §5.3. `test/example.test.ts` runs the example's record server over HTTP against a stand-in model. All three run on push; `test/ollama.live.test.ts` runs only on demand.

---

## 11. Non-goals (v1)

- Multi-user, auth, history views, mobile layouts.
- Storage other than a JSONL file.
- Fine-tune recipes, eval harness beyond the reliability plot.
- Any decision shape other than single-choice.
- A conformance CLI. Constrained decoding makes "valid card rate" meaningless; §5.2 is the replacement.
- Anything specific to any company or domain.

---

## 12. Open decisions

| Decision | Default in this draft | Needs |
|---|---|---|
| npm | not published; the package is marked private | decide whether to publish, and under which scope |
| Holdout rate | 10% | fine as default; deployments override |
| Candidates mode in the example | off | on adds cost per decision; turn on once the loop closes at all |
| Check-in grace period | 2× `due_in` | arbitrary; revisit with data |
| Semantic checks: log only or block | log only | block only if a check proves reliable |
| Card-vs-card pairs | not emitted | a design for showing two cards, or a reason one shown card can stand in for a comparison |

---

## 13. Build order

1. Schemas (done in this draft) and fixture cards/records; CI validates them.
2. `validate.ts` and `loop.ts` on the mock adapter; the state machine end to end in a test.
3. `openai_compatible` adapter against Ollama; probe for structured-output support; prose fallback path tested by feeding it garbage.
4. `records-to-pairs.ts`, `materialise.ts`, `reliability.ts` on ~200 synthetic records; the reliability plot is the first artifact.
5. React hook and headless primitives; default skin; the seven rendering rules as tests.
6. Example app with the record server and scheduler; one command.
7. Hosted demo on the mock adapter; GIF; README.

Each step is a checkbox in `tasks/todo.md`; nothing is done until its test runs.
