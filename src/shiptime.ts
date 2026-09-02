// src/shiptime.ts
//
// Keeps stored ship offsets current, and works out which ship the user is on.
//
// Two operations hide under the word "refresh", and conflating them produces the
// wrong design, so they are named separately here:
//
//   the probe        — reading the gateway headers to learn WHICH ship we are on.
//                      Only meaningful on the ship's wi-fi, so it is event-driven
//                      (launch, resume, network change), never on a timer, and
//                      wi-fi gated when it would need a request of its own.
//
//   the offset fetch — asking /time what a stored ship's clock reads. This runs
//                      wherever there is network, NOT only aboard: watching a
//                      ship from home is never on the ship's wi-fi, and gating it
//                      that way would mean the widget only ever moved when the
//                      app was opened.
//
// The probe is usually not a request at all. The gateway stamps its headers on
// everything it passes, so the environment rides whichever call was already
// being made — see readEnvironment in rccl.ts. Only the cold case, with no ship
// stored and so no /time call to ride, needs a request of its own, and that one
// is wi-fi gated.

import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { addShipClock, patchShipClock, persistShipClocks, setAboardShip, state } from './state';
import {
  loadShipRoster,
  refreshShipRoster,
  resolveShipClock,
  shipKey,
  type ShipClock,
} from './ships';
import { fetchActiveVoyage, shipTimeAvailable, todayStamp, type Environment } from './rccl';

/** The last definite environment reading, with when it arrived. */
let lastEnvironment: (Environment & { at: number }) | null = null;

/**
 * What the last stamped response said about where we are.
 *
 * Read by the diagnostics view, which is the reason a single voyage can settle
 * the onboard specification: the header names and values come from decompiled
 * code rather than the wire, so a copyable dump from a real ship is worth more
 * than any amount of inference.
 */
export function currentEnvironment(): (Environment & { at: number }) | null {
  return lastEnvironment;
}

/**
 * Acts on an environment reading, ignoring the uninformative ones.
 *
 * A null marker means *unknown*, never "ashore" — absence of a signal is not
 * evidence of anything. Wi-fi off, a cabin dead spot, a captive portal and no
 * data at all all produce nothing, and in every one of them the last known state
 * is still the best answer available. Only a definite marker changes anything,
 * which is what gives stickiness and liveness at once with no threshold to tune.
 */
async function noteEnvironment(env: Environment | null | undefined): Promise<void> {
  if (!shipTimeAvailable()) return;
  if (!env || env.marker === null) return;
  lastEnvironment = { ...env, at: Date.now() };

  if (env.marker === 'shore') {
    // Ashore. The ship is NOT removed from the list — nothing tells us the guest
    // disembarked for good, and the costs are asymmetric: a stale extra row is
    // untidy, while a missing ship clock strands somebody in a port. It stops
    // being the Ship Time section and becomes an ordinary row.
    setAboardShip(null);
    return;
  }

  if (!env.shipCode) return;    // aboard something we cannot name

  const roster = await loadShipRoster();
  // The marker carries a bare 2-letter code with no brand. Verified against the
  // roster: all 44 codes are unique across both fleets, so a code match is
  // unambiguous today. The brand preference below is a guard against a future
  // collision, not a live concern — prefer Royal, being the larger fleet, rather
  // than being wrong in both directions.
  const matches = roster.filter((ship) => ship.code === env.shipCode);
  const found = matches.find((ship) => ship.brand === 'R') ?? matches[0];
  if (!found) {
    console.warn(`Aboard unknown ship code ${env.shipCode}; roster may be stale`);
    return;
  }

  // Auto-add, so the ship persists once the guest steps ashore and the marker
  // stops arriving. That is the point of it: ashore it becomes an ordinary row
  // rather than vanishing along with the signal that revealed it.
  const clock = addShipClock(found, true);
  setAboardShip(shipKey(clock));
  await pinVoyage(clock);

  // Resolve the offset here rather than waiting for the next trigger. Detection
  // happens at the END of a resolve pass — a first launch aboard has no stored
  // ship, so there is no /time call for the environment to ride, and the ship is
  // only discovered once the cold probe returns. Without this, a guest who just
  // boarded sees the Ship Time heading reading "--:--" until they background the
  // app and come back.
  if (clock.offsetHours === null) {
    const resolved = await resolveShipClock(clock);
    if (resolved && resolved.clock.offsetHours !== null) {
      const { offsetHours, fetchedAt, source, overrideActive } = resolved.clock;
      patchShipClock(shipKey(clock), { offsetHours, fetchedAt, source, overrideActive });
      document.dispatchEvent(new CustomEvent('shipclockschanged'));
    }
  }
}

