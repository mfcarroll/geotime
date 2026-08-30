// src/widget.ts
// Bridge to the native home-screen widgets (iOS WidgetKit / Android AppWidget).
// The widgets can't read localStorage, so every change to the timezone list is
// pushed to native shared storage via the WidgetBridge Capacitor plugin. The
// plugin also reports the device's OS timezone, which the WebView's own Intl
// can't be trusted to keep fresh after an OS timezone change.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface WidgetBridgePlugin {
  setTimezones(options: {
    timezones: string[];
    /** Parallel to `timezones`; '' where the user never named the place. */
    labels: string[];
    localTimezone: string | null;
    localPlaceName: string | null;
  }): Promise<void>;
  getDeviceTimezone(): Promise<{ id: string }>;
  addListener(
    eventName: 'deviceTimezoneChanged',
    listenerFunc: (data: { id: string }) => void
  ): Promise<PluginListenerHandle>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge');

// localTimezone is the app's GPS-derived "true" local zone (the widget uses it
// as its base for the pin and offsets, matching the app's Local Time card).
//
// localPlaceName is the nearest town to the last GPS fix — "Nelson" rather than
// "Vancouver". The widget can't work this out itself: the city index is a 1.8 MB
// JSON the app parses, so the app resolves the name and hands over the result.
// That means it only changes while the app is running, which the widget-refresh
// work will need to address.
export function syncWidgetTimezones(
  timezones: string[],
  localTimezone: string | null,
  localPlaceName: string | null = null,
  labels: Record<string, string> = {}
): void {
  if (!Capacitor.isNativePlatform()) return;
  // Sent as an array parallel to `timezones` rather than a map, because the
  // native side stores JSON arrays already and an empty string is an easy
  // "no label" that older stores degrade to naturally.
  WidgetBridge.setTimezones({
    timezones: [...timezones],
    labels: timezones.map((tz) => labels[tz] ?? ''),
    localTimezone,
    localPlaceName,
  }).catch((err) => {
    console.warn('WidgetBridge.setTimezones failed:', err);
  });
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
