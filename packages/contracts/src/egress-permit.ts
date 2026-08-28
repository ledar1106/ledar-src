/**
 * Nothing about somebody's system leaves this machine without a permit that
 * names exactly what is leaving.
 *
 * `_doc/27` Module 4, from Sol's fourth round. The invariant, verbatim:
 *
 * > *"Model client **chỉ được gửi khi có permit khớp CHÍNH XÁC** với: toàn bộ
 * > outbound body chứa dữ liệu của khách hàng · destination cụ thể · lớp dữ
 * > liệu · phiên bản consent, retention và redaction · ĐÚNG MỘT operation chưa
 * > được dùng."*
 *
 * And the line that decides the shape of this file:
 *
 * > 🟥 *"Tên schema, bảng và cột THUỘC payload được bảo vệ, không chỉ câu
 * > người dùng."*
 *
 * ## Why a hash of the whole body, and not a list of what is allowed
 *
 * An allowlist answers "may this kind of thing go". The question that matters
 * is "is what is about to go the thing somebody agreed to", and those come
 * apart the moment anything is assembled after consent. A permit over the
 * exact bytes cannot come apart: change one schema identifier and the hash
 * changes, so the permit stops matching and the send never happens.
 *
 * That is also what makes the red test in `_doc/27` possible at all — *grant a
 * permit, then change exactly one schema identifier; if the network function
 * is called, the module has failed.*
 *
 * ## What this file does NOT do
 *
 * It does not decide whether consent was given, and it does not draw
 * anything. `describeEgress` produces the list a person is shown; showing it
 * and getting an answer belongs to whichever surface has a person in front of
 * it. This file is the part that can be checked by a machine afterwards.
 *
 * It also does not enforce the gate. Sol was explicit that the gate belongs
 * inside `model-client`, the seam every call must cross, because a check at
 * each call site reproduces AGENTS §4.3 — *a gate that exists and that the
 * real path does not call.*
 */

import { createHash } from 'node:crypto';

import { EgressClass } from './findings.js';
import type { PromptParts } from './untrusted.js';

/**
 * The strictest class wins, and the order is the point.
 *
 * A payload carrying one `never-leaves` block is a `never-leaves` payload
 * however much `product-constant` is around it. Sorting by "what is the worst
 * thing in here" is the only aggregation that cannot be argued down.
 */
const STRICTNESS: Record<EgressClass, number> = {
  'never-leaves': 0,
  'customer-system-metadata': 1,
  'product-constant': 2,
};

/** One block of the payload, as a person is shown it. */
export type DisclosedBlock = {
  /** This product's own heading for the block. Never the content. */
  readonly label: string;
  readonly egressClass: EgressClass;
  /** How much of it there is. A person deciding is entitled to the size. */
  readonly bytes: number;
};

/**
 * What a person sees before they are asked.
 *
 * Derived from the prompt's own parts rather than described by the caller,
 * and that is deliberate: a caller writing its own summary can under-report,
 * and under-reporting is the failure this whole module exists to prevent.
 */
export type EgressDisclosure = {
  /** Exactly where it goes. Not a hostname, the URL that will be called. */
  readonly destination: string;
  /** The strictest class anywhere in the payload. */
  readonly dataClass: EgressClass;
  readonly blocks: readonly DisclosedBlock[];
  /** Total bytes of untrusted content. The instruction is ours and is not counted. */
  readonly bytes: number;
  /**
   * Identifiers from the customer's system that are in the payload.
   *
   * The caller offers candidates — only it knows which strings are names of
   * somebody's tables rather than ordinary words — and this list is the ones
   * actually FOUND in the untrusted content. A person is shown what is
   * demonstrably going, not what a caller believed was going.
   *
   * That direction matters. A screen that over-lists frightens somebody about
   * data that is staying put; one that under-lists gets consent for something
   * they were not told about. Deriving from the content can only produce the
   * first kind of error if the content itself is wrong, and `grantEgress`
   * catches the list drifting from the final body afterwards.
   */
  readonly identifiers: readonly string[];
};

export class EgressRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefused';
  }
}

/**
 * Builds the disclosure from the prompt this payload is made of.
 *
 * Refuses a payload containing anything `never-leaves`, and refuses it here
 * rather than at the seam: a person must not be shown a consent screen for
 * something that was never allowed to travel in the first place. `sealPrompt`
 * refuses the same class for the same reason, one layer down.
 */
