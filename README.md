# LEDAR

**Look · Explain · Disclose · Admit · Retain**

An AI employee that runs on your machine. It asks you a few questions, works
out what is inside your database, tells you what it found in plain language,
answers follow-up questions, and teaches you how to do the things you do not
yet know how to do.

---

## Who this is for

People who **do not understand backends but are responsible for one**.

- Founders who shipped a product built with AI and cannot see inside it
- The last person standing after a layoff, keeping a system alive
- Anyone who just inherited a system from a developer or agency that has gone

You have a database connection string, or you can get one. What you do not
have is the ability to read a schema. That gap is what LEDAR fills.

**This is not for backend or data engineers.** You already have `psql`,
DBeaver, dbt tests and Great Expectations — and you already know what you are
looking for.

---

## What makes it different

Other tools answer the question you asked. LEDAR raises the question you did
not know you needed to ask.

> *"47 orders point at customers that no longer exist. If one of them calls,
> you cannot tell who they are."*

Nobody types that query if they do not already know the problem exists.

And one thing no other tool does: **it tells you what it has not looked at,
and what it does not understand.** That is not a marketing line, it is the
middle of the name — Disclose and Admit — and it is enforced in the codebase:

- A negative claim without a coverage boundary is refused, not softened
- Observation and inference are visually distinct, never blended
- A pattern it merely observed is never called a "bug" until you confirm the
  intent behind it

---

## Safety

- **Read-only. Always.** LEDAR never writes to your database. Not migrations,
  not fixes, not "just this once". The most it will ever do is print SQL for
  you to run yourself.
- Runs on your machine. Your data does not leave it.
- Connects through a read-only role with hard statement, lock and idle
  timeouts, because a long-running `SELECT` can stall a table during a
  migration even without write permission.

---

## Status

**Pre-release. There is no product code in this repository yet, and that is
deliberate.**

The project is in a field-measurement phase: connecting to real databases
belonging to real people, and measuring whether the signal this product
depends on actually exists. Building before that answer is known would mean
risking building the right thing for nobody.

Three questions are open, and none of them have been answered yet:

1. Do real databases contain enough findings that their owners did not
   already know about?
2. Does the AI layer cost less to run than it can be sold for?
3. Will anyone pay for it?

Code lands here when the first question is answered with measurements rather
than opinions.

---

## Licence

**Source-available, not open source — yet.**

- The repository defaults to the **Business Source License 1.1**. See
  [`LICENSE`](LICENSE).
- Each version converts to the **Apache License 2.0** four years after that
  version is first published. BSL applies per version, so conversion dates
  are tracked per release in [`CHANGE-DATE-LEDGER.md`](CHANGE-DATE-LEDGER.md).
- Packages that ship independently carry their own licence file. **A package
  with its own `LICENSE` is governed by that licence, not by BSL.**

You may use, run and modify it for any purpose, including commercially and as
part of paid work, and redistribute it unmodified as a dependency. You may not
offer it to third parties as a competing commercial product or hosted service.
Read the licence rather than this summary — the licence is what binds.

---

## Contributing

There is no product code to send a pull request against yet. Issues and
discussion are open.

The contributor agreement is already decided, because deciding it after the
first contribution arrives does not work: LEDAR uses the **Developer
Certificate of Origin**, not a CLA. You keep your copyright, and your
contribution can never be moved into a closed commercial tier — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that rules out and why the
option was given up deliberately.

---

© 2026 Ngo Trung · [ledar.app](https://ledar.app)
