// @vitest-environment jsdom
// The reference UI: the seven rendering rules (SPEC §5.3), one test each, plus
// the paths around them. Separate from logbook.test.ts because it needs a DOM.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockAdapter } from '../src/adapters/mock';
import { Loop, type LoopComposeInput } from '../src/loop';
import { BASIS_TEXT, Card, useLoop } from '../src/react';
import type { Adapter, DecisionCard, Hypothesis, LogRecord, Sink } from '../src/types';
import { CONFIDENCE_BANDS } from '../src/validate';

afterEach(cleanup);

const ROOT = join(import.meta.dirname, '..');
const decisionFixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/cards/valid/decision.json'), 'utf8')) as DecisionCard;

const hypothesis: Hypothesis = {
  context: 'Weekly stock review',
  who: 'Store manager',
  what: 'a supplier delivery that is likely to be late',
  what_changes: 'reorders placed before stock runs out',
  by_how_much: 'stock-outs down 20% in a quarter',
};

const composeInput: LoopComposeInput = {
  messages: [
    { role: 'system', content: 'You assemble one decision card.' },
    { role: 'user', content: '[ctx_14] Delays.\n[ctx_15] Stock.' },
  ],
  templateVersion: 't1',
  retrievalIds: ['ctx_14', 'ctx_15'],
};

type Setup = { outputs?: unknown[]; random?: number; sink?: Sink; adapter?: Adapter; checkInOpen?: boolean };
type Handle = ReturnType<typeof useLoop>;

function setup({ outputs = [decisionFixture], random = 0.5, sink, adapter, checkInOpen = false }: Setup = {}) {
  const records: LogRecord[] = [];
  const loop = new Loop({
    adapter: adapter ?? createMockAdapter({ outputs }),
    sink: sink ?? { append: (record) => void records.push(record) },
    hypothesis,
    random: () => random,
    now: () => new Date('2026-09-30T09:00:00.000Z'),
  });
  const handle: { current: Handle | null } = { current: null };
  function Harness({ open }: { open: boolean }) {
    handle.current = useLoop(loop);
    return <Card loop={handle.current} checkInOpen={open} />;
  }
  const view = render(<Harness open={checkInOpen} />);
  return {
    loop,
    records,
    view,
    handle: () => handle.current!,
    statuses: () => records.map((r) => r.status),
    openCheckIn: () => view.rerender(<Harness open />),
  };
}

async function shown(options: Setup = {}) {
  const s = setup(options);
  await act(async () => {
    await s.loop.compose(composeInput);
  });
  return s;
}

const option = (name: RegExp) => screen.getByRole('button', { name });

// Buttons stay disabled until the hook's last write settles, a moment after the
// new state renders. A person cannot click in that gap; a test can.
async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
const reasonBox = () => screen.queryByRole('textbox', { name: /What made you choose/ });

