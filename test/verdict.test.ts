import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChoiceAnswer } from '../src/decide/model.ts';
import { parseOutput, render } from '../src/task.ts';
import { triageOutcome, verifyOutcome } from '../src/verdict.ts';

const choice = (choice: string, probabilities: Record<string, number>): ChoiceAnswer => ({
  type: 'choice',
  choice,
  probabilities,
  confidence: 0.5, // deliberately different: thresholds use probabilities
});

describe('triage', () => {
  it('accepts when the chosen option clears t0', () => {
    expect(triageOutcome(choice('card_arrival', { card_arrival: 0.95 }), 0.9)).toEqual({
      accepted: true,
      answer: 'card_arrival',
      probability: 0.95,
    });
  });

  it('accepts exactly at the threshold', () => {
    expect(triageOutcome(choice('a', { a: 0.9 }), 0.9).accepted).toBe(true);
  });

  it('rejects below t0, on cannot_tell, and when there is no answer', () => {
    expect(triageOutcome(choice('a', { a: 0.89 }), 0.9).accepted).toBe(false);
    expect(triageOutcome(choice('cannot_tell', { cannot_tell: 0.99 }), 0.5).accepted).toBe(false);
    expect(triageOutcome(undefined, 0).accepted).toBe(false);
  });
});

describe('verify', () => {
  it('accepts supported answers above the threshold', () => {
    expect(verifyOutcome(choice('supported', { supported: 0.97, unsupported: 0.03 }), 0.9)).toEqual({
      accepted: true,
      verdict: 'supported',
      probability: 0.97,
    });
  });

  it('rejects low-confidence support, unsupported, and cannot_tell', () => {
    expect(verifyOutcome(choice('supported', { supported: 0.6 }), 0.9)).toMatchObject({ accepted: false, verdict: 'supported' });
    expect(verifyOutcome(choice('unsupported', { supported: 0.1 }), 0.05)).toMatchObject({ accepted: false, verdict: 'unsupported' });
    expect(verifyOutcome(choice('cannot_tell', { supported: 0.45 }), 0.4)).toMatchObject({ accepted: false, verdict: 'cannot_tell' });
  });
});

describe('task helpers', () => {
  it('fills {{column}} placeholders and fails on unknown ones', () => {
    expect(render('Message: {{ text }}', { text: 'hi' })).toBe('Message: hi');
    expect(() => render('{{missing}}', {})).toThrow(/missing/);
  });

  it('parses writer output against the schema, tolerating quotes and whitespace', () => {
    const schema = z.enum(['card_arrival', 'exchange_rate']);
    expect(parseOutput(schema, ' "card_arrival"\n')).toEqual({ ok: true, value: 'card_arrival' });
    expect(parseOutput(schema, 'exchange_rate_inquiry').ok).toBe(false);
    expect(parseOutput(z.object({ a: z.number() }), '{"a":1}')).toEqual({ ok: true, value: '{"a":1}' });
  });

  it('reads the answer from a JSON field when the task uses structured output', () => {
    const schema = z.enum(['card_arrival', 'change_pin']);
    expect(parseOutput(schema, '{"label": "change_pin"}', 'label')).toEqual({ ok: true, value: 'change_pin' });
    expect(parseOutput(schema, '{"label":"made_up"}', 'label').ok).toBe(false);
    expect(parseOutput(schema, 'change_pin', 'label')).toEqual({ ok: false, error: 'reply is not JSON' });
    expect(parseOutput(schema, '{"intent":"change_pin"}', 'label')).toEqual({ ok: false, error: 'reply has no "label"' });
  });
});
