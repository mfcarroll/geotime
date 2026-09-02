// src/widget.ts
// Bridge to the native home-screen widgets (iOS WidgetKit / Android AppWidget).
// The widgets can't read localStorage, so every change to the timezone list is
// pushed to native shared storage via the WidgetBridge Capacitor plugin. The
// plugin also reports the device's OS timezone, which the WebView's own Intl
// can't be trusted to keep fresh after an OS timezone change.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ShipClock } from './ships';

/**
 * A ship as the widget needs it.
 *
 * Both names cross, because only the widget knows how much width it has. It
 * picks the full name when that does not shrink the uniform city font every row
 * shares, and the short one when it would — the same trade-off the layout
 * already makes for full weekday names and the "Local time" tag.
 *
 * The offset crosses as minutes, not as any kind of zone id. Native turns it
 * into a fixed-offset TimeZone — `TimeZone(secondsFromGMT:)` on iOS, a
 * "GMT±HH:MM" id for Android's TextClock — which is exactly right for a vessel,
 * whose clock has no DST rules. No synthetic IANA id ever crosses this boundary,
 * which is what keeps the hand-written id parsers from coming back.
 */
export interface WidgetShip {
  /** "R/ST" — brand and code, since a 2-letter code is unique only per brand. */
  key: string;
  /** Full name: "Independence of the Seas". Used wherever it fits. */
  name: string;
  /** Abbreviated: "Independence". Used only when the full name will not fit. */
  short: string;
  /** Minutes from UTC. Omitted entirely when the offset is not yet resolved. */
  offsetMinutes: number;
  /** Epoch ms of the last confirmed offset; 0 when never resolved. */
  fetchedAt: number;
  /**
   * Epoch ms after which the widget should stop refreshing this ship; 0 means
   * no bound.
   *
   * The widget refreshes itself in the background, so the auto/manual rule has
   * to reach it somehow. Sending a date rather than the inputs keeps the policy
   * in one place instead of re-deriving it in Swift and Java.
   */
  refreshUntil: number;
}

export interface WidgetPayload {
  timezones: string[];
  /** Parallel to `timezones`; '' where the user never named the place. */
  labels: string[];
  localTimezone: string | null;
  localPlaceName: string | null;
  /** Ships with a resolved offset. See WidgetShip. */
  ships: WidgetShip[];
}

export interface WidgetBridgePlugin {
  setTimezones(options: WidgetPayload): Promise<void>;
  getDeviceTimezone(): Promise<{ id: string }>;
  addListener(
    eventName: 'deviceTimezoneChanged',
    listenerFunc: (data: { id: string }) => void
  ): Promise<PluginListenerHandle>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge');

export interface SyncOptions {
  timezones: string[];
  labels: Record<string, string>;
  localTimezone: string | null;
  localPlaceName: string | null;
  ships: ShipClock[];
}

// localTimezone is the app's GPS-derived "true" local zone (the widget uses it
// as its base for the pin and offsets, matching the app's Local Time card).
//
// localPlaceName is the nearest town to the last GPS fix — "Nelson" rather than
// "Vancouver". The widget can't work this out itself: the city index is a 1.8 MB
// JSON the app parses, so the app resolves the name and hands over the result.
export function syncWidgetTimezones({
  timezones,
  labels,
  localTimezone,
  localPlaceName,
  ships,
}: SyncOptions): void {
  if (!Capacitor.isNativePlatform()) return;
  // Sent as an array parallel to `timezones` rather than a map, because the
  // native side stores JSON arrays already and an empty string is an easy
  // "no label" that older stores degrade to naturally.
  WidgetBridge.setTimezones({
    timezones: [...timezones],
    labels: timezones.map((tz) => labels[tz] ?? ''),
    localTimezone,
    localPlaceName,
    // An unresolved ship is withheld rather than sent with a placeholder
    // offset. The widget has no way to say "we don't know yet", so a sentinel
    // would render as a confident wrong time — and a row that is briefly absent
    // is honest, where a wrong clock is not.
    ships: ships
      .filter((ship) => ship.offsetHours !== null)
      .map((ship) => ({
        key: `${ship.brand}/${ship.code}`,
        name: ship.name,
        short: ship.short,
        offsetMinutes: Math.round((ship.offsetHours as number) * 60),
        fetchedAt: ship.fetchedAt ?? 0,
        refreshUntil: widgetRefreshUntil(ship),
      })),
  }).catch((err) => {
    console.warn('WidgetBridge.setTimezones failed:', err);
  });
}

/**
 * When the widget should stop refreshing a ship, as epoch ms. 0 means never.
 *
 * A manually added ship has no bound: adding it was a deliberate act and
 * removing the row is the off switch. An auto-added one stops at the end of the
 * voyage it was detected on — after that the row is some other cruise's clock,
 * and the row itself stays but the polling should not. `voyageEnd` is yyyyMMdd,
 * taken to mean the end of that day locally.
 */
function widgetRefreshUntil(ship: ShipClock): number {
  if (!ship.autoAdded || !ship.voyageEnd) return 0;
  const [y, m, d] = [
    Number(ship.voyageEnd.slice(0, 4)),
    Number(ship.voyageEnd.slice(4, 6)),
    Number(ship.voyageEnd.slice(6, 8)),
  ];
  return new Date(y, m - 1, d, 23, 59, 59).getTime();
}

export async function getDeviceTimezone(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return (await WidgetBridge.getDeviceTimezone()).id;
  } catch (err) {
    console.warn('WidgetBridge.getDeviceTimezone failed:', err);
    return null;
  }
}

export function onDeviceTimezoneChanged(callback: (id: string) => void): void {
  if (!Capacitor.isNativePlatform()) return;
  WidgetBridge.addListener('deviceTimezoneChanged', (data) => callback(data.id)).catch((err) => {
    console.warn('WidgetBridge.addListener failed:', err);
  });
}