/**
 * Records the end of the voyage that was active when a ship was detected, which
 * is what bounds its background offset re-check.
 *
 * Only for auto-added ships, and only once. Re-pinning on later launches would
 * roll the bound forward into whatever sailing the ship is on next — and since
 * voyages run back to back with no gap, that is exactly the "true forever"
 * failure this exists to avoid.
 */
async function pinVoyage(clock: ShipClock): Promise<void> {
  if (!clock.autoAdded || clock.voyageEnd) return;
  const voyage = await fetchActiveVoyage(clock);
  if (!voyage) return;
  patchShipClock(shipKey(clock), { voyageEnd: voyage.sailEndDate });
}

/**
 * Whether a ship's offset is still worth re-asking for.
 *
 * A manually added ship always is: adding it was a deliberate act, and removing
 * the row is the off switch. An auto-added one stops once its pinned voyage has
 * ended — the guest has disembarked, and that row is now some other cruise's
 * clock. The row itself stays either way; only the polling stops.
 */
function isWorthRefreshing(clock: ShipClock): boolean {
  if (!clock.autoAdded || !clock.voyageEnd) return true;
  if (shipKey(clock) === state.aboardShipKey) return true;   // still aboard
  return todayStamp() <= clock.voyageEnd;
}

/** True when this device is on wi-fi, so a cold probe is worth making. */
async function onWifi(): Promise<boolean> {
  // In the browser there is no ship wi-fi to be on, and the dev proxy makes the
  // question meaningless — so this must not block development.
  if (!Capacitor.isNativePlatform()) return true;
  try {
    const status = await Network.getStatus();
    return status.connected && status.connectionType === 'wifi';
  } catch {
    return false;
  }
}

/**
 * Cold probes are throttled separately from everything else.
 *
 * With no ship stored, detection has to make a request purely to read a header,
 * and the only code-free stamped endpoint is the fleet list. Doing that on every
 * resume would be real traffic for a question that almost always answers "shore".
 *
 * An hour costs nothing in practice because the moment that actually matters —
 * boarding and joining the ship's wi-fi — arrives as a network-change event,
 * which bypasses this entirely. Launch and resume are the backstop.
 */
const COLD_PROBE_MIN_INTERVAL_MS = 60 * 60 * 1000;
let coldProbeAt = 0;
let coldProbeForced = false;

/**
 * Ships whose offset we tried and failed to get, this session.
 *
 * Only to keep the interface honest. "Finding ship time…" is true while a
 * request is outstanding and a lie once it has come back empty — and it can
 * come back empty for a whole cruise: offline in a port, or a build with no app
 * key, where /time is the one endpoint that needs one. Session-scoped rather
 * than persisted, so a relaunch always tries again.
 */
const unresolvable = new Set<string>();

/** True when this ship's offset was tried and could not be had. */
export function isUnresolvable(key: string): boolean {
  return unresolvable.has(key);
}

let inFlight: Promise<void> | null = null;

/**
 * Re-asks the API for every stored ship's offset, and acts on whatever the
 * gateway says about where we are.
 *
 * Failures are deliberately silent and non-destructive: the existing offset
 * stays, which is what makes a ship readable ashore in a port with no data. That
 * cached value is almost always still right, because clocks shift overnight and
 * the device is on the ship's wi-fi daily — trust comes from the refresh rhythm
 * rather than from any freshness display.
 *
 * Serialised, because several triggers fire at once on launch and there is no
 * sense in concurrent passes over the same list.
 */
