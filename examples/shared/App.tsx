import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { LoopOptions } from '../../src/loop';
import { Card, CheckIn, useLoop, withCantTell } from '../../src/react';
import { buildMessages, type ContextItem } from '../../src/template';
import type { DecisionCard, LogRecord, Message } from '../../src/types';
import type { Backend } from './backend';
import { PRESETS, type PresetIcon } from './presets';

const DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const LEVEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;

// An opaque per-browser id, so records from one person can be grouped. Not an identity.
function browserId(): string {
  const make = () => `u_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  try {
    const id = localStorage.getItem('logbook-user') ?? make();
    localStorage.setItem('logbook-user', id);
    return id;
  } catch {
    return make();
  }
}

function toItems(text: string): ContextItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({ id: `ctx_${i + 1}`, text: line }));
}

// ── What is stored, in plain words beside the field that holds it ────────────

export type StoredMessage = { role: 'Instructions' | 'You' | 'Assistant'; text: string };

export type Entry = {
  /** The record field this comes from, as written in records.jsonl. */
  field: string;
  label: string;
  value?: string;
  detail?: string;
  /** For the conversation: each stored message, in order. */
  messages?: StoredMessage[];
  /** Scheduled, not yet answered. */
  pending?: boolean;
};

/** What the person asked, read back out of the prompt the record stores. */
export function askedIn(record: LogRecord): string | undefined {
  return record.input.messages.at(-1)?.content.match(/\n\nThe [^\n]* asks: ([\s\S]+)$/)?.[1];
}

const seconds = (ms: number) => (ms < 1_000 ? 'under a second' : ms < 60_000 ? `${Math.round(ms / 1_000)} seconds` : `${Math.round(ms / 60_000)} min`);

/**
 * What one record holds so far, one entry per thing stored and the field that
 * stores it. Entries appear as they are recorded; the only one that waits is a
 * follow-up that is scheduled.
 */
export function stored(record: LogRecord): Entry[] {
  const card = record.shown.card;
  const { status, answered, chose, outcome, input } = record;
  const question = askedIn(record);
  const looked = input.retrieval_ids?.length ?? 0;

  const entries: Entry[] = [
    {
      field: 'input.messages',
      label: 'The conversation, word for word',
      messages: input.messages.map((message: Message, i): StoredMessage => {
        if (message.role === 'system') return { role: 'Instructions', text: `What the model is told to do (${message.content.length.toLocaleString()} characters)` };
        const last = i === input.messages.length - 1;
        return { role: message.role === 'user' ? 'You' : 'Assistant', text: last && question ? question : message.content };
      }),
      detail: looked > 0 ? `Plus the ${looked} ${looked === 1 ? 'record' : 'records'} the assistant looked up.` : undefined,
    },
  ];

  if (card.kind === 'prose') {
    entries.push({ field: 'shown.card', label: 'The model’s reply', value: 'Its reply broke the card’s rules, so it was shown as plain text.' });
    if (status === 'abandoned') entries.push({ field: 'status', label: 'Your choice', value: 'None. You dismissed it.' });
    return entries;
  }

  const label = (id: string) => card.choice.options.find((o) => o.id === id)?.label ?? id;
  const { recommended } = card.choice;
  // A held-out card keeps its recommendation hidden until the choice is made, here too.
  const hidden = recommended !== null && !record.shown.highlight_shown;
  entries.push({
    field: 'shown.card',
    label: 'The model’s reply',
    value: `${LEVEL[card.signal.level]} confidence.${recommended === null ? ' No recommendation.' : hidden && !chose ? '' : ` Recommended “${label(recommended)}”.`}`,
    detail: hidden
      ? 'This card hid the recommendation until you chose. One card in ten does, to tell a real preference from a nudge.'
      : record.shown.repair
        ? 'Its first reply broke a rule, and it fixed it when told.'
        : undefined,
  });

  if (answered) {
    entries.push({
      field: 'answered',
      label: 'Your answer',
      value:
        answered.kind === 'skipped'
          ? 'You skipped its question.'
          : answered.kind === 'chips'
            ? `“${card.ask?.options?.find((o) => o.id === answered.option_id)?.label ?? answered.option_id}”`
            : `“${answered.text}”`,
    });
  }
  if (chose) {
    entries.push({
      field: 'chose',
      label: 'Your choice',
      value: `“${label(chose.option_id)}”.${chose.agreed === true ? ' You agreed.' : chose.agreed === false ? ' You overrode the recommendation.' : ''}`,
      detail: `Decided in ${seconds(chose.time_to_choose_ms)}.`,
    });
    if (chose.override_reason) entries.push({ field: 'chose.override_reason', label: 'Your reason', value: `“${chose.override_reason}”` });
  }
  if (status === 'abandoned') entries.push({ field: 'status', label: 'Your choice', value: 'None. You set the card aside.' });

  if (outcome) {
    const answer = card.check_in.options.find((o) => o.id === outcome.option_id)?.label;
    entries.push(
      status === 'closed'
        ? {
            field: 'outcome',
            label: 'What happened',
            value:
              outcome.option_id === 'cant_tell'
                ? 'You could not tell.'
                : `“${answer ?? outcome.option_id}”. The model’s signal ${outcome.option_id === card.check_in.confirms ? 'came true' : 'did not come true'}.`,
          }
        : status === 'expired'
          ? { field: 'outcome', label: 'What happened', value: 'No answer. The follow-up expired.' }
          : { field: 'outcome.due_at', label: 'Follow-up', value: `Scheduled for ${DATE.format(new Date(outcome.due_at))}.`, pending: true },
    );
  }
  return entries;
}

/** How many lines this record has added to the log: one snapshot per change (SPEC §4). */
export function linesWritten(record: LogRecord): number {
  const { status, answered, chose } = record;
  return (
    1 +
    (answered ? 1 : 0) +
    (chose ? 2 : 0) + // chosen, then outcome_pending
    (chose?.override_reason ? 1 : 0) +
    (status === 'closed' || status === 'expired' || status === 'abandoned' ? 1 : 0)
  );
}

// The record as written, with the fields that change first and long text
// shortened so it fits on screen. The file itself keeps everything.
function displayRecord(record: LogRecord): string {
  const shorten = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}… (${text.length} characters)` : text);
  const { status, updated_at, answered, chose, outcome, shown, input, ...rest } = record;
  return JSON.stringify(
    {
      status,
      updated_at,
      ...(answered ? { answered } : {}),
      ...(chose ? { chose } : {}),
      ...(outcome ? { outcome } : {}),
      shown: {
        highlight_shown: shown.highlight_shown,
        ...(shown.repair ? { repair: { ...shown.repair, first_reply: shorten(shown.repair.first_reply) } } : {}),
        card: shown.card.kind === 'decision' ? { signal: shown.card.signal, choice: shown.card.choice, '…': 'evidence, ask, check_in' } : shown.card,
        at: shown.at,
      },
      input: { ...input, messages: input.messages.map((m) => ({ role: m.role, content: shorten(m.content) })) },
      ...rest,
    },
    null,
    2,
  );
}

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'records.jsonl' });
  link.click();
  URL.revokeObjectURL(url);
}

