// src/diagnostics.ts
//
// A copyable dump of what the RCCL gateway actually said.
//
// This exists because the onboard behaviour was read from decompiled bytecode
// rather than seen on the wire: the header names, the `ship-time` format, and
// whether a paywalled request is still stamped are all inferred. Detection is
// written to tolerate every one of those being wrong, but tolerating is not
// knowing.
//
// With one tester and one voyage, a dump somebody can copy out of the app and
// paste into a message converts a single trip into a settled specification. That
// is worth more than any amount of further inference, which is why this is the
// first thing built in this phase rather than the last.

import { Capacitor } from '@capacitor/core';
import { state } from './state';
import { shipKey } from './ships';
import { probeRaw, shipTimeAvailable } from './rccl';
import { currentEnvironment } from './shiptime';
import { isUsableFix, lastPositionVerdict } from './ship-position';

/**
 * Everything worth knowing, as plain text.
 *
 * Text rather than JSON because it gets pasted into a message by a person who is
 * on holiday, and because the interesting part — a header that is present but
 * spelled differently than expected — survives a flat listing better than it
 * survives a schema someone has to trust.
 */
export async function shipTimeReport(): Promise<string> {
  const lines: string[] = [];
  const add = (label: string, value: unknown) => lines.push(`${label}: ${value}`);

  lines.push('=== GeoTime ship-time diagnostics ===');
  add('captured', new Date().toISOString());
  add('platform', Capacitor.getPlatform());
  add('native', Capacitor.isNativePlatform());
  add('ship time available', shipTimeAvailable());

  lines.push('', '--- believed state ---');
  add('aboard ship key', state.aboardShipKey ?? '(not aboard / unknown)');
  const env = currentEnvironment();
  if (env) {
    add('last marker', `${env.marker}  (${env.via === 'position' ? 'INFERRED from position, no header involved' : 'from a gateway header'})`);
    add('last ship code', env.shipCode ?? '(none)');
    add('last ship-time header', env.shipTime ?? '(absent)');
    add('last marker seen', new Date(env.at).toISOString());
  } else {
    lines.push('last marker: (never — no definite reading yet)');
  }

  lines.push('', '--- position detection (browser) ---');
  const fix = state.deviceFix;
  if (!fix) {
    lines.push('device fix: (none yet — detection has nothing to work with)');
  } else {
    add('device fix', `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}  accuracy ${fix.accuracy}m`);
    // The single most common reason detection stays silent, and the one that
    // looks like a bug rather than a refusal: a network fix is rejected outright
    // because a ship's wifi is Starlink and can place you on another continent.
    const why = fix.sensor ? 'sensor, but too imprecise' : 'network fix, not sensor';
    add('fix usable', isUsableFix(fix) ? 'yes (sensor)' : `NO — ${why}`);
  }
  const verdict = lastPositionVerdict();
  if (!verdict) {
    lines.push('verdict: (never ran — no usable fix, or throttled)');
  } else if (verdict.kind === 'aboard') {
    add('verdict', `aboard ${verdict.ship.name} (${verdict.ship.code}), ${verdict.km.toFixed(2)} km`);
  } else if (verdict.kind === 'ashore') {
    add('verdict', 'ashore — nothing afloat within reach');
  } else {
    add('verdict', `unknown — ${verdict.why}`);
  }

  lines.push('', '--- stored ships ---');
  if (state.shipClocks.length === 0) {
    lines.push('(none)');
  }
  for (const ship of state.shipClocks) {
    lines.push(
      `${shipKey(ship)}  ${ship.name}` +
      `  offset=${ship.offsetHours === null ? 'unresolved' : `UTC${ship.offsetHours >= 0 ? '+' : ''}${ship.offsetHours}`}` +
      `  source=${ship.source ?? '-'}` +
      `  override=${ship.overrideActive ? 'ACTIVE' : 'off'}` +
      `  auto=${ship.autoAdded}` +
      `  voyageEnd=${ship.voyageEnd ?? '-'}` +
      `  fetched=${ship.fetchedAt ? new Date(ship.fetchedAt).toISOString() : 'never'}`
    );
  }

  lines.push('', '--- live probe ---');
  const probe = await probeRaw();
  if (!probe) {
    lines.push('no response at all — offline, blocked, or a captive portal');
    lines.push('(this is the case that yields NO marker, which must read as');
    lines.push(' "unknown" rather than "ashore")');
  } else {
    add('status', probe.status);
    lines.push('headers:');
    // Every header, not a chosen subset. The single most useful thing a real
    // ship can tell us is a header we did not know to look for.
    for (const name of Object.keys(probe.headers).sort()) {
      lines.push(`  ${name}: ${probe.headers[name]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Wires the diagnostics affordance: six taps on the Device Time heading.
 *
 * Hidden because it is for one tester on one voyage, not a feature — but
 * reachable without a debug build, because the person who needs it will be at
 * sea with a production install and no way to receive a special one.
 */
export function installDiagnostics(trigger: HTMLElement): void {
  if (!shipTimeAvailable()) return;

  // Also reachable at ?diag, for someone who cannot be talked through six taps
  // over a satellite connection. Delayed rather than immediate: the interesting
  // fields are filled in by detection, which needs a fix and a round trip, and a
  // report captured before that has nothing in it but blanks.
  if (window.location.search.includes('diag')) {
    window.setTimeout(() => { void showReport(); }, 6000);
  }

  let taps = 0;
  let resetAt = 0;

  trigger.addEventListener('click', () => {
    const now = Date.now();
    if (now - resetAt > 3000) taps = 0;
    resetAt = now;
    if (++taps < 6) return;
    taps = 0;
    void showReport();
  });
}

async function showReport(): Promise<void> {
  const report = await shipTimeReport();
  console.log(report);

  const overlay = document.createElement('div');
  overlay.className = 'diagnostics-overlay';
  overlay.innerHTML = `
    <div class="diagnostics-panel">
      <p class="diagnostics-title">Ship time diagnostics</p>
      <p class="diagnostics-hint">Send this to whoever asked for it.</p>
      <textarea class="diagnostics-text" readonly></textarea>
      <div class="diagnostics-actions">
        <button class="diagnostics-send" type="button">Send</button>
        <button class="diagnostics-close" type="button">Close</button>
      </div>
    </div>`;

  const textarea = overlay.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = report;

  const hint = overlay.querySelector('.diagnostics-hint') as HTMLElement;
  const send = overlay.querySelector('.diagnostics-send') as HTMLButtonElement;

  // Sending is its own button rather than something attempted on open, and that
  // is deliberate. navigator.share needs live user activation, which the await
  // on the probe above has already spent — so a share fired on open fails on
  // exactly the device we most need it to work on. A button gives it a fresh
  // gesture.
  //
  // Three routes, best first, because this is the only channel back from a ship
  // and there is one voyage to get it right: the share sheet (straight into
  // Messages), then the clipboard, then the textarea that was always there.
  send.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'GeoTime ship time diagnostics', text: report });
        hint.textContent = 'Sent.';
        return;
      }
    } catch (err) {
      // A cancelled share sheet lands here too, so this is not an error state —
      // fall through and offer the clipboard.
    }
    try {
      await navigator.clipboard.writeText(report);
      hint.textContent = 'Copied. Paste it into a message.';
      return;
    } catch {
      // Ignored: the textarea below is the floor, and it always works.
    }
    textarea.focus();
    textarea.select();
    hint.textContent = 'Copy the selected text and paste it into a message.';
  });

  const close = () => overlay.remove();
  overlay.querySelector('.diagnostics-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  document.body.appendChild(overlay);
}
