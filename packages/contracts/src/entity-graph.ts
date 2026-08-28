/**
 * How the things in a system connect — ideal §31 and §32.
 *
 * This is the shape that answers *"user A cannot log in — what touches user
 * A?"* without reading a codebase. Ideal §34 and §35 are why it exists at all:
 * handing an AI a whole repository is slow to query and still says nothing
 * about what the data is doing.
 *
 * ## 🟥 The audit that governs this file
 *
 * Ideal §32 drew `user:512` joined to Redis, a trace and Stripe as though the
 * joining were obvious, and the Opus 5 audit under it is the harshest block in
 * the document — *"lỗ hổng kỹ thuật lớn nhất tài liệu"*:
 *
 * ```text
 * Postgres  users.id = 512
 * Stripe    customer  = cus_H8xY2...     nothing to do with 512
 * Redis     sess:a9f3...                 nothing to do with 512
 * Log       "payment failed for 512"     free text, no schema
 * ```
 *
 * The bridge `512 ↔ cus_H8xY2` exists only inside the customer's own database,
 * in a column every project names differently. So an edge is not a fact about
 * a system — it is a CLAIM, and this file's whole job is to keep each claim
 * beside the reason it was made.
 *
 * ## Three tiers, and they are not degrees of the same thing
 *
 * ```text
 * declared    the database itself says so — a FOREIGN KEY constraint.
 *             Postgres enforces it. There is nothing to doubt.
 * measured    nobody declared it, and the VALUES line up anyway. Layer B
 *             counts how many child values have a parent. A number, with
 *             coverage, that somebody can re-run.
 * guessed     a NAME suggests it. `order_id` probably points at `orders`.
 *             No value was compared. This tier is where a wrong edge is
 *             indistinguishable from a right one until somebody looks.
 * ```
 *
 * 🟥 The audit's hard rule, and it is enforced by the type below rather than
 * by a habit: *"cạnh Tầng 3 phải gắn nhãn `inferred` và KHÔNG BAO GIỜ được
 * trình bày như sự thật. Một cạnh sai ở đây tạo ra lời giải thích SAI nhưng
 * RẤT THUYẾT PHỤC — dạng lỗi nguy hiểm nhất của sản phẩm này."*
 *
 * A wrong edge does not produce a wrong-looking answer. It produces a fluent,
 * specific, entirely wrong story about somebody's outage — which is worse than
 * no answer, because a person can act on it.
 *
 * ## What is deliberately NOT here
 *
 * No value is read to build a `guessed` edge. Sol's objection to prefix
 * scanning stands: it can scan production hard, read PII outside its purpose,
 * catch stale or test identifiers, and still only prove a value SHAPE rather
 * than a relationship. Reading values is what `measured` means, and only Layer
 * B does it — inside a query budget, with coverage stated.
 */

import { z } from 'zod';

/**
 * How much this edge is worth, and why.
 *
 * Ordered from strongest, and the order is load-bearing: `strongestFirst`
 * below sorts by it, and a path is only as strong as its weakest hop.
 */
export const EdgeTier = z.enum(['declared', 'measured', 'guessed']);
export type EdgeTier = z.infer<typeof EdgeTier>;

export const EDGE_TIERS = EdgeTier.options;

/** One table, named the way a person would find it in their own tooling. */
export const EntityRef = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRef>;

export function refOf(entity: EntityRef): string {
  return `${entity.schema}.${entity.table}`;
}

/**
 * One connection, and what earns it.
 *
 * `via` is the child column, always — an edge nobody can point at is an edge
 * nobody can check, and this product does not get to assert those. `why` is
 * the sentence a person reads; it names the STEP that produced the edge rather
 * than the conclusion, so somebody can disagree with the reasoning instead of
 * only with the verdict.
 */
const edgeBase = {
  from: EntityRef,
  to: EntityRef,
  /** The column on `from` that holds the reference. */
  via: z.string().min(1),
  why: z.string().refine((s) => s.trim().length > 0, { message: 'why is empty' }),
};

