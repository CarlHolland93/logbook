# Local-model example

The reference card against a model on your own machine, with the record log, the check-in scheduler and a live view of the log beside the card.

## Run it

You need Node 22+, pnpm and [Ollama](https://ollama.com).

```sh
ollama pull qwen2.5:7b     # 4.7 GB, once
ollama serve               # if Ollama is not already running
pnpm install
pnpm example --demo
```

Open http://localhost:5178 and pick a conversation to start, or type your own question in the composer. The opening turns are scripted; the card is the model's own reply, in about half a minute. Choose on the card, then use "Skip ahead" in the thread to bring the follow-up forward and say what happened. The side panel shows what is being stored, as it is stored. To change what the assistant finds when it looks, open "Records the assistant can look up" under the composer.

Without `--demo` the clock is real and records go to `records.jsonl`. With it, they go to `records.demo.jsonl`, so demo timestamps never mix with real ones.

## What is running

One Node process on one port:

- **The app**, served by Vite: a chat where `<Card>` from `src/react` is the assistant's reply, the default skin, and a side panel showing what is being stored beside the record field that holds it, with the raw record one click away.
- **The record server**, which appends every snapshot to the JSONL file. It refuses a snapshot that fails the schema (400) or cannot follow the record's previous one (409), so a stale tab or a double submit never corrupts the log.
- **The check-in scheduler**, which lists due check-ins at `GET /check-ins` and expires unanswered ones after twice `due_in` (SPEC §4). A real deployment would send a notification where this example shows a list.
- **A proxy to the model** at `/v1/*`, so an API key stays on the server.

Leaving the page while a card is open logs it as abandoned.

## Settings

| Variable | Default |
|---|---|
| `LOGBOOK_MODEL` | `qwen2.5:7b` |
| `LOGBOOK_MODEL_URL` | `http://127.0.0.1:11434` (any OpenAI-compatible runtime) |
| `LOGBOOK_API_KEY` | none; sent only from the server to the model |
| `LOGBOOK_PORT` | `5178` |

## What to expect from the model

Measured on 2026-10-01 at the app's settings (temperature 0.2, no seed), 16 cards across the four example situations:

- **Without the repair round**, `qwen2.5:7b` built a valid card 12 times in 16. Every failure was an option label a few characters over the 40-character limit, such as "Consider switching to a more reliable supplier".
- **With it** (the default), 16 of 16. The adapter sends the problems back once and the model shortens the label ("Switch supplier"). A repaired card takes about twice as long, 50 seconds against 26 on a 16 GB laptop, and the log marks it `repaired`.

A card that still fails falls back to prose, visibly (SPEC §5.3 rule 7). `llama3.2:3b` validates about as often but copies option ids from the prompt's example into its cards, which is why it is not the default.