// ── Small icons, drawn inline ────────────────────────────────────────────────

const ICON_PATHS: Readonly<Record<PresetIcon | 'send' | 'tick', string>> = {
  clock: 'M8 4.5V8l2.2 1.4M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
  check: 'm4.5 8.3 2.3 2.3 4.7-5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
  anchor: 'M8 5.2V14M8 5.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM3 9.5A5 5 0 0 0 8 14a5 5 0 0 0 5-4.5M5.5 8h5',
  plus: 'M8 3.5v9M3.5 8h9',
  send: 'M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5',
  tick: 'm3.5 8.5 3 3 6-6.5',
};

function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Playing a conversation out ───────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stillMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── The app ──────────────────────────────────────────────────────────────────

export function App({ backend }: { backend: Backend }) {
  const { config } = backend;
  const { hypothesis } = config;
  const [options] = useState<LoopOptions>(() => ({
    adapter: backend.adapter,
    sink: backend.sink,
    hypothesis,
    now: () => new Date(Date.now() + backend.offsetMs()),
    actor: { user_hash: browserId(), role: hypothesis.who, session_id: crypto.randomUUID() },
  }));
  const loop = useLoop(options);

  // The conversation before the card: messages already said, and the one being typed.
  const [turns, setTurns] = useState<Message[]>([]);
  const [typing, setTyping] = useState('');
  const [phase, setPhase] = useState<'idle' | 'playing' | 'live'>('idle');
  const [conversation, setConversation] = useState(0);
  const [question, setQuestion] = useState('');
  const [facts, setFacts] = useState<string>(PRESETS[0]!.facts.join('\n'));
  const [draft, setDraft] = useState('');
  // The lookup before the card: how many steps have finished, then 'done' once the card can show.
  const [lookup, setLookup] = useState<number | 'done'>('done');
  const [sources, setSources] = useState<readonly string[]>([]);
  const [due, setDue] = useState<LogRecord[]>([]);
  const [today, setToday] = useState(() => new Date(Date.now() + backend.offsetMs()));
  const [serverError, setServerError] = useState<string | null>(null);
  const run = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await backend.snapshot();
      setDue(snapshot.due);
      setToday(new Date(Date.now() + snapshot.offsetMs));
      setServerError(null);
    } catch (error) {
      setServerError((error as Error).message);
    }
  }, [backend]);

  // Poll for due check-ins, and refresh straight after every write this page makes.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => void refresh(), [loop.record, refresh]);
  useEffect(() => {
    document.title = `${config.title} (Beta)`;
  }, [config.title]);

  // A session that ends without a choice is abandoned (SPEC §4). PostSink sends
  // with keepalive, so this last write outlives the page.
  const { state, abandon } = loop;
  const undecided = state === 'shown' || state === 'answered';
  useEffect(() => {
    if (!undecided) return;
    const onHide = () => void abandon();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [undecided, abandon]);

  /**
   * Plays a conversation: the opening turns type and stream as they would in a
   * chat, then the question is sent and the assistant replies with the card.
   * Whatever came before stays in the prompt, so the record stores it.
   */
  const converse = async (lead: readonly Message[], asked: string, known: string, index = conversation, from: readonly string[] = []) => {
    const id = ++run.current;
    const alive = () => run.current === id;
    const instant = stillMotion();
    setConversation(index);
    setFacts(known);
    setDraft('');
    setTurns([]);
    setQuestion('');
    setPhase('playing');
    if (undecided) await loop.abandon();

    const type = async (text: string) => {
      if (!instant) {
        for (let i = 1; i <= text.length && alive(); i += 2) {
          setTyping(text.slice(0, i));
          await sleep(22);
        }
        await sleep(260);
      }
      setTyping('');
    };

    for (const message of lead) {
      if (!alive()) return;
      if (message.role === 'user') {
        await type(message.content);
        if (!alive()) return;
        setTurns((said) => [...said, message]);
        continue;
      }
      // The assistant thinks for a beat, then its reply streams in a word at a time.
      setTurns((said) => [...said, { role: 'assistant', content: '' }]);
      if (!instant) await sleep(650);
      const words = message.content.split(' ');
      for (let i = 1; i <= words.length && alive(); i++) {
        const partial = words.slice(0, i).join(' ');
        setTurns((said) => [...said.slice(0, -1), { role: 'assistant', content: partial }]);
        if (!instant) await sleep(38);
      }
      if (!instant) await sleep(500);
    }

    if (!alive()) return;
    await type(asked);
    if (!alive()) return;
    setQuestion(asked);
    // The assistant looks things up before it answers: search, read each record, then write.
    const found = toItems(known);
    setSources(found.map((item, i) => from[i] ?? (item.text.length > 44 ? `${item.text.slice(0, 44)}…` : item.text)));
    setLookup(0);
    setPhase('live');
    const reply = loop.compose(buildMessages({ hypothesis, items: found, question: asked, history: lead }));
    if (!instant) {
      await sleep(700);
      for (let i = 1; i <= Math.max(found.length, 1) && alive(); i++) {
        setLookup(i);
        await sleep(420);
      }
      await sleep(350);
    }
    await reply;
    if (alive()) setLookup('done');
  };

  const play = (index: number) => {
    const preset = PRESETS[index]!;
    return converse(preset.lead, preset.question, preset.facts.join('\n'), index, preset.sources);
  };

  // The demo opens on a conversation in progress, so the first thing a visitor sees is the thing itself.
  useEffect(() => {
    if (config.autoStart) void play(0);
    return () => {
      run.current++;
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = phase === 'live';
  const record = live ? loop.record : null;
  const card = live ? loop.card : null;
  const decision = card?.kind === 'decision' ? card : null;
  const composing = live && (state === 'composing' || lookup !== 'done');
  const dueAt = live && state === 'outcome_pending' ? new Date(record!.outcome!.due_at) : null;
  const checkInOpen = dueAt !== null && dueAt <= today;
  const earlier = due.filter((r) => !(r.record_id === record?.record_id && state === 'outcome_pending'));
  const busy = loop.pending || composing || phase === 'playing';
  const finished = live && (state === 'closed' || state === 'expired' || state === 'abandoned');

  // A chat keeps its newest message in view.
  const followedUp = checkInOpen || (live && state === 'closed');
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: stillMotion() ? 'auto' : 'smooth' });
  }, [turns, typing, phase, state, followedUp, record?.chose, lookup]);

  const skipToFollowUp = async () => {
    await backend.advanceClock(dueAt!.getTime() - (Date.now() + backend.offsetMs()) + 1_000);
    await refresh();
  };

  const answerEarlier = async (recordId: string, optionId: string) => {
    try {
      await backend.closeCheckIn(recordId, optionId);
    } catch (error) {
      setServerError((error as Error).message);
    }
    await refresh();
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    // A typed question belongs to none of the listed conversations.
    if (config.editableFacts && draft.trim() && !busy) void converse([], draft.trim(), facts, -1);
  };

  const items = toItems(facts);
  const chosen = decision?.choice.options.find((o) => o.id === record?.chose?.option_id);
  const outcome = record?.outcome;
  const answer = decision && outcome?.option_id ? withCantTell(decision.check_in.options).find((o) => o.id === outcome.option_id)?.label : undefined;
  const entries = record && !composing ? stored(record) : [];
  const lines = record && !composing ? linesWritten(record) : 0;
  const placeholder = config.editableFacts
    ? 'Ask anything'
    : phase === 'playing' || composing
      ? ''
      : finished || phase === 'idle'
        ? 'Pick a conversation above'
        : undecided
          ? 'Choose on the card to continue'
          : checkInOpen
            ? 'Answer the follow-up above'
            : 'Waiting for the follow-up';

  return (
    <div className="stage">
      <div className="windows">
        <section className="window chat" aria-label="Conversation with the assistant">
          <header className="window-bar">
            <h1>
              {config.title} <span className="badge">Beta</span>
            </h1>
          </header>

          <div className="scroll">
            <div className="thread" role="log">
              {phase === 'idle' && (
                <div className="welcome">
                  <h2>What do you need to decide?</h2>
                  <p>Pick a conversation below, or ask your own.</p>
                </div>
              )}

              {phase !== 'idle' && <p className="day">{DATE.format(record ? new Date(record.created_at) : today)}</p>}

              {turns.map((turn, i) =>
                turn.role === 'user' ? (
                  <div key={i} className="said you">
                    <span className="sr-only">You: </span>
                    <p>{turn.content}</p>
                  </div>
                ) : (
                  <div key={i} className="said assistant">
                    <span className="sr-only">Assistant: </span>
                    {turn.content ? (
                      <p>
                        {turn.content}
                      </p>
                    ) : (
                      <p className="thinking" aria-label="Assistant is replying" />
                    )}
                  </div>
                ),
              )}

              {live && (
                <>
                  <div className="said you">
                    <span className="sr-only">You: </span>
                    <p>{question}</p>
                  </div>

                  {composing ? (
                    <div className="said assistant" role="status" aria-label="Assistant is looking things up">
                      <ol className="steps">
                        <li data-state={lookup === 0 ? 'active' : 'done'}>
                          <span className="step-mark">{lookup !== 0 && <Icon name="tick" />}</span>
                          Searching records
                        </li>
                        {typeof lookup === 'number' &&
                          (sources.length > 0 ? sources : ['Nothing on file yet']).slice(0, lookup).map((source, i) => (
                            <li key={i} data-state="done">
                              <span className="step-mark">
                                <Icon name="tick" />
                              </span>
                              {sources.length > 0 ? `Read ${source}` : source}
                            </li>
                          ))}
                        {(lookup === 'done' || lookup >= Math.max(sources.length, 1)) && (
                          <li data-state="active">
                            <span className="step-mark" />
                            Writing the reply
                          </li>
                        )}
                      </ol>
                    </div>
                  ) : (
                    <div className="said assistant">
                      <span className="sr-only">Assistant: </span>
                      {items.length > 0 ? (
                        <details className="trace">
                          <summary>
                            Checked {items.length} {items.length === 1 ? 'record' : 'records'}
                          </summary>
                          <ul>
                            {items.map((item, i) => (
                              <li key={item.id}>
                                {sources[i] && sources[i] !== item.text && <span>{sources[i]}</span>}
                                {item.text}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <p className="trace">Nothing on file yet</p>
                      )}
                      <Card loop={loop} status={false} />
                    </div>
                  )}

                  {state === 'abandoned' && <p className="day">You set this one aside</p>}

                  {dueAt && !checkInOpen && (
                    <>
                      <div className="said assistant">
                        <span className="sr-only">Assistant: </span>
                        <p>
                          Saved. I will check back on {DATE.format(dueAt)} to see how it went.
                        </p>
                      </div>
                      {config.demo && (
                        <p className="jump">
                          <button type="button" className="primary" disabled={busy} onClick={() => void skipToFollowUp()}>
                            Skip ahead to {DATE.format(dueAt)}
                          </button>
                        </p>
                      )}
                    </>
                  )}

                  {decision && outcome && (followedUp || state === 'expired') && (
                    <>
                      <p className="day">{DATE.format(new Date(outcome.at ?? outcome.due_at))}</p>
                      <div className="said assistant">
                        <span className="sr-only">Assistant: </span>
                        {checkInOpen ? (
                          <>
                            <p>
                              Following up. You chose “{chosen?.label}”.
                            </p>
                            <article data-logbook="card" className="follow-up">
                              <CheckIn loop={loop} />
                            </article>
                          </>
                        ) : (
                          <p>
                            Following up. You chose “{chosen?.label}”. {decision.check_in.question}
                          </p>
                        )}
                      </div>
                      {state === 'closed' && (
                        <>
                          <div className="said you">
                            <span className="sr-only">You: </span>
                            <p>{answer}</p>
                          </div>
                          <div className="said assistant">
                            <span className="sr-only">Assistant: </span>
                            <p>
                              Thanks. That closes the loop on this one.
                            </p>
                          </div>
                        </>
                      )}
                      {state === 'expired' && <p className="day">Nobody answered, so the follow-up closed</p>}
                    </>
                  )}
                </>
              )}

              {serverError && (
                <p className="server-error" role="alert">
                  {serverError}
                </p>
              )}
              <div ref={end} />
            </div>
          </div>

          <footer className="dock">
            <div className="tray" role="group" aria-label="Conversations">
              {PRESETS.map((preset, i) => (
                <button key={preset.name} type="button" aria-pressed={phase !== 'idle' && i === conversation} disabled={busy} onClick={() => void play(i)}>
                  <Icon name={preset.icon} />
                  {preset.label}
                </button>
              ))}
            </div>
            <form className="composer" onSubmit={send}>
              <input
                type="text"
                aria-label="Message"
                placeholder={placeholder}
                value={phase === 'playing' ? typing : draft}
                readOnly={!config.editableFacts || phase === 'playing'}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" aria-label="Send" disabled={!config.editableFacts ? !typing : busy || !draft.trim()} data-active={typing ? '' : undefined}>
                <Icon name="send" />
              </button>
            </form>
            {config.editableFacts && (
              <details className="facts-editor">
                <summary>Records the assistant can look up</summary>
                <textarea aria-label="Records, one per line" rows={3} value={facts} onChange={(event) => setFacts(event.target.value)} />
              </details>
            )}
          </footer>
        </section>

        <aside className="window store" aria-labelledby="stored-title">
          <header className="window-bar">
            <p>
              <strong id="stored-title">What is being stored</strong> <span>records.jsonl</span>
            </p>
            {record && !composing && (
              <p className="count">
                {lines} {lines === 1 ? 'line' : 'lines'}
              </p>
            )}
          </header>

          <div className="scroll">
            {entries.length === 0 ? (
              <p className="nothing">Nothing yet. The record starts when the conversation reaches a decision.</p>
            ) : (
              <ol className="entries" aria-live="polite">
                {entries.map((entry) => (
                  <li key={`${entry.field}-${entry.label}`} data-pending={entry.pending ? '' : undefined}>
                    <div className="entry-head">
                      <span className="entry-label">{entry.label}</span>
                      <code>{entry.field}</code>
                    </div>
                    {entry.messages && (
                      <ul className="transcript">
                        {entry.messages.map((message, i) => (
                          <li key={i} data-role={message.role}>
                            <span>{message.role}</span>
                            <p>{message.text}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.value && <p className="entry-value">{entry.value}</p>}
                    {entry.detail && <p className="entry-detail">{entry.detail}</p>}
                  </li>
                ))}
              </ol>
            )}

            {earlier.length > 0 && (
              <section className="earlier" aria-labelledby="earlier-title">
                <h2 id="earlier-title">Earlier follow-ups waiting on you</h2>
                <ul>
                  {earlier.map((r) => {
                    const earlierCard = r.shown.card as DecisionCard;
                    const earlierChoice = earlierCard.choice.options.find((o) => o.id === r.chose!.option_id);
                    return (
                      <li key={r.record_id}>
                        <p className="entry-detail">
                          On {DATE.format(new Date(r.chose!.at))} you chose “{earlierChoice?.label}”.
                        </p>
                        <p className="earlier-question">{earlierCard.check_in.question}</p>
                        <div className="earlier-options" role="group" aria-label={earlierCard.check_in.question}>
                          {withCantTell(earlierCard.check_in.options).map((o) => (
                            <button key={o.id} type="button" onClick={() => void answerEarlier(r.record_id, o.id)}>
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>

          {record && !composing && (
            <footer className="dock store-foot">
              <details className="raw">
                <summary>Raw record</summary>
                <pre>{displayRecord(record)}</pre>
              </details>
              {backend.download && (
                <button type="button" className="link" onClick={() => download(backend.download!())}>
                  Download the log
                </button>
              )}
            </footer>
          )}
        </aside>
      </div>

      {config.note && <p className="disclaimer">{config.note}</p>}
    </div>
  );
}
