import { z } from 'zod';
import { defineTask } from '../src/task.ts';
import { BANKING77_LABELS } from './banking77.labels.ts';

// Banking77 intent classification (PolyAI, CC-BY-4.0). CSV columns: id, text, label.

const human = (label: string) => label.replace(/_/g, ' ');

export default defineTask({
  name: 'banking77',
  idColumn: 'id',
  inputColumns: ['text'],
  state: (row) => row.text ?? '',
  triage: {
    question: {
      type: 'choice',
      instructions: 'Which banking intent does the customer message express?',
      criteria: {
        ...Object.fromEntries(BANKING77_LABELS.map((l) => [l, human(l)])),
        cannot_tell: 'None of these intents fits, or the message is too ambiguous to choose',
      },
    },
  },
  writer: {
    system:
      'You classify customer messages sent to a bank. Reply with exactly one intent label from the list below, ' +
      'written exactly as shown, and nothing else.\n\nLabels:\n' +
      BANKING77_LABELS.join('\n'),
    promptTemplate: 'Message: {{text}}',
    // The longest label is over 20 tokens in Anthropic's tokenizer, plus ~8 for the JSON wrapper.
    // Unused tokens are not billed.
    maxTokens: 60,
    // Haiku 5.5 thinks by default; with max_tokens 20 that left 43% of answers empty.
    reasoning: { enabled: false },
    escalation: {
      template:
        'Message: {{text}}\n\nAn earlier model answered "{{previous_answer}}". It may or may not be right. ' +
        'Reply with the correct label only.',
      // Sonnet 5.5 cannot turn reasoning off. At "minimal" it still sometimes thinks (200 hidden
      // tokens on 1 of 3 spot checks), so it gets room to finish; unused tokens are not billed.
      reasoning: { effort: 'minimal' },
      maxTokens: 1024,
    },
    // Forces a valid label. Without it Sonnet explained itself in 46 of 65 round-2 answers.
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'intent',
        strict: true,
        schema: {
          type: 'object',
          properties: { label: { type: 'string', enum: [...BANKING77_LABELS] } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    answerField: 'label',
    outputSchema: z.enum(BANKING77_LABELS),
  },
  verify: {
    // The first dev run showed that judging one label in isolation lets close-but-wrong labels
    // through (59% precision). The verifier now sees every label it could be confused with.
    instructions:
      'A customer sent this message to a bank. Of all the labels in all_intents, is proposed_intent ' +
      'the single best match for what the customer wants?',
    criteria: {
      supported: 'proposed_intent is the best match among all_intents',
      unsupported: 'Another label in all_intents matches the message better',
      cannot_tell: 'The message is too ambiguous to judge',
    },
    state: (row, answer) => ({ message: row.text ?? '', proposed_intent: answer, all_intents: [...BANKING77_LABELS] }),
  },
  models: {
    writer: 'anthropic/claude-haiku-5.5:batch',
    escalation: 'anthropic/claude-sonnet-5.5:batch',
    decision: 'typesafe/jev-1.14',
  },
  // PROVISIONAL, for development runs only. Replace with thresholds fitted by calibrate.ts
  // on a held-out slice of the training split before reporting any numbers.
  thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
});