/**
 * How many child values found a parent, out of how many were looked at.
 *
 * `found` cannot exceed `of`: a rate above one is not a strong edge, it is a
 * bug in whatever counted, and letting it parse would put an impossible
 * percentage in front of a person.
 */
export const MatchRate = z
  .object({
    of: z.number().int().nonnegative(),
    found: z.number().int().nonnegative(),
  })
  .refine((m) => m.found <= m.of, { message: 'found exceeds of' });
export type MatchRate = z.infer<typeof MatchRate>;

/**
 * 🟥 A union on `tier`, so `matched` exists on exactly the tier that earns it.
 *
 * It used to be one object with `matched` nullable everywhere, and a comment
 * saying *"null on every other tier"*. That is a comment doing a type's job:
 * `{ tier: 'declared', matched: { of: 100, found: 60 } }` parsed, and it reads
 * as though somebody went and counted 60% of an enforced constraint — a number
 * with no counting behind it, in front of a person who cannot check.
 *
 * The test beside it even said so, and asserted the rule on the BUILDERS
 * instead of on the type. Builders can be added; that one grew from one to
 * two in a day. So the rule moved to the only place that covers every future
 * writer, which is the mechanism this repo already uses for the profile
 * ladder.
 *
 * `measured` now REQUIRES the rate rather than allowing it. A measured edge
 * whose count is missing is not a weak measurement — it is an edge claiming a
 * tier it never earned.
 */
export const EntityEdge = z.discriminatedUnion('tier', [
  z.object({
    ...edgeBase,
    tier: z.literal('declared'),
    // Postgres does not let a constraint it enforces have a bad rate, so
    // there is nothing here to count and no field to put a count in.
    matched: z.null().default(null),
  }),
  z.object({
    ...edgeBase,
    tier: z.literal('measured'),
    matched: MatchRate,
  }),
  z.object({
    ...edgeBase,
    tier: z.literal('guessed'),
    // Nothing was counted. That is what the tier means.
    matched: z.null().default(null),
  }),
]);
export type EntityEdge = z.infer<typeof EntityEdge>;

/**
 * Everything known about how one database hangs together.
 *
 * Edges only. There is no node list, on purpose: a table with no connection to
 * anything is not part of this graph, and inventing an isolated node for it
 * would put something on a screen that says nothing. `entitiesIn` derives the
 * set for a caller that wants it.
 */
export type EntityGraph = {
  readonly edges: readonly EntityEdge[];
};

/** Every table that appears at either end of an edge. */
export function entitiesIn(graph: EntityGraph): string[] {
  const seen = new Set<string>();
  for (const e of graph.edges) {
    seen.add(refOf(e.from));
    seen.add(refOf(e.to));
  }
  return [...seen].sort();
}

/**
 * The declared foreign keys, as edges.
 *
 * The only tier that needs no argument, because somebody wrote the
 * relationship down in the database itself. That is what `declared` records:
 * who says so, not how much of the data obeys.
 *
 * ⚠️ It does NOT mean "Postgres refuses every row that breaks this". This
 * comment said that until 2026-08-28 and it was wrong twice over, both
 * measured the same day:
 *
 * ```text
 * NOT VALID   the key holds for rows written from now on and every row
 *             already there went unchecked. MusicBrainz declares 758 foreign
 *             keys and ALL 758 are NOT VALID.
 * partitions  a key declared on some partitions of a table covers only those.
 *             Pagila's `payment` has 55 and 6 declare a foreign key.
 * ```
 *
 * `NOT VALID` keys stay `declared`, which still looks wrong for a second and
 * is still right: the relationship was written down by somebody who meant it,
 * and the tier answers who says so. What changed is that the edge's `why` now
 * carries the limit instead of the tier pretending there is none. Whether the
 * existing rows honour it is Layer A's question and it has a rule pack for it.
 */
