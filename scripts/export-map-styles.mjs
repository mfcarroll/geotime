#!/usr/bin/env node
// Emits the two map styles as JSON, ready to paste into Google Cloud console's
// map style editor ("Import JSON").
//
//   node scripts/export-map-styles.mjs [--out DIR]
//
// The maps are cloud-styled vector maps, so src/map-styles.ts no longer drives
// anything at runtime — but it remains the only copy of the palette under source
// control. This exists so re-importing after a change is a command rather than a
// transcription exercise, and so the two never drift by hand.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { locationMapStyles, worldTimezoneMapStyles } from '../src/map-styles.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = arg('out', join(import.meta.dirname, '..', 'dist-map-styles'));
mkdirSync(OUT, { recursive: true });

// Names match the Map IDs they belong to, so there is no guessing which goes
// where when there are two of them in the console.
const styles = {
  'location-map': locationMapStyles,
  'world-clock-map': worldTimezoneMapStyles,
};

for (const [name, value] of Object.entries(styles)) {
  const path = join(OUT, `${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  console.log(`✓ ${path}  (${value.length} rules)`);
}
