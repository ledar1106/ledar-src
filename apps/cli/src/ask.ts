/**
 * Ask a question about one finding — VS-8, and D.1's first real call site.
 *
 *     npm run ask -- --list
 *     npm run ask -- "what share of the rows is that?"
 *     npm run ask -- --run 7 --finding 2 "which users did this?"
 *
 * ## Why this is a command and not part of `scan`
 *
 * `scan` has nothing to ask. VS-7 — explaining a finding in human language —
 * was cut from HS-D entirely, because the gate proved the rule packs already
 * do it and four of five readers took the right conclusion from them. What is
 * left for a model is the job templates cannot do: answering a question
 * somebody actually asked. A scan has no question in it, so wiring a model
 * call into `scan.ts` would be building a call site with nothing to say.
 *
 * A command needs no frontend and exercises the whole chain end to end:
 * history → finding → facts → fenced prompt → model → sealed answer →
 * a sentence this product wrote → a cost row.
 *
 * ## What a reader gets when the model is not there
 *
 * The same thing they got before it existed. `withModelStep` keeps the rule
 * packs' output in its own field and the model's contribution in another, so a
 * timeout, a 503, or a refused answer costs the reader an ADDITION and nothing
 * else. That is D.5, and it is why this file can call a network service at all
 * without putting the report at risk.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  factsFromFinding,
  sealAnswer,
  describeEgress,
  framePrompt,
  grantEgress,
  PermitLedger,
  langFromEnv,
  modelAdditionHeading,
  renderAnswer,
  withModelStep,
} from '@ledar/contracts';
import type {
  EgressDisclosure,
  EvidenceFact,
  ModelStepState,
  PromptParts,
  SealedAnswer,
} from '@ledar/contracts';
import { askModel, outboundOf } from '@ledar/model-client';
import type { ModelConfig } from '@ledar/model-client';
import { AnswerCache, ScanStore } from '@ledar/store';

import { ledarDir } from './paths.js';
import { runningAsCommand } from './paths.js';
import { wrap } from './text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const LANG = langFromEnv(process.env);

function readEnvFile(name: string): string | null {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(resolve(REPO, 'infra/.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`).exec(line);
      if (m?.[1]) return m[1].trim();
    }
  } catch {
    // No .env. The caller reports it; this just has nothing to offer.
  }
  return null;
}

function die(...lines: string[]): never {
  console.error('');
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

/**
 * The tier map, from a file.
 *
 * D.1's acceptance criterion is *change the model by changing config, not
 * code*, and a config that lives in a TypeScript constant fails it however
 * neatly it is written. `infra/ai-tiers.json` is checked in with the tier the
 * measurements chose, so this works with no setup beyond a key.
 */