export function describeEgress(
  parts: PromptParts,
  destination: string,
  /**
   * Names the caller believes are in there. Only the ones that really are
   * reach the disclosure — see `EgressDisclosure.identifiers`.
   */
  candidates: readonly string[] = [],
): EgressDisclosure {
  const blocks: DisclosedBlock[] = parts.untrusted.map((b) => ({
    label: b.label,
    egressClass: b.egressClass,
    bytes: Buffer.byteLength(b.content, 'utf8'),
  }));

  const worst = blocks.reduce<EgressClass>(
    (acc, b) => (STRICTNESS[b.egressClass] < STRICTNESS[acc] ? b.egressClass : acc),
    'product-constant',
  );

  if (worst === 'never-leaves') {
    const named = blocks
      .filter((b) => b.egressClass === 'never-leaves')
      .map((b) => JSON.stringify(b.label))
      .join(', ');
    throw new EgressRefused(
      `Refusing to describe an egress carrying ${named}, which is classified ` +
        `never-leaves. There is no consent screen for this: the class means ` +
        `the rule that produced it said the data may not go anywhere, and ` +
        `asking a person to approve it would turn a boundary into a prompt.`,
    );
  }

  // Searched in the untrusted content only. The instruction is this product's
  // own words, so a table name matching something we wrote would be a
  // coincidence rather than an identifier on its way out.
  const content = parts.untrusted.map((b) => b.content).join('\n');
  const found = [...new Set(candidates.filter((c) => c !== '' && content.includes(c)))].sort();

  return {
    destination,
    dataClass: worst,
    blocks,
    bytes: blocks.reduce((n, b) => n + b.bytes, 0),
    identifiers: found,
  };
}

declare const PERMIT_SEAL: unique symbol;

/**
 * Permission to send one specific payload, once.
 *
 * Branded so nothing downstream can accept an object somebody assembled. The
 * fields are what `checkEgress` compares, and every one of them is something
 * a person was shown before they agreed.
 */
export type EgressPermit = {
  /** Distinguishes two permits over identical bytes. Spent by id. */
  readonly id: string;
  /** sha256 of the exact bytes that will go on the wire. */
  readonly bodyHash: string;
  readonly destination: string;
  readonly dataClass: EgressClass;
  /**
   * Consent, retention and redaction versions, as one string.
   *
   * One field rather than three because they are compared together and never
   * separately: a permit issued under one retention policy is not a permit
   * under another, and a caller that could match two of three would have a
   * way to be partly right.
   */
  readonly policy: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  /** What the person was shown. Carried so a refusal can quote it back. */
  readonly disclosure: EgressDisclosure;
} & { readonly [PERMIT_SEAL]: 'granted over these exact bytes' };

export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export type GrantOptions = {
  readonly disclosure: EgressDisclosure;
  /** The exact bytes. Hashed here so the caller cannot hash something else. */
  readonly body: string;
  readonly policy: string;
  /** ISO. Passed in rather than read from the clock, so a grant is reproducible. */
  readonly now: string;
  readonly ttlMs: number;
  /** Unique per grant. Passed in for the same reason `now` is. */
  readonly id: string;
};

/**
 * Issues a permit over bytes that have already been built.
 *
 * Takes the body rather than a hash of it. A caller that could pass a hash
 * could pass the hash of something else, and the whole guarantee is that the
 * thing shown and the thing sent are one thing.
 */
