/**
 * The whole vocabulary between the renderer and the main process.
 *
 * Everything the window can ask for is on this page. That is the point of
 * keeping it in one file: the preload bridge is the security boundary of the
 * shell (AGENTS.md hard rule 7 — being on the same machine is not
 * authentication, and being in the same app is not either), and a boundary
 * whose surface cannot be read in one sitting is a boundary nobody audits.
 *
 * Types only, plus channel names. **No RUNTIME dependencies** — both
 * compilation targets (node and browser) include this file and neither should
 * drag the other's world in through it.
 *
 * ## Why the imports below are `import type`, and why they had to arrive
 *
 * That rule used to be written here as "no imports" and implemented that way,
 * which cost more than it bought. `verbatimModuleSyntax` erases a type-only
 * import completely — no `require`, no `import`, nothing in either bundle — so
 * "no imports at all" bought the same runtime isolation and threw in something
 * nobody meant to pay: **the compiler had no way to notice when this file and
 * `@ledar/contracts` stopped agreeing.**
 *
 * They stopped agreeing. `ReportFinding` was hand-written in the shape of
 * `Finding`, and it drifted three separate times before anyone measured it
 * (debts N49, N50, N51 — all one cause, HANDOFF §1c). A hand-written mirror of
 * a shared shape is a fork that renders correctly, and a screen that renders
 * correctly is exactly what stops anyone looking.
 *
 * So the shapes below are DERIVED rather than described. The test is not that
 * they look the same today — it is that a field renamed in `@ledar/contracts`
 * has to break `tsc --build` here, in `apps/desktop`, and not only in
 * `packages/store`. That is milestone A.2, restated as the thing that must go
 * red rather than the thing it looks like when it is green (AGENTS §4.26).
 */

import type {
  AreaAnswer,
  Timeline,
  ClaimKind,
  Finding,
  KnowledgeState,
  ProfileArea,
  ProfileConflict,
  Verdict,
} from '@ledar/contracts';

export const CHANNELS = {
  /** The SQL shown before any connection exists: create-role and undo. */
  guide: 'ledar:guide',
  appVersion: 'ledar:app-version',
  /** Connect, interrogate the database about itself, hand back the verdict. */
  connect: 'ledar:connect',
  /** Copy text via the OS clipboard. Lives in main so the renderer needs no permission. */
  copyText: 'ledar:copy-text',
  /** Look at the connected database and record the run. Takes a session handle. */
  scan: 'ledar:scan',
  /** The fixed question set, built from @ledar/contracts on the main side. */
  interviewForm: 'ledar:interview-form',
  /** Hand over what the person said; get back the map, reconciled and saved. */
  saveProfile: 'ledar:save-profile',
  /** The person agreed with what was shown for one area. The only path to `verified`. */
  confirmArea: 'ledar:confirm-area',
  /** Where the model lives and whether a key is stored. NEVER the key. */
  modelSettings: 'ledar:model-settings',
  /** The person typed a key. The only path by which one is stored. */
  saveModelSettings: 'ledar:save-model-settings',
  /** Deliberately remove the stored key. Never a side effect of anything. */
  forgetModelKey: 'ledar:forget-model-key',
  /** What one question would send, before a byte moves. Sends nothing itself. */
  askPreview: 'ledar:ask-preview',
  /** The person read the disclosure and agreed. THIS is the call that sends. */
  askSend: 'ledar:ask-send',
  /** Dev-only: prefilled DSN for the smoke run. Null in a packaged build. */
  devPrefill: 'ledar:dev-prefill',
  /** Dev-only: one line the smoke run prints to stdout as its evidence. */
  devReport: 'ledar:dev-report',
} as const;

/** What the database said about this session — every field measured, none assumed. */
export type SessionFacts = {
  currentUser: string;
  database: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  transactionReadOnly: boolean;
  canCreateInDatabase: boolean;
  statementTimeout: string;
  idleInTransactionTimeout: string;
  lockTimeout: string;
};

/** The write that was attempted so the promise would not have to be believed. */
export type WriteProbeFacts =
  | { blocked: true; error: string }
  | { blocked: false };

export type WritableTableFacts = {
  schema: string;
  table: string;
  privileges: string[];
};