export function resolveAllShipClocks(): Promise<void> {
  if (!shipTimeAvailable()) return Promise.resolve();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // Snapshot the list: resolution is asynchronous, and the user may add or
    // remove a ship while it runs. patchShipClock ignores anything no longer
    // stored, so a row deleted mid-flight is not resurrected.
    const ships: ShipClock[] = [...state.shipClocks];
    const due = ships.filter(isWorthRefreshing);

    let changed = false;
    let sawEnvironment = false;

    for (const ship of due) {
      const key = shipKey(ship);
      const result = await resolveShipClock(ship);
      if (!result) {
        // Nothing answered. A stored offset is kept — that is the whole point of
        // storing it — but an unresolved ship stops claiming to be looking.
        if (ship.offsetHours === null) { unresolvable.add(key); changed = true; }
        continue;
      }
      sawEnvironment = sawEnvironment || result.env.marker !== null;
      await noteEnvironment(result.env);
      if (result.clock.offsetHours === null) {
        if (ship.offsetHours === null) { unresolvable.add(key); changed = true; }
      } else {
        unresolvable.delete(key);
      }
      if (result.clock !== ship) {
        const { offsetHours, fetchedAt, source, overrideActive } = result.clock;
        patchShipClock(key, { offsetHours, fetchedAt, source, overrideActive });
        changed = changed || result.clock.offsetHours !== ship.offsetHours;
      }
    }

    // A resolved offset changes where the row sorts, so the list has to be
    // rebuilt, not just retimed. An event rather than a direct call, because
    // this module has no business knowing about the DOM.
    if (changed) document.dispatchEvent(new CustomEvent('shipclockschanged'));

    // The cold case: nothing was asked, so nothing was stamped, and detection
    // has no answer to ride. Only here does the probe need a request of its own,
    // and only here is wi-fi gating meaningful — there is no reason to reach a
    // third party's API over cellular to ask whether we are on a boat.
    const coldProbeDue = coldProbeForced
      || Date.now() - coldProbeAt > COLD_PROBE_MIN_INTERVAL_MS;
    if (!sawEnvironment && coldProbeDue && (await onWifi())) {
      coldProbeAt = Date.now();
      coldProbeForced = false;
      await noteEnvironment((await refreshShipRoster(true))?.env);
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Wires the event-driven triggers: app resume, and a network change.
 *
 * Launch is handled by the caller, which already sequences startup. There is
 * deliberately no timer in this layer — resume is the realistic trigger, since
 * somebody checking the time opens the app to do it. The refresh that moves the
 * widget *without* the app being opened belongs to each platform's own widget
 * cycle, not here.
 */
export function startShipTimeWatch(): void {
  if (!shipTimeAvailable()) return;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void resolveAllShipClocks();
  });

  if (Capacitor.isNativePlatform()) {
    // Joining the ship's wi-fi is exactly this event, and the moment a probe can
    // newly succeed.
    Network.addListener('networkStatusChange', (status) => {
      if (!status.connected) return;
      // The one trigger that skips the cold-probe throttle: a new connection is
      // the moment detection can newly succeed, and waiting an hour to notice
      // somebody boarded would defeat the point.
      coldProbeForced = true;
      void resolveAllShipClocks();
    }).catch((err) => console.warn('Network.addListener failed:', err));
  } else {
    window.addEventListener('online', () => { void resolveAllShipClocks(); });
  }
}

/**
 * Forgets a ship entirely, clearing the aboard flag if it was the one.
 *
 * Aboard, a ship has no remove affordance — it is the Ship Time section, like
 * Local Time. Ashore it is an ordinary row and removing it is the user's choice;
 * stepping back aboard re-detects it, which is correct rather than a bug, so no
 * dismissal is remembered.
 */
export function forgetShip(key: string): void {
  persistShipClocks(state.shipClocks.filter((ship) => shipKey(ship) !== key));
  if (state.aboardShipKey === key) setAboardShip(null);
}