export function grantEgress(opts: GrantOptions): EgressPermit {
  if (opts.ttlMs <= 0) {
    throw new EgressRefused(
      `A permit with no life is not a permit. ttlMs was ${opts.ttlMs}.`,
    );
  }

  // The identifiers a person was shown have to be in what is being sent. This
  // catches the disclosure drifting from the payload — a screen listing three
  // tables over a body that mentions four is a screen that got consent for
  // something else.
  const absent = opts.disclosure.identifiers.filter((i) => !opts.body.includes(i));
  if (absent.length > 0) {
    throw new EgressRefused(
      `The disclosure names ${absent.map((a) => JSON.stringify(a)).join(', ')}, ` +
        `which ${absent.length === 1 ? 'is' : 'are'} not in the payload. A ` +
        `consent screen that does not describe what is being sent is worse ` +
        `than none: it is a person agreeing to a different thing.`,
    );
  }

  const granted = Date.parse(opts.now);
  if (Number.isNaN(granted)) {
    throw new EgressRefused(`grantedAt is not a time: ${JSON.stringify(opts.now)}.`);
  }

  return {
    id: opts.id,
    bodyHash: hashBody(opts.body),
    destination: opts.disclosure.destination,
    dataClass: opts.disclosure.dataClass,
    policy: opts.policy,
    grantedAt: new Date(granted).toISOString(),
    expiresAt: new Date(granted + opts.ttlMs).toISOString(),
    disclosure: opts.disclosure,
  } as EgressPermit;
}

/** What is actually about to happen, for the permit to be checked against. */
export type Outbound = {
  readonly body: string;
  readonly destination: string;
  readonly dataClass: EgressClass;
  readonly policy: string;
};

/**
 * Refuses unless the permit matches what is about to be sent, exactly.
 *
 * Every branch below is a way for a permit to be *nearly* right, and the
 * reason they are separate messages is that a caller reading one needs to
 * know which of its five bindings drifted.
 */
export function checkEgress(permit: EgressPermit, actual: Outbound, now: string): void {
  const at = Date.parse(now);
  if (Number.isNaN(at)) {
    throw new EgressRefused(`The current time is not a time: ${JSON.stringify(now)}.`);
  }
  if (at >= Date.parse(permit.expiresAt)) {
    throw new EgressRefused(
      `This permit expired at ${permit.expiresAt} and it is now ${now}. ` +
        `Consent is about a moment; a permit that outlives the screen it came ` +
        `from is a signature on a blank page.`,
    );
  }

  if (permit.destination !== actual.destination) {
    throw new EgressRefused(
      `This permit is for ${permit.destination} and the request is going to ` +
        `${actual.destination}. A destination the person did not see is a ` +
        `different disclosure, whatever the payload says.`,
    );
  }

  if (permit.dataClass !== actual.dataClass) {
    throw new EgressRefused(
      `This permit covers ${permit.dataClass} and the payload is ` +
        `${actual.dataClass}.`,
    );
  }

  if (permit.policy !== actual.policy) {
    throw new EgressRefused(
      `This permit was granted under policy ${JSON.stringify(permit.policy)} ` +
        `and the current policy is ${JSON.stringify(actual.policy)}. Consent ` +
        `given under one retention rule is not consent under another.`,
    );
  }

  // 🟥 The one the module exists for. One changed schema identifier changes
  // the bytes, changes the hash, and stops here — before the network, which
  // is the whole of `_doc/27`'s red test.
  const actualHash = hashBody(actual.body);
  if (permit.bodyHash !== actualHash) {
    throw new EgressRefused(
      `The payload is not the one this permit was granted over. Permitted ` +
        `${permit.bodyHash.slice(0, 16)}…, about to send ` +
        `${actualHash.slice(0, 16)}…. One changed identifier is enough to do ` +
        `this, and that is the point: what was shown and what is sent are ` +
        `one thing or the send does not happen.`,
    );
  }
}

/**
 * Which permits have been spent.
 *
 * One-shot is a property of the SYSTEM rather than of the permit object — a
 * value cannot remember that it was used — so somebody has to hold the list.
 * It is a class rather than module state so a test, a window and a CLI each
 * get their own, and so closing a session can drop the lot.
 */
export class PermitLedger {
  private readonly spent = new Set<string>();

  /**
   * Marks one permit used, or refuses because it already was.
   *
   * Called by the seam immediately before sending, never by a caller. A
   * permit spent by whoever remembered to is a permit that can be spent twice
   * by whoever did not.
   */
  spend(permit: EgressPermit): void {
    if (this.spent.has(permit.id)) {
      throw new EgressRefused(
        `This permit has already been used. One grant is one send: a permit ` +
          `that could be replayed would make a person's single "yes" cover ` +
          `every call after it.`,
      );
    }
    this.spent.add(permit.id);
  }

  /** Drops everything, when a session ends. */
  forget(): void {
    this.spent.clear();
  }

  get size(): number {
    return this.spent.size;
  }
}
