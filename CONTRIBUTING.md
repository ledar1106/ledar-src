# Contributing to LEDAR

## Right now

**There is no product code in this repository yet**, so there is nothing to
send a pull request against. Issues and discussion are open and welcome.

What the project is doing instead is measuring, on real databases, whether
the signal it depends on actually exists. Until that question has an answer,
writing code would mean risking building the right thing for nobody.

This page exists now rather than later because the contributor agreement had
to be decided **before** the first contribution arrives. Deciding afterwards
means going back to every contributor and asking them to agree retroactively,
which usually fails.

---

## The agreement: DCO, not a CLA

LEDAR uses the [Developer Certificate of Origin](https://developercertificate.org/).
There is no separate agreement to sign, no bot to authorise, no account to
create.

You add one line to each commit:

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you.

That line means you are certifying the DCO: that you wrote the contribution
or otherwise have the right to submit it under the licence covering the file
you touched.

### What this means for you

**You keep your copyright.** The project receives the right to use your
contribution under the licence that already applies to that file — and
nothing more.

Concretely: **your contribution can never be moved into a closed commercial
tier.** Not by the current Licensor, not by a future owner. Doing that would
require asking you, individually, and you would be free to say no.

### Why not a CLA

A CLA would let the project relicense contributions later, including into a
proprietary tier. That option was deliberately given up.

The parts of LEDAR that outside contributors can work on — connectors, rule
packs, shared contracts, the CLI — are permanently Apache 2.0 by design, and
the project's own architecture rules forbid moving that kind of code into a
paid tier. A CLA buys an option this project has already promised never to
use, and charges contributors friction for it.

There is a real cost to this choice: if the boundary ever needs to move, it
cannot be moved quietly. That is intended.

---

## Licence boundaries

Which licence applies depends on where the file lives:

| Location | Licence |
|---|---|
| A package with its own `LICENSE` file | that licence — Apache 2.0 |
| Everything else | [Business Source License 1.1](LICENSE) |

A package carrying its own `LICENSE` is **not** covered by BSL. That is the
mechanism, not a footnote: it is what lets connectors and rule packs be
contributed and reused freely without touching the BSL-covered engine.

Each BSL version converts to Apache 2.0 four years after it is first
published. Conversion dates are tracked per release in
[`CHANGE-DATE-LEDGER.md`](CHANGE-DATE-LEDGER.md).

---

## What this project will hold contributions to

These are not style preferences. They are what the product's name commits to,
and code that breaks them will be rejected however well written it is.

```text
L  Look       Read-only. Always. The engine never writes to a user's
              database — no migrations, no fixes, no "just this once".
              The most it may do is print SQL for a human to run.

E  Explain    Every finding carries plain language a non-technical owner
              can act on. Jargon-only output is an incomplete finding.

D  Disclose   A negative claim without a coverage boundary is refused, not
              softened. "No problems found" must say in what scope, and
              what was not looked at.

A  Admit      An observed pattern is never called a bug until its intent is
              confirmed by the person who owns the system.

R  Retain     Nothing leaves the user's machine except a redacted evidence
              pack the user can inspect.
```

An LLM never decides what counts as a violation. Detection is deterministic;
the model explains, teaches and answers questions about results it did not
produce.

---

## Reporting a security issue

Do not open a public issue. Security reports go to the address listed on
[ledar.app](https://ledar.app).

Given what this software connects to, the reports that matter most are:
anything that could cause a write, a lock, or resource exhaustion on a user's
database, and anything that could move real data off a user's machine.
