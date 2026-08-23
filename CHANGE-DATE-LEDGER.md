# Change Date Ledger

> The Business Source License applies **separately to each version**, and the
> Change Date may differ between versions. Without this ledger nobody —
> including the Licensor — can say which released version has already
> converted to Apache 2.0.
>
> Source: [Business Source License 1.1](https://mariadb.com/bsl11/) — *"This
> License applies separately for each version of the Licensed Work and the
> Change Date may vary for each version."*

---

## Rule

```text
Change Date = first public distribution + 4 years

"First public distribution" is the moment that exact version becomes
downloadable by anyone: a public git tag, an npm publish, a Store release,
or a release binary — whichever happens FIRST.

Add the row on the day the version ships. Never backfill from memory.
```

A row is written by the release process, not by hand at review time. A version
that ships without a row here is an incomplete release.

---

## Released versions

| Package | Version | First public distribution | Change Date | Change License | Licence file hash |
|---|---|---|---|---|---|
| *(no releases yet)* | | | | | |

---

## Apache 2.0 packages — not covered by this ledger

Packages that carry their own `LICENSE` are **not** governed by BSL, so they
have no Change Date. They are listed here only so the boundary stays visible.

| Package | Licence | Status |
|---|---|---|
| `packages/contracts` | Apache 2.0 | source public since 2026-08-22 · not on npm |
| `packages/connector-postgres` | Apache 2.0 | source public since 2026-08-22 · not on npm |
| `packages/packs-layer-a` | Apache 2.0 | source public since 2026-08-22 · not on npm |
| `packages/packs-layer-b` | Apache 2.0 | source public since 2026-08-22 · not on npm |
| `packages/store` | Apache 2.0 | source public since 2026-08-22 · not on npm |
| `packages/test-fixtures` | Apache 2.0 | source public since 2026-08-22 · `private: true`, never goes to npm |
| `apps/cli` | Apache 2.0 | source public since 2026-08-22 · not on npm |

> Wildcards used to stand in this table — `packages/connector-*`,
> `packages/packs-*` — each marked *does not exist yet*. All seven existed by
> 2026-08-22 and were published, and the table still said otherwise. A licence
> boundary that nobody re-reads is a licence boundary that drifts, so it is
> checked by machine now: `python infra/check-licences.py` fails if a package
> has no `LICENSE`, if its `package.json` disagrees with that file, or if this
> table names something that does not exist or misses something that does.

> ⚠️ **A missing `LICENSE` file makes that package BSL by default**, which
> closes the contribution path for it. The Apache file has to land in the same
> commit that creates the package, not afterwards.

---

## How to describe this publicly

```text
✅ "source-available, converts to Apache 2.0 after at most four years"
❌ "open source"   — untrue until the Change Date, and BSL says so itself
❌ "open core"     — there is no proprietary tier yet; claiming one is a
                     promise made in advance
```

This wording applies to the landing page, the Store listing, this repository,
and anywhere else the project is described.

---

*Started 2026-08-20. One row per release; rows are never removed.*
