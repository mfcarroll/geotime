// src/screenshot-seed.ts
//
// Pre-populates the clock list so App Store screenshots can be captured without
// driving the UI by hand on every device size.
//
// ABSENT FROM PRODUCTION BUILDS. __SCREENSHOT_SEED__ is a build-time constant
// that is `false` unless the build asked for it, so the whole body is dead code
// the bundler drops — the same guard shipGateway() uses for the onboard test
// hook, and for the same reason: a marketing convenience must not be reachable
// in a shipped app.
//
//   npx vite build --mode screenshots
//   VITE_SCREENSHOT_SEED=1 npx vite build --mode shiptest   # aboard variant
//
// It seeds only when the list is empty, so it can never overwrite real use and
// a second launch behaves exactly like an ordinary one. The cities mirror the
// original App Store set — a spread of offsets either side of the fix, chosen so
// the day-difference and the +/- hours columns both have something to show.

declare const __SCREENSHOT_SEED__: boolean;

export function seedForScreenshots(): void {
  if (!__SCREENSHOT_SEED__) return;

  try {
    if (!localStorage.getItem('worldClocks')) {
      localStorage.setItem('worldClocks', JSON.stringify([
        { tz: 'America/New_York', label: 'New York' },
        { tz: 'Europe/London', label: 'London' },
        { tz: 'Europe/Paris', label: 'Paris' },
        { tz: 'Asia/Tokyo', label: 'Tokyo' },
      ]));
    }

    // A ship on the list is what puts a hull on the world map, so the tracker
    // has something to show without anyone being aboard.
    if (!localStorage.getItem('shipClocks')) {
      localStorage.setItem('shipClocks', JSON.stringify([
        {
          code: 'ST',
          brand: 'R',
          name: 'Star of the Seas',
          short: 'Star',
          imo: '9829942',
          offsetHours: null,
          fetchedAt: null,
          source: null,
          overrideActive: false,
        },
      ]));
    }
  } catch {
    // Private mode, or storage disabled. Nothing here is worth failing a launch.
  }
}