export function declaredEdges(
  constraints: readonly {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
    readonly referencedSchema: string | null;
    readonly referencedTable: string | null;
    /**
     * The connector's word, not the pg catalog letter.
     *
     * ⚠️ Written as `'foreign_key'` because that is what `Constraint.kind`
     * carries — the first draft of this file compared against `'f'`, which is
     * what `pg_constraint.contype` holds, and would have quietly produced a
     * graph with no declared edges at all on every database. A comparison that
     * matches nothing does not fail; it returns an empty list, and an empty
     * graph reads exactly like a database where nothing is connected.
     */
    readonly kind: string;
    /**
     * False when the key was added `NOT VALID` and never validated.
     *
     * 🟥 Not a detail. Postgres enforces such a key for rows written from now
     * on and leaves every row already there unexamined — so "the database
     * enforces this" is a claim about the future tense wearing the present.
     *
     * Measured 2026-08-28: MusicBrainz declares 758 foreign keys and **all 758
     * of them are NOT VALID**. Every declared edge on the largest database
     * this project has ever read would have carried a sentence that is false
     * about the data actually in it. Pagila has exactly 2, and both are
     * `damaged_*` — the fixture already plants this as a defect, and the graph
     * would have reported the planted defect as a guarantee.
     *
     * The connector has read `convalidated` since it was written. The
     * information was on the table and this function threw it away, which is
     * the seam this file was audited for.
     */
    readonly validated?: boolean;
  }[],
  /**
   * Tables that are partitions of another table.
   *
   * 🟥 On Pagila before this existed, `customer` came back with a neighbour
   * per partition — the same relationship wearing a date, over and over. A
   * person asking "what touches this customer" would have read a list of
   * months.
   *
   * ⚠️ An earlier version of this comment said "54 partitions, each carrying
   * its own copy". Counted: **55 partitions, of which 6 declare a FOREIGN
   * KEY** (`payment_p2022_01`–`_06`, 18 of them). The mechanism was right and
   * the magnitude wrong by 9x.
   *
   * ⚠️ And the correction was itself wrong for six hours, in the same passage
   * that lectures about §4.1b. It said "6 declare anything", which is false:
   * ALL 55 declare something — 55 primary keys and 385 NOT NULL constraints —
   * and 6 declare a foreign key. Correcting a loose number with a differently
   * loose one, three copies at once, is the failure mode this file keeps
   * finding in itself. Counted: `field-results` ㉙d.
   *
   * The distinction is what the coverage sentence below rests on: the split is
   * 6-of-55 for foreign keys, and that is the only kind of constraint an edge
   * is about.
   *
   * 🟥 And skipping them outright was WRONG, which the first version of this
   * did. Postgres declares a partitioned table's foreign keys on the
   * PARTITIONS: on Pagila the parent `payment` carries none of its own, so
   * dropping partition-owned constraints deleted the relationship and left the
   * name-guesser to re-derive it as a `guessed` edge. Something the database
   * enforces, demoted to something nobody checked — worse than the 54 copies.
   *
   * So they are REATTRIBUTED, not dropped. The edge is filed under the parent,
   * which is the name a person would recognise, and 54 identical edges collapse
   * to one because they are one relationship.
   */
  partitionOf: ReadonlyMap<string, EntityRef> = new Map(),
): EntityEdge[] {
  const out: EntityEdge[] = [];
  // Which partitions contributed each reattributed edge, and how many the
  // parent has. Read by the coverage pass at the bottom of this function,
  // which is where a key covering SOME partitions stops claiming the table.
  //
  // ⚠️ This said "see `partitionCoverage`" and there is no such function —
  // the pass was written inline and the comment kept pointing at the name it
  // nearly had. A reader looking it up finds nothing and cannot tell whether
  // they are missing a file or the comment is stale.
  const contributors = new Map<string, Set<string>>();
  const partitionCount = new Map<string, number>();
  for (const [child, parent] of partitionOf) {
    void child;
    const key = refOf(parent);
    partitionCount.set(key, (partitionCount.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();

  for (const c of constraints) {
    if (c.kind !== 'foreign_key') continue;
    // Filed under the parent when this is a partition.
    const owner = partitionOf.get(`${c.schema}.${c.table}`) ?? {
      schema: c.schema,
      table: c.table,
    };
    if (c.referencedTable === null || c.referencedSchema === null) continue;
    // A composite key is one relationship, not two. Naming the first column
    // would be a lie by omission, so all of them are named.
    const via = c.columns.join(', ');
    if (via === '') continue;

    // Many partitions of one table carry many copies of one relationship. They
    // are the same edge once the parent's name is on them, so the later ones
    // are folded in rather than shown as a neighbour per month.
    const key = `${owner.schema}.${owner.table}|${via}|${c.referencedSchema}.${c.referencedTable}`;
    const fromPartition = partitionOf.has(`${c.schema}.${c.table}`);
    if (fromPartition) {
      const who = contributors.get(key) ?? new Set<string>();
      who.add(`${c.schema}.${c.table}`);
      contributors.set(key, who);
    }

    const at = seen.get(key);
    if (at !== undefined) continue;
    seen.set(key, out.length);

    out.push({
      from: owner,
      to: { schema: c.referencedSchema, table: c.referencedTable },
      via,
      tier: 'declared',
      // Absent means validated: a caller that never knew about this had a key
      // Postgres was fully enforcing, and the common case keeps the short
      // sentence rather than being hedged for a reason that does not apply.
      why:
        c.validated === false
          ? 'the database has a foreign key for this, but it was declared NOT VALID — ' +
            'it holds for rows written from now on, and the rows already there were ' +
            'never checked against it'
          : 'the database enforces this with a foreign key',
      matched: null,
    });
  }

  // 🟥 A constraint on SOME partitions does not cover the whole table, and
  // saying "the database enforces this" would be the edge claiming more than
  // Postgres is doing.
  //
  // Measured on Pagila: `payment` has 55 partitions and 6 of them declare the
  // foreign key to `customer`. Rows landing in the other 49 — which is most of
  // the table, and all of the recent data — are enforced by nothing. An edge
  // that read "enforced" would be true of eleven percent of a table and stated
  // as though it were true of all of it.
  //
  // The tier stays `declared`, and that is the right call: the tier answers
  // WHO SAYS SO, and the database does. What changes is the sentence, which is
  // where this product keeps the limit of a claim — the same discipline
  // `boundary` enforces on a finding.
  for (const [key, who] of contributors) {
    const at = seen.get(key);
    if (at === undefined) continue;
    const edge = out[at];
    if (edge === undefined) continue;
    const total = partitionCount.get(refOf(edge.from)) ?? who.size;
    if (who.size >= total) continue;

    // Two limits can hold at once, and both have to survive: a key covering 6
    // of 55 partitions that was ALSO never validated is weaker than either
    // sentence alone admits. Rewriting `why` from scratch here would have
    // silently dropped the NOT VALID half.
    const notValid = edge.why.includes('NOT VALID');
    out[at] = {
      ...edge,
      why:
        `the database has a foreign key for this on ${who.size} of the ` +
        `${total} partitions of ${refOf(edge.from)} — rows in the other ` +
        `${total - who.size} are not covered by it` +
        (notValid
          ? ', and where it does exist it was declared NOT VALID, so the rows ' +
            'already there were never checked against it'
          : ''),
    };
  }

  return out;
}

/**
 * Every path out from one table, up to `hops`.
 *
 * Breadth first, so the shortest route to anything is the one returned. A
 * shorter path is not a better explanation, but it is the one a person can
 * follow, and an explanation nobody can follow explains nothing.
 *
 * ⚠️ Follows edges in BOTH directions. `payment.user_id → users` also means
 * "given a user, here are their payments", which is the direction almost every
 * real question travels — somebody asks about a person and needs what happened
 * to them, not what they point at.
 */
export function pathsFrom(
  graph: EntityGraph,
  start: EntityRef,
  hops = 2,
): { to: string; path: readonly EntityEdge[] }[] {
  const from = refOf(start);
  const best = new Map<string, EntityEdge[]>();
  let frontier: { at: string; path: EntityEdge[] }[] = [{ at: from, path: [] }];

  for (let depth = 0; depth < hops; depth += 1) {
    const next: { at: string; path: EntityEdge[] }[] = [];

    for (const step of frontier) {
      for (const edge of graph.edges) {
        const a = refOf(edge.from);
        const b = refOf(edge.to);
        const onward = a === step.at ? b : b === step.at ? a : null;
        if (onward === null || onward === from) continue;
        if (best.has(onward)) continue;

        const path = [...step.path, edge];
        best.set(onward, path);
        next.push({ at: onward, path });
      }
    }

    frontier = next;
    if (frontier.length === 0) break;
  }

  return [...best.entries()]
    .map(([to, path]) => ({ to, path }))
    .sort((a, b) => a.path.length - b.path.length || a.to.localeCompare(b.to));
}

/**
 * How much a whole path is worth.
 *
 * 🟥 The weakest hop decides, and nothing else does. A route of four declared
 * foreign keys and one guess is a GUESS — the certainty of the other four
 * cannot lend anything to the one that was never checked.
 *
 * This is the rule that stops the product telling a confident story built on
 * one unverified link, which the ideal's audit calls the most dangerous
 * failure this design has. It is a function rather than a comment because a
 * comment cannot be called from the place that renders the sentence.
 */
export function pathTier(path: readonly EntityEdge[]): EdgeTier {
  let worst: EdgeTier = 'declared';
  for (const edge of path) {
    if (edge.tier === 'guessed') return 'guessed';
    if (edge.tier === 'measured') worst = 'measured';
  }
  return worst;
}

/**
 * Edges for one table, strongest first.
 *
 * Order matters on a screen: whatever is read first is what a tired person
 * takes away, and this product would rather that be the thing the database
 * itself vouches for than the thing a name suggested.
 */
export function strongestFirst(edges: readonly EntityEdge[]): EntityEdge[] {
  const rank: Record<EdgeTier, number> = { declared: 0, measured: 1, guessed: 2 };
  return [...edges].sort(
    (a, b) => rank[a.tier] - rank[b.tier] || refOf(a.to).localeCompare(refOf(b.to)),
  );
}

/**
 * Edges nobody declared, read out of column names alone.
 *
 * 🟥 The tier the audit is most worried about, and the reason it exists at
 * all: measured on this machine, `se_devops` — a real Stack Exchange schema —
 * declares **zero** foreign keys. Its whole graph from `declaredEdges` is
 * empty, and it is exactly the kind of database somebody inherits and cannot
 * read. A product that only reported what was declared would tell that person
 * their system has no connections in it.
 *
 * ## Every restraint here is deliberate
 *
 * ```text
 * the parent table must EXIST      a guess pointing at nothing is not a
 *                                  weaker guess, it is a wrong one
 * never duplicates a declaration   if Postgres already says it, the guess
 *                                  adds no information and one more line
 * no value is ever read            that is what `measured` means, and Layer B
 *                                  does it inside a query budget
 * a table never points at itself    `users.user_id` is the primary key column
 *                                  of half the schemas ever written
 * ```
 *
 * ## Three rungs, and all three came from counting
 *
 * The first version read only `<name>_id`. Measured across seven real schemas
 * before the other two were added:
 *
 * ```text
 * precision   58 / 58   = 100%   it never once pointed at a wrong table
 * recall      58 / 826  = 7.0%   and on MusicBrainz, 0 out of 758
 * ```
 *
 * 100% precision on 7% recall is not a good rule with a small weakness. The
 * failure mode of this tier is SILENCE, and an empty graph reads exactly like
 * a database where nothing is connected — which is the sentence somebody
 * inheriting a system least needs to be told.
 *
 * ```text
 * ① <name>_id      the convention everyone writes down. `user_id` -> users.
 * ② <name>          the bare parent name as the column. MusicBrainz writes
 *                   390 of its 758 foreign keys this way —
 *                   `alternative_medium.medium` -> `medium` — and rung ① is
 *                   blind to every one of them.
 * ③ ..._<name>_id   a role prefix in front of the parent. `manager_staff_id`
 *                   -> `staff`, `owner_user_id` -> `users`. Pagila's ONLY
 *                   undeclared link is this shape, and so is the common one
 *                   in the Stack Exchange schemas.
 * ```
 *
 * Longest match wins in rung ③, so `invited_by_user_id` finds `users` rather
 * than stopping at something shorter that also happens to exist.
 *
 * ## What this still CANNOT do, said here rather than discovered later
 *
 * MusicBrainz names 210 of its foreign keys `entity0` and `entity1`, and the
 * parent table's name lives in the CHILD TABLE's name (`l_artist_release`),
 * never in the column's. That convention is not read here and is not going to
 * be: it is one project's scheme, n = 1, and a rung built for it would be a
 * guess about a naming SYSTEM layered on a guess about a column. The gap is
 * recorded instead.
 *
 * ## What it scores now, and the shape of the two it gets wrong
 *
 * Re-measured on the same seven schemas after the rungs were added, scoring
 * every guess against a foreign key the database had already declared:
 *
 * ```text
 *              before      after
 * precision    58/58       456/458   = 99.6%
 * recall       58/826      456/831   = 54.9%
 * musicbrainz   0.0%       51.5%
 * ```
 *
 * 🟥 The two it gets wrong are one shape, and it is worth knowing rather than
 * patching: `cdtoc_raw.release` points at `release_raw`, not at `release`. The
 * child table is in a `_raw` family and its references stay in that family —
 * so the guess is plausible, specific, and wrong, which is precisely the
 * failure the §32 audit describes.
 *
 * It is left wrong on purpose. A rule saying "prefer a parent sharing the
 * child's suffix" would be a guess about a naming SYSTEM stacked on a guess
 * about a column, and it is the same reason `entity0` is not read. The tier is
 * called `guessed`, `pathTier` lets one drag a whole route down, and a person
 * is shown the step rather than the conclusion — those three together are the
 * answer to a wrong edge, not a fourth heuristic.
 *
 * And every rung will still connect `order_id` to a table called `orders` in a
 * system where orders live somewhere else entirely. The audit's sentence is
 * the specification: *một cạnh sai ở đây tạo ra lời giải thích SAI nhưng RẤT
 * THUYẾT PHỤC.*
 */
export function guessedEdges(
  tables: readonly { readonly schema: string; readonly table: string }[],
  columns: readonly {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
  }[],
  declared: readonly EntityEdge[] = [],
): EntityEdge[] {
  const present = new Map<string, { schema: string; table: string }>();
  for (const t of tables) present.set(`${t.schema}.${t.table.toLowerCase()}`, t);

  // Keyed on the child column too: a table can point at the same parent twice
  // through different columns, and those are two relationships rather than one
  // duplicate. `crate_owner_invitations` has `invited_by_user_id` and
  // `invited_user_id`, and collapsing them would lose which is which.
  const already = new Set(
    declared.map((e) => `${refOf(e.from)}|${e.via}|${refOf(e.to)}`),
  );

  const out: EntityEdge[] = [];

  /**
   * A table called exactly this, or this with an `s`.
   *
   * The same restraint `profile-observe` states: appending an `s` is not
   * English pluralisation, and guessing at irregulars would be a guess about
   * somebody's naming on top of a guess about their schema. Measured cost of
   * skipping it entirely: crates_io writes 28 of its 35 foreign keys as
   * `<singular>_id` pointing at a `<plural>` table, so a rule without this
   * scores zero there.
   */
  const tableCalled = (schema: string, stem: string) =>
    present.get(`${schema}.${stem}`) ?? present.get(`${schema}.${stem}s`);

  for (const column of columns) {
    const name = column.name.toLowerCase();

    // Rung ①, then ③, then ②. Order is precision-first: an exact `<name>_id`
    // is a better answer than a suffix of it, and both are better than a bare
    // name, which is the rung most likely to catch an ordinary text column
    // that happens to share a table's name.
    let target: { schema: string; table: string } | undefined;
    let how = '';

    if (name.endsWith('_id')) {
      const base = name.slice(0, -'_id'.length);
      if (base !== '') {
        target = tableCalled(column.schema, base);
        if (target !== undefined) {
          how = `the column is called "${column.name}" and there is a table called "${target.table}"`;
        }

        // Rung ③ — a role in front of the parent. Longest suffix first, so
        // `invited_by_user_id` finds `users` rather than stopping at a shorter
        // stem that also happens to exist.
        if (target === undefined) {
          const parts = base.split('_');
          for (let i = 1; i < parts.length; i += 1) {
            const stem = parts.slice(i).join('_');
            if (stem === '') continue;
            const found = tableCalled(column.schema, stem);
            if (found === undefined) continue;
            target = found;
            how =
              `the column is called "${column.name}", and after the "${parts.slice(0, i).join('_')}_" ` +
              `part it names a table called "${found.table}"`;
            break;
          }
        }
      }
    } else {
      // Rung ② — the bare parent name. MusicBrainz writes 390 of 758 this way.
      target = tableCalled(column.schema, name);
      if (target !== undefined) {
        how = `the column is called "${column.name}" and so is a table in this schema`;
      }
    }

    if (target === undefined) continue;

    // A table pointing at itself through `<own name>_id` is a primary key,
    // not a relationship. Half the schemas ever written name it that way.
    if (target.schema === column.schema && target.table === column.table) continue;

    const key = `${column.schema}.${column.table}|${column.name}|${target.schema}.${target.table}`;
    if (already.has(key)) continue;

    out.push({
      from: { schema: column.schema, table: column.table },
      to: { schema: target.schema, table: target.table },
      via: column.name,
      tier: 'guessed',
      // Names the step, not the conclusion — so a person can disagree with the
      // reasoning rather than only with the answer.
      why: `${how}. Nothing checked whether the values line up.`,
      matched: null,
    });
  }

  return out;
}

/**
 * Everything a map can be built from, shaped so `@ledar/contracts` never has
 * to import the connector.
 *
 * Structural, on purpose: `SchemaGraph` from `@ledar/connector-postgres`
 * satisfies this without being named here, so the dependency runs one way and
 * a second source (a fixture, a saved map, another database engine later) can
 * be handed in without this file learning about it.
 */
export type GraphSource = {
  readonly tables: readonly {
    readonly schema: string;
    readonly table: string;
    readonly partitionOf?: { readonly schema: string; readonly table: string } | null;
  }[];
  readonly columns: readonly {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
  }[];
  readonly constraints: readonly {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
    readonly referencedSchema: string | null;
    readonly referencedTable: string | null;
    readonly kind: string;
    readonly validated?: boolean;
  }[];
};

/**
 * The one place a map is assembled.
 *
 * 🟥 It exists because `declaredEdges` and `guessedEdges` were correct,
 * measured, tested — and called by nothing. A caller wiring them up itself has
 * to know three things that are not obvious from either signature: build the
 * partition map first, feed the declared edges INTO the guesser, and keep
 * partitions out of the guesser's inputs. Get any one wrong and the map is
 * still a map, just a wrong one. §4.25b is the same shape: two ways to do
 * something is a second source of truth waiting to drift.
 *
 * ## Why partitions are excluded from the GUESSER but not from `declaredEdges`
 *
 * They are opposite problems, and that is the part worth stating.
 *
 * A partition's declared constraints are the only place the relationship is
 * written down, so dropping them there DELETES it. A partition's columns are
 * copies of the parent's, so keeping them in the guesser MULTIPLIES it —
 * Pagila would emit the same guess 55 times, once per month, and a person
 * asking what touches a customer would read a list of dates.
 *
 * Partitions are also removed as guess TARGETS. `payment_p2022_01` is not a
 * name anybody points a column at, and leaving it in only gives the bare-name
 * rung more ways to be wrong.
 */
export function graphFrom(source: GraphSource): EntityGraph {
  const partitionOf = new Map<string, EntityRef>();
  for (const t of source.tables) {
    if (t.partitionOf === undefined || t.partitionOf === null) continue;
    partitionOf.set(`${t.schema}.${t.table}`, {
      schema: t.partitionOf.schema,
      table: t.partitionOf.table,
    });
  }

  const declared = declaredEdges(source.constraints, partitionOf);

  const named = source.tables.filter((t) => !partitionOf.has(`${t.schema}.${t.table}`));
  const namedColumns = source.columns.filter(
    (c) => !partitionOf.has(`${c.schema}.${c.table}`),
  );

  // Declared first, so `strongestFirst` has nothing to reorder in the common
  // case and a reader sees what the database says before what a name suggests.
  return { edges: [...declared, ...guessedEdges(named, namedColumns, declared)] };
}
