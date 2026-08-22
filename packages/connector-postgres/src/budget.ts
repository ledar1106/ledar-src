/**
 * A ceiling on what a scan may spend of someone else's database.
 *
 * The rule this enforces is not "stay under the limit" — it is **never cut
 * quietly**. A scan that stops early and says nothing produces a report
 * indistinguishable from a complete one, which is the same lie as calling an
 * empty table clean. Every refusal is recorded and has to surface.
 *
 * The limits are deliberately conservative. This runs against production
 * databases belonging to people who have no way to judge whether it is safe,
 * so the cost of being wrong is theirs, not ours.
 */

export type BudgetLimits = {
  /** Verification queries. Catalog reads are free — they touch no data. */
  maxQueries: number;
  /** Wall-clock spent inside queries, across the whole scan. */
  maxTotalMs: number;
  /** Rows the database had to look at, as far as we can tell. */
  maxRowsScanned: number;
};

export const DEFAULT_LIMITS: BudgetLimits = {
  maxQueries: 200,
  maxTotalMs: 120_000,
  maxRowsScanned: 5_000_000,
};

export type Denial = {
  what: string;
  limit: keyof BudgetLimits;
  spent: number;
  ceiling: number;
};

export type BudgetSpend = {
  queries: number;
  totalMs: number;
  rowsScanned: number;
};

export class QueryBudget {
  private queries = 0;
  private totalMs = 0;
  private rowsScanned = 0;
  private readonly denials: Denial[] = [];

  constructor(
    private readonly limits: BudgetLimits = DEFAULT_LIMITS,
    /** Set on a share; spending flows up so the total ceiling still holds. */
    private readonly parent: QueryBudget | null = null,
  ) {}

  /**
   * Carves out a fraction of what is left, for one rule class.
   *
   * Without this the first rule to run spends everything. On MusicBrainz that
   * is exactly what happened: 746 unvalidated constraints consumed all 200
   * queries, and the second layer found seven things worth checking and
   * checked none of them. The report disclosed the skip honestly and was
   * still the wrong answer — an honest account of a bad decision is not the
   * same as a good one.
   */
  share(fraction: number): QueryBudget {
    const f = Math.max(0, Math.min(1, fraction));
    const child = new QueryBudget(
      {
        maxQueries: Math.floor(this.limits.maxQueries * f),
        maxTotalMs: Math.floor(this.limits.maxTotalMs * f),
        maxRowsScanned: Math.floor(this.limits.maxRowsScanned * f),
      },
      this,
    );
    return child;
  }

  /**
   * Asks whether one more query is affordable.
   *
   * Returns false and records why, rather than throwing: a rule that runs out
   * of budget has not failed, it has been cut short — and the difference
   * matters to whoever reads the report.
   */
  canAfford(what: string): boolean {
    if (this.queries >= this.limits.maxQueries) {
      this.deny(what, 'maxQueries', this.queries, this.limits.maxQueries);
      return false;
    }
    if (this.totalMs >= this.limits.maxTotalMs) {
      this.deny(what, 'maxTotalMs', Math.round(this.totalMs), this.limits.maxTotalMs);
      return false;
    }
    if (this.rowsScanned >= this.limits.maxRowsScanned) {
      this.deny(what, 'maxRowsScanned', this.rowsScanned, this.limits.maxRowsScanned);
      return false;
    }
    return true;
  }

  record(durationMs: number, rows: number): void {
    this.queries += 1;
    this.totalMs += durationMs;
    this.rowsScanned += Math.max(0, rows);
    this.parent?.record(durationMs, rows);
  }

  private deny(what: string, limit: keyof BudgetLimits, spent: number, ceiling: number): void {
    // One entry per thing refused. Fifty identical lines help nobody, but a
    // count of how many were refused does.
    this.denials.push({ what, limit, spent, ceiling });
    this.parent?.denials.push({ what, limit, spent, ceiling });
  }

  get exhausted(): boolean {
    return this.denials.length > 0;
  }

  get spend(): BudgetSpend {
    return {
      queries: this.queries,
      totalMs: Math.round(this.totalMs),
      rowsScanned: this.rowsScanned,
    };
  }

  get refused(): readonly Denial[] {
    return this.denials;
  }

  /**
   * The sentence that has to appear when anything was cut.
   *
   * Written for someone who will otherwise read "nothing found" as "nothing
   * is wrong".
   */
  disclosure(): string | null {
    if (this.denials.length === 0) return null;
    const first = this.denials[0]!;
    const reason: Record<keyof BudgetLimits, string> = {
      maxQueries: `${first.ceiling} queries`,
      maxTotalMs: `${Math.round(first.ceiling / 1000)} seconds of database time`,
      maxRowsScanned: `${first.ceiling.toLocaleString('en-US')} rows`,
    };
    const n = this.denials.length;
    return (
      `Stopped early: this scan is allowed ${reason[first.limit]} against your ` +
      `database and reached that ceiling, so ${n} ${n === 1 ? 'check was' : 'checks were'} ` +
      `not run. What is missing from this report is not the same as what is ` +
      `absent from your data.`
    );
  }
}