function loadConfig(): ModelConfig {
  const path = resolve(REPO, 'infra/ai-tiers.json');
  let parsed: {
    tiers?: ModelConfig['tiers'];
    prices?: ModelConfig['prices'];
    priceBasis?: string;
  };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(
      `Could not read ${path}`,
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed.tiers || Object.keys(parsed.tiers).length === 0) {
    die(`${path} declares no tiers. A tier is a promise about cost and`, 'consequence; there is no default for one.');
  }

  const baseUrl = readEnvFile('AI_BASE_URL');
  const apiKey = readEnvFile('AI_API_KEY');
  if (!baseUrl || !apiKey) {
    die(
      'infra/.env has no AI_BASE_URL and/or AI_API_KEY.',
      '',
      'Run infra/set-secret.cmd and choose [A]. It asks for the endpoint',
      'first and the key second, and stores both in one go.',
    );
  }

  const config: ModelConfig = { baseUrl, apiKey, tiers: parsed.tiers };
  // Both or neither: `llm_call` refuses a cost whose basis nobody stated, and
  // a price list with no provenance is exactly that.
  if (parsed.prices && parsed.priceBasis) {
    return { ...config, prices: parsed.prices, priceBasis: parsed.priceBasis };
  }
  return config;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * The consent, retention and redaction versions this command sends under.
 *
 * One string because a permit compares them together and never separately —
 * a caller able to match two of three would have a way to be partly right.
 * It is a constant here because nothing in this command varies it; the day
 * something does, this becomes an argument and every old permit stops
 * matching, which is the correct thing to happen.
 */
const EGRESS_POLICY = 'consent=cli-explicit-send/1 retention=none/1 redaction=fence/1';

/**
 * How long a permit lives.
 *
 * Short, and short on purpose: consent is about a moment, and this one is
 * granted and spent in the same breath. A generous window would only make it
 * possible for the payload to change in between.
 */
const PERMIT_TTL_MS = 60_000;

/**
 * Prints what is about to leave, before anything leaves.
 *
 * `_doc/27` Module 4 requires that a person SEE the list — including schema,
 * table and column names — before granting. On a command line that means
 * printing it and stopping, because a disclosure that scrolls past on the way
 * to a result is a disclosure nobody read.
 */
function printDisclosure(d: EgressDisclosure): void {
  console.error('');
  console.error('  ABOUT TO LEAVE THIS MACHINE');
  console.error('');
  console.error(`    to        ${d.destination}`);
  console.error(`    class     ${d.dataClass}`);
  console.error(`    size      ${d.bytes} bytes of your content`);
  for (const b of d.blocks) {
    console.error(`      · ${b.label} — ${b.bytes} bytes (${b.egressClass})`);
  }
  if (d.identifiers.length > 0) {
    console.error('');
    console.error('    names from your system that are in it:');
    for (const line of wrap(d.identifiers.join(', '), 60)) {
      console.error(`      ${line}`);
    }
  }
  console.error('');
}

/**
 * The addition, rendered the same way whether it was just paid for or not.
 *
 * One function so a cache hit and a fresh answer cannot come out looking
 * different. A reader who can tell which is which learns to trust one of them
 * less, and there is no reason to — it is the same answer.
 */
function renderAddition(answer: SealedAnswer, facts: EvidenceFact[]): string {
  return [
    `  ${modelAdditionHeading(LANG)}`,
    '',
    ...wrap(renderAnswer(answer, facts, LANG), 66).map((l) => `  ${l}`),
  ].join('\n');
}

async function main(): Promise<void> {
  const historyPath = readEnvFile('LEDAR_HISTORY_DB') ?? resolve(ledarDir(), 'history.db');
  const store = ScanStore.open(historyPath);

  try {
    const runs = store.everyRun(20);
    if (runs.length === 0) {
      die(`${historyPath} holds no runs. Run \`npm run scan\` first.`);
    }

    const runArg = arg('--run');
    const run = runArg ? store.runById(Number(runArg)) : runs[0]!;
    if (!run) die(`No run ${runArg} in ${historyPath}.`);

    const findings = store.findingsOf(run.runId);

    if (process.argv.includes('--list')) {
      console.log('');
      console.log(`  run ${run.runId} · ${run.startedAt} · ${findings.length} finding(s)`);
      console.log('');
      findings.forEach((f, i) => {
        console.log(`    [${i}] ${f.finding.rule}`);
        for (const line of wrap(f.finding.plainText, 66)) console.log(`        ${line}`);
        console.log('');
      });
      console.log('  Ask about one of them:');
      console.log('');
      console.log(`      npm run ask -- --run ${run.runId} --finding 0 "your question"`);
      console.log('');
      return;
    }

    // The question is whatever is left after the flags — the one thing here a
    // person types, and therefore the one place an attack arrives. It goes
    // into the fence like any other untrusted content.
    const flags = new Set(['--run', '--finding']);
    const question = process.argv
      .slice(2)
      .filter((a, i, all) => !a.startsWith('--') && !flags.has(all[i - 1] ?? ''))
      .join(' ')
      .trim();

    if (question === '') {
      die(
        'Ask something. For example:',
        '',
        '    npm run ask -- --list',
        '    npm run ask -- "what share of the rows is that?"',
      );
    }

    if (findings.length === 0) {
      die(`Run ${run.runId} raised no findings, so there is nothing to ask about.`);
    }
    const index = Number(arg('--finding') ?? '0');
    const chosen = findings[index];
    if (!chosen) {
      die(
        `Run ${run.runId} has ${findings.length} finding(s); there is no [${index}].`,
        'Use --list to see them.',
      );
    }

    const f = chosen.finding;
    const facts: EvidenceFact[] = factsFromFinding({
      rule: f.rule,
      confidence: f.confidence,
      confidenceBasis: f.confidenceBasis,
      schema: f.schema,
      table: f.table,
      columns: f.columns,
      plainText: f.plainText,
      evidence: f.evidence
        ? { rowCount: f.evidence.rowCount, sampleSize: f.evidence.sampleSize }
        : null,
      coverage: { checked: f.coverage.checked, eligible: f.coverage.eligible },
      ...('boundary' in f ? { boundary: (f as { boundary: string }).boundary } : {}),
    });

    const config = loadConfig();

    // What the reader already has, and keeps whatever happens next.
    const fromRules = [
      `  ${f.plainText}`,
      '',
      `  where: ${f.schema}.${f.table}${f.columns.length ? '.' + f.columns.join(', ') : ''}`,
    ].join('\n');

    let step: ModelStepState = 'not_configured';
    let addition: string | null = null;

    let promptParts: PromptParts | undefined;
    let prompt;
    try {
      promptParts = {
        instruction: [
          'Answer using ONLY this JSON shape. No prose, no extra keys.',
          '',
          '  { "answerable": boolean, "facts": string[], "missing": string[] }',
          '',
          '- `facts`: ids from the fact list your answer rests on. Ids only.',
          '- `missing`: only when answerable is false, and only these values:',
          '  who, when, why, which_rows, impact, elsewhere',
          '',
          'Answer from the facts alone. If they do not carry what the question',
          'asks for, that is `answerable: false` — not a smaller answer.',
        ].join('\n'),
        untrusted: [
          {
            label: 'facts from the scan',
            egressClass: 'customer-system-metadata',
            content: facts.map((x) => `${x.id} — ${x.label}: ${x.value}`).join('\n'),
          },
          {
            label: 'question asked by the user',
            egressClass: 'customer-system-metadata',
            content: question,
          },
        ],
      };
      prompt = framePrompt(promptParts);
    } catch (err) {
      // framePrompt refused — something classed `never-leaves` was in there.
      // That is D.5's `declined`, and the reader is told so rather than left
      // with a silence they would read as an answer.
      step = 'declined';
      console.error(`  (not sent: ${err instanceof Error ? err.message : String(err)})`);
    }

    // Beside the history, never inside it. A cache must never be able to cost
    // anybody their evidence, and the history's answer to a shape change is to
    // move the file aside.
    const cache = AnswerCache.open(resolve(dirname(historyPath), 'answers.db'));
    const cacheKey = { structureHash: chosen.structureHash, question, tier: 'answers' };

    // No language in the key: the model returns identifiers and this product
    // renders the sentence, so one stored answer serves every market.
    const remembered = prompt
      ? cache.get<SealedAnswer>(cacheKey, (raw) => sealAnswer(raw, facts))
      : null;

    if (remembered) {
      step = 'answered';
      addition = renderAddition(remembered, facts);
      // Recorded like any other call. A hit that leaves no row makes the cost
      // table unable to explain where a question went, and `cache_hit` exists
      // in llm_call precisely so a zero can say WHY it is zero.
      store.recordLlmCall({
        runId: run.runId,
        tier: 'answers',
        model: config.tiers['answers']?.model ?? 'unknown',
        outcome: 'ok',
        cacheHit: true,
        promptTokens: 0,
        completionTokens: 0,
        costMicros: 0,
        // Not a price list, and saying so. The invariant is that a stored
        // number explains where it came from; "nothing was sent" is where
        // this zero came from.
        priceBasis: 'nothing was sent — served from cache',
        note: null,
      });
      prompt = undefined;
    }

    if (prompt && promptParts) {
      /**
       * Nothing leaves until the person running this has seen what leaves.
       *
       * `_doc/27` Module 4. On a command line "seeing it" is printing it and
       * requiring a second, explicit act — `--send` — because a prompt that
       * defaults to yes is a disclosure nobody read. The desktop will ask this
       * differently; what may not differ is that a payload goes out only
       * against a permit granted over its exact bytes.
       */
      const tier = config.tiers['answers']!;
      const outbound = outboundOf(config, tier, prompt);
      // The names of this finding's own schema, table and columns. Offered as
      // candidates; `describeEgress` keeps the ones genuinely in the payload.
      const disclosure = describeEgress(promptParts, outbound.destination, [
        `${f.schema}.${f.table}`,
        f.schema,
        f.table,
        ...f.columns,
      ]);
      printDisclosure(disclosure);

      if (!process.argv.includes('--send')) {
        // `declined` is D.5's word for "the model step did not happen and the
        // reader is told so". The report below is unchanged either way, which
        // is the invariant `withModelStep` exists to hold.
        step = 'declined';
        console.error(
          '  (not sent: add --send to allow the payload above to leave this machine)',
        );
      } else {
      // One ledger for this command. A permit is spent inside `askModel`,
      // never here: a permit marked used by whoever remembered to is a
      // permit that can be replayed by whoever did not.
      const ledger = new PermitLedger();
      const now = new Date().toISOString();
      const permit = grantEgress({
        disclosure,
        body: outbound.body,
        policy: EGRESS_POLICY,
        now,
        ttlMs: PERMIT_TTL_MS,
        id: randomUUID(),
      });

      const asked = await askModel(
        config,
        'answers',
        prompt,
        facts,
        (call) => store.recordLlmCall({ ...call, runId: run.runId }),
        {
          permit,
          ledger,
          policy: EGRESS_POLICY,
          dataClass: disclosure.dataClass,
          now,
        },
        { runId: run.runId },
      );
      if (asked.state === 'answered') {
        step = 'answered';
        addition = renderAddition(asked.answer, facts);
        // Only ever a sealed answer. A cache of unchecked output is a way
        // to make one bad answer permanent, and ㉒ measured a model doing
        // exactly what an attacker told it.
        cache.put(cacheKey, asked.answer);
      } else {
        step = 'unavailable';
      }
      }
    }
    cache.close();

    // The parts are printed field by field rather than through `joinParts`,
    // and that is what `joinParts` is FOR — a convenience the caller may skip.
    // The first run through it printed the "could not be reached" sentence
    // flush left and unwrapped, while everything around it was indented and
    // wrapped to 66, so the one line about a failure was the one line that
    // looked like it came from somewhere else.
    const parts = withModelStep(fromRules, step, addition, LANG);
    console.log('');
    console.log(parts.fromRules);
    if (parts.fromModel !== null) {
      console.log('');
      console.log(parts.fromModel);
    }
    if (parts.aboutTheStep !== null) {
      console.log('');
      for (const line of wrap(parts.aboutTheStep, 66)) console.log(`  ${line}`);
    }
    console.log('');
  } finally {
    store.close();
  }
}

if (runningAsCommand(import.meta.url)) {
  await main();
}
