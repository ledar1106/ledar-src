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
Change Date = first made publicly available + 4 years

"First made publicly available" is the moment that exact version becomes
obtainable by anyone who wants it:

    a public repository becoming clonable    ← the one that is easy to miss
    a public git tag
    an npm publish
    a Store release
    a release binary

whichever happens FIRST.

Add the row on the day the version ships. Never backfill from memory.
```

The wording belongs to LICENSE, not to this file. LICENSE sets the Change Date
at *"four years from the date each version of the Licensed Work is first made
publicly available"*, and its Terms convert on that anniversary **or** the
Change Date, *"whichever comes first"*. This ledger therefore records a date;
it does not set one. Nothing written here, and nothing left unwritten here, can
move the date the licence has already fixed.

That is why the list above leads with source becoming clonable. An earlier
version of this rule listed only release events — a tag, an npm publish, a
Store release, a binary — which is narrower than the licence it tracks. Under
the narrower reading a repository can be public for years with this table still
reading *no releases yet*, and the ledger stays satisfied while the thing it
exists to prevent happens anyway. Publishing source counts. It does not have to
be a release, and it does not have to be tagged.

*Never backfill from memory* bans guessing, not reconstruction. A public
repository's own commit history, and the host's record of when that repository
was created, are evidence — a date read from them is not a memory. A row that
names where its date came from can be checked; one that does not, cannot. Name
it.

A row is written by the release process, not by hand at review time. A version
that ships without a row here is an incomplete release.

**Tag every release.** BSL applies separately to each version, so every row has
to say which version it is about. Untagged commits on a public branch cannot
answer that question, and a ledger that cannot name its version is a ledger
that will be argued with.

---

## Released versions

| Package | Version | First made publicly available | Change Date | Change License | Licence file hash |
|---|---|---|---|---|---|
| LEDAR — root Licensed Work | untagged public source, from `86aa78d` | 2026-08-20 | **2030-08-20** | Apache License, Version 2.0 | `b436586522ad051ad4ab2fdae4cdea976a433ebd86181057b371e828d4bf9335` |

**What this row covers.** The Licensed Work as LICENSE defines it: everything in
this repository that does not carry a licence of its own. On the date above that
was the repository's documentation and legal front matter; build configuration,
the CI workflow and the secret scanner joined it two days later. The packages
listed in the next section are Apache 2.0 and are **not** in this row — they
have no Change Date at all, so the table below is the one to read for them.

**Where the date comes from.** `ledar-src` was created 2026-08-20T09:34:37Z and
its first commit, `86aa78d`, landed the same day carrying `LICENSE`,
`CHANGE-DATE-LEDGER.md` and `README.md`. Both facts are readable from the
repository and its host; neither is a recollection.

**Why the earliest defensible date.** Where the exact moment a repository became
reachable is not recorded anywhere, this ledger takes the earliest date the
evidence supports rather than the latest. Naming a date too early converts a
version to Apache 2.0 sooner than strictly required; naming one too late claims
an exclusivity that was not held. The first error costs the Licensor something
small and the second misleads everyone else, so the rule resolves toward the
first — the same direction NOTICE takes when a missing licence file defaults to
BSL. It fails closed.

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
| `apps/engine` | Apache 2.0 | created 2026-08-22 · not on npm |
| `packages/model-client` | Apache 2.0 | source public since 2026-08-25 · not on npm |
| `packages/rule-runner` | Apache 2.0 | created 2026-08-25 · not on npm |
| `apps/desktop` | Apache 2.0 | created 2026-08-26 · source public since 2026-08-27 (Licensor's decision; first push 2026-08-28) · not on npm — the shell is what holds a user's DSN, so whoever owns the data can read the code that touches it |

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