/**
 * What was looked at, said by the backend in whole sentences.
 *
 * `lines` come from `describeScope` — numerator and denominator composed on
 * the backend, per reconciliation law 1 (the FE never divides) and law 2
 * (a negative claim carries its scope).
 */
export type ScopeFacts = {
  lines: string[];
  tablesReadable: number;
  tablesInRequestedSchemas: number;
  tablesInDatabase: number;
  /** The exact SQL that takes this access away again. */
  revokeSql: string;
};

export type ConnectOutcome =
  /** The connection never opened. The message is pg's, shown locally, never logged. */
  | { kind: 'connect_error'; message: string }
  /** Superuser or BYPASSRLS. No scan, no override — only the SQL for a proper role. */
  | {
      kind: 'refused';
      reason: string;
      session: SessionFacts;
      probe: WriteProbeFacts;
      roleSql: string;
    }
  /** The role can still write somewhere. Shown plainly, with the repair SQL. */
  | {
      kind: 'writable';
      session: SessionFacts;
      probe: WriteProbeFacts;
      disclosure: string;
      writable: WritableTableFacts[];
      repairSql: string;
      scope: ScopeFacts;
    }
  /** The database itself prevents writes. The sentence S2 exists to earn. */
  | {
      kind: 'read_only_enforced';
      session: SessionFacts;
      probe: WriteProbeFacts;
      scope: ScopeFacts;
      /**
       * The one outcome that opens a session, and deliberately the only one.
       *
       * A handle is issued because the database refused a write in front of
       * us. `writable` and `refused` get none: holding a credential open for
       * a connection this product has just declined to vouch for would be
       * keeping the key to a door it said not to walk through.
       */
      handle: SessionHandle;
    };

/** The create-role and undo SQL shown in the guide, before any connection exists. */
/**
 * Which build this is.
 *
 * 🟥 Shown, because the MSIX handbook's submission checklist asks for the
 * package version and the version the app reads out to AGREE, and until
 * 2026-08-31 this app read it out nowhere at all. A reviewer who cannot see
 * which build they are looking at cannot report a fault against one, and
 * neither can somebody writing a support mail.
 *
 * One source, all the way down: `apps/desktop/package.json` is the version;
 * `infra/pack-msix/build.mjs` writes it into the packaged app AND refuses to
 * build unless `AppxManifest.xml` carries the same number with `.0` after it.
 * `app.getVersion()` reads that same file in both a dev run and an installed
 * one, so there is no second place to keep in step.
 */
export type AppVersion = {
  /** Three parts, as the app reads it: `1.0.0`. */
  readonly version: string;
};

export type GuideBundle = {
  roleSql: string;
  revokeSql: string;
  /** The role name both scripts are written around, so copy matches copy. */
  roleName: string;
};

/**
 * The handle the renderer holds instead of a connection string.
 *
 * Opaque on purpose, and this is the shape Sol named `OperationSession`
 * (audit 2026-08-27, blockers 2 and 3). The DSN stays in the main process for
 * the life of the window; the renderer is handed a string it cannot do
 * anything with except name the session it already proved.
 *
 * ⚠️ This is the CREDENTIAL half only. The other two halves Sol specified —
 * a catalog epoch bound into anything sealed, and an egress authority over
 * what may leave the machine — are NOT here, because nothing in this slice
 * seals a rule or calls a model. Building them now would be guessing at a
 * design that is still open.
 */
export type SessionHandle = string;

/**
 * One rendered finding. Every sentence in it was written by the backend.
 *
 * `plainText` and `technical` are taken FROM `Finding` rather than described
 * again. They are the two fields the window puts on screen verbatim, so they
 * are the two where a silent rename would show up as a blank card rather than
 * as a build error.
 */
