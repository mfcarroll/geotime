// scripts/provision.mjs
//
// The one-time setup that `wrangler deploy` cannot do for itself.
//
//   npm run provision            what it would do, and nothing else
//   npm run provision -- --apply do it
//
// Everything else about this infrastructure is already declarative: the Workers
// are wrangler.jsonc, the hostname is `custom_domain: true`, the service
// bindings are a list, and re-deploying reconciles rather than duplicating. The
// gap is a database, which has to exist before a binding can point at it and
// whose id is generated at creation — so it cannot simply be written down in
// advance. This closes that gap and writes the id where the binding will find
// it, so the whole setup is reproducible from a clean account.
//
// Idempotent by construction. It asks what exists before it makes anything, so
// running it twice is running it once, and running it against a half-finished
// setup finishes it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const DB_NAME = 'geotime-anchor-share';
const CONFIG = 'workers/anchor-share/wrangler.jsonc';
const SCHEMA = 'workers/anchor-share/schema.sql';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

const wrangler = (args, capture = true) =>
  execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

const say = (mark, text) => console.log(`${mark} ${text}`);
const plan = (text) => say(APPLY ? '  →' : '  would', text);

/** The database's id, or null if no database of that name exists yet. */
function findDatabase() {
  try {
    const listed = JSON.parse(wrangler(['d1', 'list', '--json']));
    return listed.find((db) => db.name === DB_NAME)?.uuid ?? null;
  } catch {
    // An account with no D1 at all answers with something that is not a list,
    // which is indistinguishable from "none of them is ours" for our purposes.
    return null;
  }
}

/** The id currently written into the binding, placeholder or real. */
function configuredId() {
  const match = /"database_id":\s*"([^"]*)"/.exec(readFileSync(CONFIG, 'utf8'));
  return match?.[1] ?? '';
}

function recordId(id) {
  const config = readFileSync(CONFIG, 'utf8');
  writeFileSync(CONFIG, config.replace(`"database_id": "${configuredId()}"`,
                                       `"database_id": "${id}"`));
}

console.log(APPLY ? 'Provisioning.\n' : 'Dry run — nothing will be created. Add --apply to do it.\n');

// 1. The database.
let id = findDatabase();
if (id) {
  say('✓', `D1 database ${DB_NAME} exists (${id})`);
} else {
  plan(`create D1 database ${DB_NAME}`);
  if (APPLY) {
    wrangler(['d1', 'create', DB_NAME], false);
    id = findDatabase();
    if (!id) {
      console.error('\n✘ Created the database but could not read its id back.');
      process.exit(1);
    }
    say('✓', `created (${id})`);
  }
}

// 2. The binding that points at it.
const written = configuredId();
if (!id) {
  plan(`write its id into ${CONFIG}`);
} else if (written === id) {
  say('✓', `${CONFIG} already points at it`);
} else if (written && written !== PLACEHOLDER) {
  // Refusing rather than overwriting: a real id that is not this database is
  // somebody pointing at something on purpose, and quietly repointing it is how
  // a deploy ends up writing to the wrong database.
  console.error(`\n✘ ${CONFIG} names a different database (${written}).`);
  console.error('  Sort that out by hand — this will not overwrite an id it did not put there.');
  process.exit(1);
} else {
  plan(`write ${id} into ${CONFIG}`);
  if (APPLY) {
    recordId(id);
    say('✓', 'recorded');
  }
}

// 3. The schema. Re-runnable, so this is safe whether or not it has been applied.
plan(`apply ${SCHEMA} to the remote database`);
if (APPLY) {
  if (!id) {
    console.error('\n✘ No database to apply it to.');
    process.exit(1);
  }
  wrangler(['d1', 'execute', DB_NAME, '--config', CONFIG, '--file', SCHEMA, '--remote', '--yes'],
           false);
  say('✓', 'schema applied');
}

console.log(APPLY
  ? '\nDone. `npm run deploy:workers` next — it deploys the gateway last, once its bindings exist.'
  : '\nRe-run with --apply to carry that out.');
