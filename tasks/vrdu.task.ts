import { z } from 'zod';
import { VRDU_FIELDS, type VrduField } from '../src/datasets/vrdu.ts';
import { scoreSlot } from '../src/extract/score.ts';
import { defineTask } from '../src/task.ts';

// VRDU Registration Forms (FARA filings, google-research-datasets/vrdu). CSV columns: doc_id, template, text, gold.
// `gold` is JSON: field -> list of accepted values (empty list = the form does not state the field).

// The dataset spells it "foreign_principle_name"; the key is kept as is.
const FIELD_INFO: Record<VrduField, { label: string; description: string }> = {
  file_date: { label: 'date of signature', description: 'the date written next to the signature at the end of the form' },
  foreign_principle_name: { label: 'foreign principal name', description: 'the name of the foreign principal entered in the form' },
  registrant_name: { label: 'registrant name', description: 'the name of the registrant entered in the form' },
  registration_num: { label: 'registration number', description: 'the registration number entered in the form' },
  signer_name: { label: 'signer name', description: 'the name of the person who signed the form' },
  signer_title: { label: 'signer title', description: "the signer's title or position, as written with the signature" },
};

const info = (field: string) => {
  const i = FIELD_INFO[field as VrduField];
  if (!i) throw new Error(`Unknown VRDU field "${field}"`);
  return i;
};

const CANNOT_TELL = 'It is not possible to tell from the document';

export default defineTask({
  name: 'vrdu',
  idColumn: 'doc_id',
  inputColumns: ['text'],
  state: (row) => ({ document: row.text ?? '' }),
  writer: {
    system:
      'You extract six fields from a US Foreign Agents Registration Act (FARA) filing. The document is OCR text of a form. ' +
      'For each field, return the value exactly as it is written in the document, or null if the form does not state it. ' +
      'Do not guess, and do not build a value from other parts of the document.\n\nFields:\n' +
      VRDU_FIELDS.map((f) => `${f}: ${FIELD_INFO[f].description}`).join('\n'),
    promptTemplate: '<document>\n{{text}}\n</document>\n\nExtract the six fields.',
    // No cacheSystem: each model sees each document once, so a cache write would never be read.
    maxTokens: 1024,
    reasoning: { enabled: false },
    // Sonnet 5.5 cannot turn reasoning off; "minimal" plus room to finish (unused tokens are not billed).
    escalation: { reasoning: { effort: 'minimal' }, maxTokens: 2048 },
    // Verified live on Haiku 5.5, Sonnet 5.5 and Opus 5.5.
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'fields',
        strict: true,
        schema: {
          type: 'object',
          properties: Object.fromEntries(VRDU_FIELDS.map((f) => [f, { type: ['string', 'null'] }])),
          required: [...VRDU_FIELDS],
          additionalProperties: false,
        },
      },
    },
    outputSchema: z.object(Object.fromEntries(VRDU_FIELDS.map((f) => [f, z.string().nullable()]))),
  },
  extract: {
    fields: VRDU_FIELDS,
    question: (field, value) => {
      const { label, description } = info(field);
      if (value === null) {
        return {
          type: 'choice',
          instructions: `The writer says this document does not state a ${label} (${description}). Is that right?`,
          criteria: {
            supported: `The document does not state a ${label}`,
            unsupported: `The document does state a ${label}`,
            cannot_tell: CANNOT_TELL,
          },
        };
      }
      return {
        type: 'choice',
        instructions: `The writer says the ${label} (${description}) in this document is "${value}". Is that right?`,
        criteria: {
          supported: `The document gives this value for the ${label}`,
          unsupported: `The document gives a different ${label}, or none`,
          cannot_tell: CANNOT_TELL,
        },
      };
    },
    isCorrect: (field, value, label) => {
      const gold = (JSON.parse(label) as Partial<Record<string, string[]>>)[field] ?? [];
      return scoreSlot(field as VrduField, value, gold).correct;
    },
  },
  verify: {
    instructions: 'Check one proposed field value against the FARA filing text in the document.',
    // The proposed values live in the per-field questions.
    state: (row) => ({ document: row.text ?? '' }),
  },
  models: {
    writer: 'claude-haiku-5-5',
    escalation: 'claude-sonnet-5-5',
    decision: 'cloudflare/clef',
  },
  // PROVISIONAL, for development runs only. Replace with thresholds fitted by calibrate.ts
  // on the calibration split before reporting any numbers.
  thresholds: { t0: 1.01, t1: 0.9, t2: 0.9 },
});