export type ReportFinding = Pick<Finding, 'plainText' | 'technical'> & {
  /**
   * Which section of the report this belongs under.
   *
   * `confirms` is what the database itself vouches for; `patterns` is what
   * the product noticed and has NOT confirmed. They are separate because
   * `_doc/25` 3.3 makes provenance decide appearance, and a pattern styled as
   * a fact is the product claiming something it has not earned.
   *
   * Not on `Finding`, and correctly so: a finding does not know which pack
   * vouched for it. This is the one field here the backend adds rather than
   * carries.
   */
  section: 'confirms' | 'patterns';
  /**
   * How strongly this is stated — debt N49, and the contract's own vocabulary.
   *
   * 🟥 Before this existed the only thing on the wire that separated a claim
   * from a negative was `boundary` being non-null, so anything wanting to know
   * *"is this an accusation"* had to read a meaning out of an ABSENCE. The CLI
   * prints its coverage figures unconditionally to avoid precisely that —
   * *"the moment this becomes a thing some reports have and others do not, its
   * absence starts carrying a meaning nobody wrote"* — and this contract had
   * quietly done the thing that comment exists to prevent.
   *
   * `ClaimKind` and not a local union: a sixth kind added in `findings.ts` has
   * to reach every switch on this side as a compile error. A copy of the five
   * names would go on compiling and silently file the new kind as unhandled.
   */
  kind: ClaimKind;
  /**
   * "but only this far" — the limit of the measurement, never cut.
   *
   * Arrives **with its lead-in already attached**, because which lead-in is
   * right is a property of `kind`: a negative caveats a result ("but only this
   * far"), an abstention has no result to caveat and says so instead ("and
   * that is all I can say"). Debt N8 split those kinds precisely so a reader
   * could tell them apart, and composing the sentence on the backend is what
   * keeps that split alive on this surface — the window renders the string, it
   * does not decide what kind of sentence it is.
   *
   * 🟥 It used to be `string | null`, and the null was debt N50 showing
   * through: `_doc/25` S6 asked for a boundary on EVERY finding while only two
   * of the five claim kinds carried one. N50 is paid, so the null is gone —
   * and with it the last field on this contract whose ABSENCE meant something.
   * Nothing else here changed, which was the point of landing `kind` first.
   */
  boundary: string;
};

/**
 * The verdict, straight from `reportVerdict` in contracts.
 *
 * Four kinds, and `_doc/25` is explicit that no two may look alike. In
 * particular `nothing_seen` — an empty database — must carry no success
 * styling at all: not a tick, not a green, nothing. That is the shape a real
 * reader misread in VS-7, and the demo shipped it wrong once already.
 *
 * "Straight from" is now literal. This was a hand-written copy of `Verdict`
 * with the same four names typed out again, so the day a fifth verdict shape
 * is added the window would have gone on compiling and rendered it as none of
 * them. `shapeFor` in the renderer switches over these names exhaustively;
 * aliasing the contract type is what points that switch at the real union.
 */
export type ReportVerdict = Verdict;

export type ScanOutcome =
  /** The session is gone, or was never proved. Nothing ran. */
  | { kind: 'no_session'; message: string }
  /** The scan started and could not finish. Says how far it got. */
  | { kind: 'scan_error'; message: string; historyLines: string[] }
  | {
      kind: 'scanned';
      /**
       * The scope strip. Printed at the TOP and the BOTTOM of the report and
       * never hidden — it is the D in the product's name, not a footnote.
       */
      scopeStrip: string;
      /** The fuller scope sentences, as `describeScope` wrote them. */
      scopeLines: string[];
      verdict: ReportVerdict;
      findings: ReportFinding[];
      /** What the scan cost the database, composed by the backend. */
      costLine: string;
      /**
       * What the budget refused to run, in the budget's own sentence — or null
       * when nothing was cut. Debt N51.
       *
       * 🟥 This field is not a nicety. `QueryBudget` exists to enforce one rule
       * — *never cut quietly* — and its `disclosure()` is the whole of how that
       * rule reaches a person. The CLI prints it. This window recorded it into
       * the history file and then had nowhere to put it, so a desktop reader
       * saw a scan finish, saw findings, and was never told that checks had
       * been skipped because the scan hit its ceiling on their database. They
       * would read that report as covering more than it covered.
       *
       * Null means nothing was cut. It does NOT mean nothing was said: an
       * absent sentence here is the honest shape, because the sentence only
       * exists when there is a refusal to disclose. That is the opposite of
       * `boundary`, where absence was standing in for a claim kind.
       */
      disclosure: string | null;
      /** Where the run was recorded, or why it was not. Always said. */
      historyLines: string[];
      /** The SQL that takes this access away again. */
      revokeSql: string;
    };

export type DevPrefill = { dsn: string; autoconnect: boolean; exitWhenProven: boolean } | null;

