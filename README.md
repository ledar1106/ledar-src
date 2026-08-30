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
- Connects through a read-only role with hard statement, lock and idle
  timeouts, because a long-running `SELECT` can stall a table during a
  migration even without write permission.

### What leaves your machine, exactly

**Your rows never leave.** Not a sample, not a redacted one, not a count of a
specific person's orders.

When you ask a question, LEDAR sends **table and column names** to the model
you configured, so it can pick which part of the database your question is
about. That is schema, not data — but it is not nothing, and calling it
nothing would break the two letters in the middle of the name.

Everything about that call is visible before it happens:

- the screen names the destination, and what is in the payload, and waits
- the permit is hashed over the exact bytes to be sent; changing one
  identifier afterwards makes the send fail rather than proceed
- the model never writes a sentence and never writes SQL. It picks from a
  menu the product built. The product runs the queries and writes the words

If you never ask a question, nothing is sent anywhere.

---

## Run it

You need **Node 22 or newer** and a PostgreSQL connection string.

```bash
git clone https://github.com/ledar1106/ledar-src.git
cd ledar-src
npm ci
npm run desktop
```

The first `npm run desktop` downloads the Electron binary (about 100 MB) —
Electron 44 has no postinstall step, so `npm ci` does not fetch it. It happens
once and the launcher does it for you.

Then: paste a connection string, and LEDAR proves the connection is read-only
before it reads anything. Scanning, the entity map and the interview all work
with no AI configured at all.

To ask questions in plain language you supply your own model key — any
endpoint that speaks the OpenAI `/chat/completions` shape. The app asks for it
at the moment it first needs one, and stores it with the operating system's
own encryption (DPAPI on Windows). If the OS cannot encrypt, it refuses to
store the key rather than writing it to a file in the clear.

Also runs headless:

```bash
npm run check:db "postgres://..."   # prove the role is read-only
npm run scan     "postgres://..."   # scan, and write the history
npm run diff                        # what changed between two scans
npm test                            # needs Docker for the fixture databases
npm run test:offline                # 675 tests, no Docker needed
```

---

## Status

**Pre-1.0, and usable today.** Roughly 31,000 lines of product code in this
repository, about 1,170 tests, and a packaged Windows build that has passed
the Windows App Certification Kit.

What works:

- connect, with the read-only guarantee proven rather than asserted
- scan a real schema (94 tables on the Pagila sample, 368 subjects on
  MusicBrainz) and keep the history
- an entity map built from declared foreign keys, plus implicit ones that are
  measured and marked as measured, never guessed silently
- a fixed interview that turns what you know into a project profile
- ask a question and get a timeline back, with the routes it could not afford
  to walk named rather than dropped

What is not done:

- **Not in the Microsoft Store yet.** The package passes WACK, but the Store
  identity, the privacy policy URL and the certification notes are unwritten.
  Until then this is a source checkout, not an installer.
- macOS and Linux are untested. The code has no Windows-only logic that we
  know of, and "that we know of" is the honest size of that claim.
- Only PostgreSQL.
- The question-answering layer is measured on Pagila and MusicBrainz. It has
  not been run against a schema nobody here has seen.

Measurements, including the ones that came out badly, are in the private
repository's field log. Where a number appears here it came from a tool, not
from a commit message.

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

There is product code here now, so pull requests are real. `npm ci` and
`npm run test:offline` need nothing but Node; the full suite needs Docker
for the fixture databases.

One expectation, and it is the house style rather than a formality: a
change that alters what the product claims should come with the check that
would have caught it being wrong, and that check should have been seen to
fail before it passed.

The contributor agreement is already decided, because deciding it after the
first contribution arrives does not work: LEDAR uses the **Developer
Certificate of Origin**, not a CLA. You keep your copyright, and your
contribution can never be moved into a closed commercial tier — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for what that rules out and why the
option was given up deliberately.

---

© 2026 Ngo Trung · [ledar.app](https://ledar.app)
