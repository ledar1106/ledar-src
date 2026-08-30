/**
 * One consent for two calls, and the property that makes that honest.
 *
 * N60 split the lookup into two calls. Round two's bytes do not exist until
 * round one has answered, so asking the person twice is the obvious move — and
 * it is the worse one: somebody asked to approve the same question twice
 * learns to press the button without reading, and this product's whole value
 * is that its disclosures are worth reading.
 *
 * Asking once is defensible only because round two cannot name anything round
 * one did not. That is checked, not assumed, and these tests are the check on
 * the check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { askEnvelope, envelopeNote, envelopeRefuses } from '../src/ask-envelope.js';
import { lookupOffer } from '../src/bounded-lookup.js';
import type { LookupOffer } from '../src/bounded-lookup.js';
import { graphFrom } from '../src/entity-graph.js';
import type { GraphSource } from '../src/entity-graph.js';

const SOURCE: GraphSource = {
  tables: [
    { schema: 'public', table: 'customer' },
    { schema: 'public', table: 'rental' },
    { schema: 'public', table: 'payment' },
  ],
  columns: [],
  constraints: [
    {
      schema: 'public',
      table: 'rental',
      columns: ['customer_id'],
      referencedSchema: 'public',
      referencedTable: 'customer',
      referencedColumns: ['customer_id'],
      kind: 'foreign_key',
    },
    {
      schema: 'public',
      table: 'payment',
      columns: ['rental_id'],
      referencedSchema: 'public',
      referencedTable: 'rental',
      referencedColumns: ['rental_id'],
      kind: 'foreign_key',
    },
  ],
};

const OFFER = lookupOffer(graphFrom(SOURCE));
const WHERE = 'https://api.example.dev/v1/chat/completions';
const Q = 'A customer paid and has no rental. Where should I look?';

describe('one decision, two calls', () => {
  it('🟥 lists every name that can leave across BOTH calls', () => {
    const e = askEnvelope(Q, OFFER, WHERE);
    // Round two's routes name tables on both ends, and both ends are subjects.
    // So the union is round one's list, and the person sees all of it up front.
    for (const p of OFFER.paths) {
      assert.ok(e.identifiers.includes(p.from), `${p.from} can leave and was not listed`);
      assert.ok(e.identifiers.includes(p.to), `${p.to} can leave and was not listed`);
    }
    assert.equal(e.stayedInside, true);
    assert.equal(envelopeRefuses(e), false);
  });

  it('🟥 refuses to be one decision when a route escapes the subject list', () => {
    // The property is checked over the routes rather than assumed from how
    // `lookupOffer` builds them today. A later change that let a path arrive
    // somewhere off the list would make one consent cover two different
    // disclosures, and nothing else in the product would notice.
    const escaped: LookupOffer = {
      subjects: OFFER.subjects,
      paths: [
        ...OFFER.paths,
        { id: 's1.p99', from: 'public.customer', to: 'public.secrets', path: [] },
      ],
    };
    const e = askEnvelope(Q, escaped, WHERE);
    assert.equal(e.stayedInside, false);
    assert.equal(envelopeRefuses(e), true);
    assert.match(envelopeNote(e), /cannot be sent as one decision/);
  });

  it('quotes the WORST second call, not a typical one', () => {
    const e = askEnvelope(Q, OFFER, WHERE);
    // Somebody deciding before anybody knows which subject is chosen is owed
    // the ceiling. Every subject's second call must fit under the number they
    // were shown.
    assert.ok(e.secondBytesAtWorst > 0);
    for (const s of OFFER.subjects) {
      const one = askEnvelope(Q, { subjects: [s], paths: OFFER.paths.filter((p) => p.id.startsWith(`${s.id}.`)) }, WHERE);
      assert.ok(
        one.secondBytesAtWorst <= e.secondBytesAtWorst,
        `${s.id} sends more than the ceiling that was disclosed`,
      );
    }
  });

  it('counts the question separately from the menu', () => {
    const e = askEnvelope(Q, OFFER, WHERE);
    assert.equal(e.questionBytes, Buffer.byteLength(Q, 'utf8'));
    // The part they wrote is smaller than the part derived from their schema,
    // and a disclosure that folded the two would hide which is which.
    assert.ok(e.firstBytes > e.questionBytes);
  });

  it('🟥 the sentence counts, and promises nothing', () => {
    const note = envelopeNote(askEnvelope(Q, OFFER, WHERE));
    assert.match(note, /Two calls go to https:\/\/api\.example\.dev/);
    assert.match(note, /no rows from any of them leave at all/);
    // No reassurance. `CLAUDE.md` §3: the reader is accountable and does not
    // understand backends, so what they need is what leaves — not a claim
    // that it is safe, which is not this product's to make.
    for (const word of ['safe', 'secure', 'protected', 'anonymous', 'private']) {
      assert.equal(note.toLowerCase().includes(word), false, `the note promised "${word}"`);
    }
  });
});