/**
 * One question of the fixed set — ideal §14–§18.
 *
 * 🟥 The renderer does not declare this list. It asks for it, and the answer
 * is built from `PROFILE_AREAS` and `AREA_OPTIONS` in `@ledar/contracts`.
 *
 * That round trip buys one thing and it is worth the channel: the window
 * cannot import a runtime value from contracts (nothing bundles zod into a
 * browser context here), so the only alternative was a second copy of the
 * area list living in the renderer. §4.27 is the whole story of what a second
 * copy costs — a third copy of `ClaimKind` sat two hundred lines from the
 * fence built to catch it, and a build ended up refusing to read what it had
 * just written.
 *
 * `area` is `ProfileArea`, not a string: an area added to the contract has to
 * reach every switch on this side as a compile error.
 */
export type InterviewQuestion = {
  readonly area: ProfileArea;
  /**
   * Option ids for the follow-up shown after "yes". Empty for an area that
   * asks only the yes/no question (§18 jobs), and empty is a DECISION here
   * rather than an oversight — see the note on `AREA_OPTIONS`.
   */
  readonly options: readonly string[];
};

/** The whole set, in the order it is asked. */
export type InterviewForm = {
  readonly questions: readonly InterviewQuestion[];
};

/**
 * What the person said about one area. `AreaAnswer` straight from contracts.
 *
 * `picked` is empty unless they answered `yes` AND the area offers options.
 * Nothing here is treated as true: it becomes `stated` on the knowledge
 * ladder, which is a claim, and it has to meet what the scan found before it
 * becomes anything stronger.
 */
export type AreaReply = {
  readonly area: ProfileArea;
  readonly answer: AreaAnswer;
  readonly picked: readonly string[];
};

/**
 * One area of the map, as the window renders it.
 *
 * `state` is `KnowledgeState` from the contract, not a local union — a rung
 * added to the ladder has to reach every switch on this side as a compile
 * error rather than as a card that renders blank.
 *
 * 🟥 `evidence` is empty on exactly the rungs that have none (`unknown`,
 * `stated`), and that is the one place on this contract where an absence
 * carries meaning. It is allowed here and nowhere else, because `state` says
 * which rung this is BEFORE anything reads the array — the meaning is written
 * down in a field, and the emptiness only agrees with it.
 */
export type AreaFacts = {
  readonly area: ProfileArea;
  readonly state: KnowledgeState;
  /** Where it was seen and why, in terms a person can go and check. */
  readonly evidence: readonly { readonly where: string; readonly why: string }[];
  /** What the person said about this area, or null if they have not. */
  readonly stated: AreaAnswer | null;
  /**
   * What they picked from the list when they said yes, in their words.
   *
   * 🟥 Empty until 2026-08-28 because it never left the contract, and it is
   * the half of a profile a person can actually correct: "you said yes" with
   * no record of what they said yes ABOUT is not something anybody can look at
   * and disagree with. §24 says a profile is meant to be edited.
   *
   * Empty on `verified` for the same reason `stated` is null there — the
   * agreement supersedes the answer — and on `unknown`, where nothing was
   * said at all.
   */
  readonly statedPicked: readonly string[];
};

/**
 * The map, after what was said has been put beside what was seen.
 *
 * `conflicts` is `ProfileConflict` from the contract and is the most valuable
 * thing this screen can show: the person said no, the scan found it, and that
 * is the question they did not know to ask. The two DIRECTIONS travel intact
 * because they mean opposite things — one is about their system, the other is
 * about the edge of what this product can see.
 */
/**
 * Re-exported so the preload bridge can name it without importing contracts.
 *
 * The bridge runs sandboxed and resolves nothing but this file; a type it
 * cannot name is a call it cannot type, and an untyped bridge call is the one
 * place a shape could drift with nothing noticing.
 */
export type { ProfileArea };

export type ProfileFacts = {
  readonly version: number;
  readonly areas: readonly AreaFacts[];
  readonly conflicts: readonly ProfileConflict[];
};

/**
 * Where the model lives, and whether a key has been stored.
 *
 * 🟥 `hasKey`, never the key. The window needs to know whether to ask for one;
 * it never needs the value. Sending it would put a credential into a browser
 * context for a reason nobody could state, and "the renderer is ours" is the
 * exact claim this boundary exists to not rely on.
 */
export type ModelSettings = {
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
  /**
   * False when the operating system cannot encrypt — no keyring, a service
   * account. The screen says why it will not take a key, rather than seeming
   * to accept one and losing it.
   */
  readonly canStoreKey: boolean;
};