describe('rendering rules (SPEC §5.3)', () => {
  it('1. override is one tap, with no confirm step', async () => {
    const { records, statuses } = await shown();
    fireEvent.click(option(/Chase Supplier B/));

    await waitFor(() => expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']));
    expect(records.at(-1)!.chose).toMatchObject({ option_id: 'chase_supplier', agreed: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    [0.5, true],
    [0.05, false],
  ])('2. holdout: with random %d the highlight shows is %s', async (random, highlighted) => {
    const { view, records } = await shown({ random });
    const marked = view.container.querySelectorAll('[data-highlighted]');

    expect(records[0]!.shown.highlight_shown).toBe(highlighted);
    expect(marked).toHaveLength(highlighted ? 1 : 0);
    expect(screen.queryByText('Recommended') !== null).toBe(highlighted);
    if (highlighted) expect(marked[0]!.getAttribute('data-option')).toBe('reorder_backup');
  });

  it('3. confidence is a band, never the raw number', async () => {
    const { view } = await shown();
    const [lo, hi] = CONFIDENCE_BANDS.high;

    expect(screen.getByRole('img', { name: `Confidence high: somewhere from ${lo * 100} to ${hi * 100} percent` })).toBeTruthy();
    expect(view.container.querySelector('[data-logbook="signal"]')!.getAttribute('data-level')).toBe('high');
    expect(document.body.innerHTML).not.toContain('0.72');
    expect(document.body.innerHTML).not.toMatch(/\b72\b/);
  });

  it('3. the skin draws exactly the bands the code defines', () => {
    const css = readFileSync(join(ROOT, 'src/skin/default.css'), 'utf8');
    const rule = (level: string, part: string) =>
      css.match(new RegExp(`\\[data-level='${level}'\\] \\[data-part='${part}'\\] \\{([^}]*)\\}`))![1]!;
    const value = (declarations: string, property: string) => Number(declarations.match(new RegExp(`${property}: ([\\d.]+)%`))![1]);

    for (const [level, [lo, hi]] of Object.entries(CONFIDENCE_BANDS)) {
      expect(value(rule(level, 'band-solid'), 'width')).toBeCloseTo(lo * 100);
      expect(value(rule(level, 'band-range'), 'left')).toBeCloseTo(lo * 100);
      expect(value(rule(level, 'band-range'), 'width')).toBeCloseTo((hi - lo) * 100);
    }
  });

  it('4. every evidence line shows its basis as visible text', async () => {
    const { view } = await shown();
    const lines = [...view.container.querySelectorAll('[data-logbook="evidence"] li')];

    expect(lines.map((li) => li.querySelector('[data-part="basis"]')!.textContent)).toEqual([
      BASIS_TEXT.data,
      BASIS_TEXT.data,
      BASIS_TEXT.rule_of_thumb,
    ]);
    expect(view.container.querySelector('[data-logbook="evidence"] [title]')).toBeNull();
  });

  it('5. override asks why, after the choice is logged, and a reason lands as a new snapshot', async () => {
    const { records, statuses, openCheckIn } = await shown();
    fireEvent.click(option(/Chase Supplier B/));
    await waitFor(() => expect(reasonBox()).not.toBeNull());

    // Never blocking: the choice is already saved and the check-in can still be answered.
    expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']);
    openCheckIn();
    expect(screen.getByRole('group', { name: 'Answers' })).toBeTruthy();

    fireEvent.change(reasonBox()!, { target: { value: 'Supplier confirmed Friday by phone' } });
    await clickWhenEnabled(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(records.at(-1)!.chose!.override_reason).toBe('Supplier confirmed Friday by phone'));
    expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending', 'outcome_pending']);
    expect(reasonBox()).toBeNull();
  });

  it('5. skipping the reason writes nothing', async () => {
    const { statuses } = await shown();
    fireEvent.click(option(/Wait/));
    await waitFor(() => expect(reasonBox()).not.toBeNull());

    await clickWhenEnabled(within(reasonBox()!.closest('section')!).getByRole('button', { name: 'Skip' }));
    expect(reasonBox()).toBeNull();
    expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']);
  });

  it('5. agreeing asks nothing', async () => {
    const { statuses } = await shown();
    fireEvent.click(option(/Reorder from backup/));
    await waitFor(() => expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']));
    expect(reasonBox()).toBeNull();
  });

  it('5. the question never mentions a recommendation the person did not see', async () => {
    await shown({ random: 0.05 });
    fireEvent.click(option(/Wait/));
    await waitFor(() => expect(reasonBox()).not.toBeNull());
    expect(reasonBox()!.closest('section')!.textContent).not.toMatch(/recommend/i);
  });

  it('6. the check-in always offers "Can’t tell"', async () => {
    const { records } = await shown({ checkInOpen: true });
    fireEvent.click(option(/Reorder from backup/));
    const answers = await screen.findByRole('group', { name: 'Answers' });

    expect(within(answers).getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes', 'No', 'Can’t tell']);
    await clickWhenEnabled(within(answers).getByRole('button', { name: 'Can’t tell' }));
    await waitFor(() => expect(records.at(-1)!.status).toBe('closed'));
    expect(records.at(-1)!.outcome).toMatchObject({ source: 'self', option_id: 'cant_tell' });
  });

  it('6. "Can’t tell" is not doubled when the model already offered it', async () => {
    const withCantTell = {
      ...decisionFixture,
      check_in: { ...decisionFixture.check_in, options: [...decisionFixture.check_in.options, { id: 'cant_tell', label: 'Not sure yet' }] },
    };
    await shown({ outputs: [withCantTell], checkInOpen: true });
    fireEvent.click(option(/Wait/));
    const answers = await screen.findByRole('group', { name: 'Answers' });
    expect(within(answers).getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes', 'No', 'Not sure yet']);
  });

  it('7. the prose fallback is visibly a fallback', async () => {
    const { view, statuses } = await shown({ outputs: ['I would reorder from the backup supplier.'] });

    expect(screen.getByText(/Couldn’t build the card/)).toBeTruthy();
    expect(screen.getByText('I would reorder from the backup supplier.')).toBeTruthy();
    expect(view.container.querySelector('[data-logbook="prose"]')!.getAttribute('data-reason')).toBe('invalid_json');
    expect(view.container.querySelector('[data-logbook="choice"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(statuses()).toEqual(['shown', 'abandoned']));
  });
});

describe('reference UI', () => {
  it('renders the primitives in their fixed order', async () => {
    const { view } = await shown();
    const order = [...view.container.querySelectorAll('[data-logbook]')].map((el) => el.getAttribute('data-logbook'));
    expect(order).toEqual(['card', 'signal', 'evidence', 'ask', 'choice']);
  });

  it('answers a chips ask, then still lets the person choose', async () => {
    const { records, statuses } = await shown();
    fireEvent.click(within(screen.getByRole('group', { name: /backup supplier/ })).getByRole('button', { name: 'No' }));

    await waitFor(() => expect(statuses()).toEqual(['shown', 'answered']));
    expect(records.at(-1)!.answered).toMatchObject({ kind: 'chips', option_id: 'no' });
    await waitFor(() => expect(screen.queryByRole('group', { name: /backup supplier/ })).toBeNull());
    await waitFor(() => expect((option(/Wait/) as HTMLButtonElement).disabled).toBe(false));
  });

  it('answers a text ask, and skip records a skip', async () => {
    const textAsk = { ...decisionFixture, ask: { question: 'Has the supplier given a date?', kind: 'text' } };
    const first = await shown({ outputs: [textAsk] });
    const box = screen.getByRole('textbox', { name: 'Has the supplier given a date?' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Friday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(first.records.at(-1)!.answered).toMatchObject({ kind: 'text', text: 'Friday' }));
    cleanup();

    const second = await shown({ outputs: [textAsk] });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(second.records.at(-1)!.answered).toMatchObject({ kind: 'skipped' }));
  });

  it('says when the check-in will come, until it is delivered', async () => {
    const { openCheckIn } = await shown();
    fireEvent.click(option(/Wait/));
    await screen.findByText(/We’ll ask “Did you run out of stock before the next delivery\?” on/);
    expect(screen.queryByRole('group', { name: 'Answers' })).toBeNull();

    openCheckIn();
    expect(screen.getByRole('group', { name: 'Answers' })).toBeTruthy();
  });

  it('leaves its status line out when the host says it another way', async () => {
    const loop = new Loop({ adapter: createMockAdapter({ outputs: [decisionFixture] }), sink: { append: () => {} }, hypothesis, random: () => 0.5 });
    function Quiet() {
      return <Card loop={useLoop(loop)} status={false} />;
    }
    render(<Quiet />);
    await act(async () => {
      await loop.compose(composeInput);
      await loop.choose('reorder_backup');
    });
    expect(screen.getByRole('group', { name: 'Options' })).toBeTruthy();
    expect(screen.queryByText(/We’ll ask/)).toBeNull();
  });

  it('shows the composing state, then the card', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mock = createMockAdapter({ outputs: [decisionFixture] });
    const { loop } = setup({ adapter: { compose: async (input) => (await gate, mock.compose(input)) } });

    let composing!: Promise<unknown>;
    act(() => {
      composing = loop.compose(composeInput);
    });
    expect(screen.getByRole('status').textContent).toBe('Building the card…');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();

    await act(async () => {
      release();
      await composing;
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(decisionFixture.signal.headline);
  });

  it('silently ignores an action called while another is saving', async () => {
    const { handle, statuses } = await shown();
    let results: unknown[] = [];
    await act(async () => {
      results = await Promise.all([handle().choose('wait'), handle().choose('chase_supplier')]);
    });
    expect(results[0]).toMatchObject({ status: 'outcome_pending' });
    expect(results[1]).toBeUndefined();
    expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides the previous card while the next one is built', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mock = createMockAdapter({ outputs: [decisionFixture] });
    let calls = 0;
    const { loop } = setup({ adapter: { compose: async (input) => (++calls > 1 && (await gate), mock.compose(input)) } });
    await act(async () => {
      await loop.compose(composeInput);
      await loop.choose('wait');
    });
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();

    let composing!: Promise<unknown>;
    act(() => {
      composing = loop.compose(composeInput);
    });
    expect(screen.getByRole('status').textContent).toBe('Building the card…');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
    expect(screen.queryByText(/We’ll ask/)).toBeNull();

    await act(async () => {
      release();
      await composing;
    });
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
  });

  it('logs one choice for a double tap', async () => {
    const { statuses } = await shown();
    const wait = option(/Wait/);
    fireEvent.click(wait);
    fireEvent.click(option(/Chase Supplier B/));
    await waitFor(() => expect(statuses()).toEqual(['shown', 'chosen', 'outcome_pending']));
  });

  it('shows a sink failure and leaves the card where it was', async () => {
    let failing = false;
    const records: LogRecord[] = [];
    const sink: Sink = { append: (record) => (failing ? Promise.reject(new Error('Record server is down')) : void records.push(record)) };
    await shown({ sink });

    failing = true;
    fireEvent.click(option(/Wait/));
    expect((await screen.findByRole('alert')).textContent).toBe('Record server is down');
    expect(records.map((r) => r.status)).toEqual(['shown']);
    await waitFor(() => expect((option(/Wait/) as HTMLButtonElement).disabled).toBe(false));

    failing = false;
    fireEvent.click(option(/Wait/));
    await waitFor(() => expect(records.map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending']));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