/** What came of trying to store what somebody typed. */
export type SaveModelOutcome =
  | { kind: 'saved'; settings: ModelSettings }
  | {
      /**
       * The OS cannot encrypt, so nothing was written. 🟥 There is no honest
       * version of "we could not protect this, so we wrote it down".
       */
      kind: 'cannot-encrypt';
    }
  | { kind: 'rejected'; why: string };

/**
 * What one question would send, and what stops it.
 *
 * 🟥 Three outcomes, and `unavailable` is not an error. A build with no model
 * key configured cannot ask anything, and that is a STATE — the same lesson as
 * `saveProfile` returning null before a scan. Dressing a real state as a
 * failure produces the shape this product exists to refuse: a screen that says
 * something went wrong when nothing did.
 */
export type AskPreview =
  | {
      kind: 'ready';
      /** The exact URL both calls go to. */
      destination: string;
      /** Every table name that may leave, across BOTH calls. */
      identifiers: readonly string[];
      /** Bytes of the person's content in the first call. */
      firstBytes: number;
      /** The most the second call can carry, over every subject it could pick. */
      secondBytesAtWorst: number;
      questionBytes: number;
      /** The sentence they read before deciding. Built on the main side. */
      note: string;
    }
  | {
      /**
       * The envelope could not be made safe to agree to ONCE — round two could
       * name something round one did not. Not a bug report: a refusal, and the
       * screen must not offer a send button.
       */
      kind: 'refused';
      why: string;
    }
  | {
      /** No key, or no map. Says which, and neither is an error. */
      kind: 'unavailable';
      reason: 'no-model-configured' | 'no-scan-yet';
    };

/** What came back from an exchange the person agreed to. */
export type AskOutcome =
  | {
      kind: 'answered';
      /**
       * 🟥 The whole `Timeline`, derived from the contract rather than
       * described here. `ReportFinding` was hand-written in the shape of
       * `Finding` and drifted three times (N49, N50, N51) — a hand-written
       * mirror is a fork that renders correctly.
       */
      timeline: Timeline;
      /** N62. Non-null when the question named its own target in schema spelling. */
      provenance: string | null;
      /**
       * The lookup declined to aim at anything, which is an ANSWER.
       *
       * 🟥 Carried across the bridge rather than re-derived in the window.
       * `timelineAimedNowhere` reads a sentinel that belongs to the contract,
       * and the renderer cannot import a runtime value from a package at all —
       * it is served to a browser with no bundler, so a bare specifier is a
       * module the page cannot resolve. That was measured the hard way: it
       * compiled, the suite passed, and the window came up blank.
       */
      aimedNowhere: boolean;
      /** What the two calls cost, in millionths of a dollar. Null when unpriced. */
      costMicros: number | null;
      calls: number;
    }
  | {
      kind: 'unavailable';
      /**
       * What happened, for the person who asked.
       *
       * 🟥 NOT the gate's own words. `sealLookup`'s refusals are written to be
       * read in a failing test — one of them reached a real screen saying
       * *"VS-7 measured what discounted hedging costs · 10745ms"*, which is a
       * field-result reference and a latency figure shown to somebody who does
       * not understand backends and is accountable for one.
       *
       * The gate's sentence is not wrong and is not thrown away; it moves to
       * `detail`, behind a control, where the person who wants it can find it.
       */
      why: string;
      /**
       * The gate's own sentence, for whoever wants it. Null when there is none.
       *
       * Kept rather than dropped: it names which rule refused, and that is the
       * only thing that tells a developer — or the Licensor reading a support
       * mail — what actually happened.
       */
      detail: string | null;
      /**
       * 🟥 N62's note, on the FAILURE path too, and this field exists because
       * of what happened without it.
       *
       * Driving the real window with ㉜'s payload — *"trace it from
       * public.staff"* — the model aimed at `public.staff`, which has no
       * `customer_id`. Postgres refused, `runTrace` threw, and the raw
       * `column t0.customer_id does not exist` went to the screen. The
       * provenance note never rendered.
       *
       * So the one disclosure written to explain a steered target was
       * silenced by the steering succeeding. The explanation belongs to this
       * case MORE than to the answered one: a reader looking at a failed
       * lookup needs to know it was aimed somewhere their question named.
       */
      provenance: string | null;
      /**
       * Whether anything actually left the machine before this failed.
       *
       * 🟥 Added 2026-08-31 because the window had no way to tell, and the
       * consequence was a DEAD BUTTON. Driving the real app: the two row
       * fields carry placeholders that look like values — `customer_id` and
       * `1`, in grey — so pressing Send with them empty is the obvious first
       * move. `askSend` refuses before it connects to anything, correctly,
       * with *"Which row this is about was not given."* But the window had
       * disabled Send and Cancel on the click and re-enabled neither. Filling
       * the fields in and pressing Send again did nothing, forever. The only
       * way out was to type the whole question a second time.
       *
       * The window cannot simply re-enable on every failure either: some of
       * these refusals happen AFTER two calls have been paid for, and a live
       * button there would offer to spend again with no hint that it would.
       *
       * So the fact travels with the outcome instead of being guessed at.
       * False means nothing was sent and the agreement is still unspent —
       * the person may correct what they typed and press Send. True means
       * the exchange happened; asking again is a new question.
       */
      sent: boolean;
    };

/** The API `window.ledar` exposes. The preload bridge implements exactly this. */
export type LedarBridge = {
  guide(): Promise<GuideBundle>;
  /** Which build this is, for the sidebar. */
  appVersion(): Promise<AppVersion>;
  connect(dsn: string): Promise<ConnectOutcome>;
  scan(session: SessionHandle): Promise<ScanOutcome>;
  copyText(text: string): Promise<boolean>;
  interviewForm(): Promise<InterviewForm>;
  /**
   * Hands over what the person said and gets the reconciled map back.
   *
   * The window sends answers and receives a MAP, never the other way round:
   * reconciling is the main side's job because that is where the scan's
   * observations live, and a renderer that could assemble a profile could
   * assemble one that was never measured.
   */
  /**
   * 🟥 `null` when no scan has happened, and the type has to say so.
   *
   * It said `Promise<ProfileFacts>` until 2026-08-28 while the handler
   * returned `ProfileFacts | null`, so the window was told a case could not
   * arise that arises whenever answers are sent before a database has been
   * read. `ipcMain.handle` RESOLVES with null — it does not reject — so the
   * null went straight into the success path, the "here is your map" bubble
   * was built, and only then did drawing the cards throw. A person got an
   * empty map followed by a message saying the map could not be built.
   *
   * The answers are about a database. Until one has been read there is
   * nothing for them to be about, and that is a real state rather than an
   * error to dress up.
   */
  saveProfile(replies: readonly AreaReply[]): Promise<ProfileFacts | null>;
  /**
   * The person looked at what was found for one area and agreed.
   *
   * 🟥 The ONLY path to `verified` in the whole product. That rung means a
   * human signed it, every later screen reads it as settled, and nothing but
   * a person pressing this may produce it.
   */
  confirmArea(area: ProfileArea): Promise<ProfileFacts | null>;
  /**
   * What this question would send. Sends NOTHING.
   *
   * Split from `askSend` so that the disclosure and the sending are two calls
   * a reader of the bridge can tell apart. A single method with a `confirm`
   * flag would put the boundary inside an argument.
   */
  /** Where the model lives and whether a key is stored. Never the key. */
  modelSettings(): Promise<ModelSettings>;
  /**
   * Store what the person typed.
   *
   * An empty `key` means "leave the stored one alone", so somebody changing
   * the model name does not silently lose their credential. `forgetModelKey`
   * is the deliberate way to remove it.
   */
  saveModelSettings(baseUrl: string, model: string, key: string): Promise<SaveModelOutcome>;
  forgetModelKey(): Promise<ModelSettings>;
  askPreview(session: SessionHandle, question: string): Promise<AskPreview>;
  /**
   * The person read it and agreed. This is the only call that sends anything.
   *
   * 🟥 Takes the question again rather than a token from the preview. A token
   * would let the two calls disagree about what was agreed to, and the permit
   * is granted on THIS side from THESE bytes — so what is disclosed and what
   * is hashed come from one string, not two that matched a moment ago.
   */
  askSend(
    session: SessionHandle,
    question: string,
    subjectKey: string,
    subjectValue: string,
  ): Promise<AskOutcome>;
  devPrefill(): Promise<DevPrefill>;
  devReport(line: string): void;
};
