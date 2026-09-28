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
//
// Two followed people, one of each row a follower can actually be sent (see
// anchorAsSeen in anchor.ts). Nothing here touches the relay: a fresh install
// has no account until it shares or redeems a code, and until then the app
// never asks the relay who it follows. *Share your time*, or submitting a code
// to follow, mints one, and the next sync then drops these rows — the relay has
// never heard of them — so take the people shots first.

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

    if (!localStorage.getItem('followedPeople')) {
      const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
      localStorage.setItem('followedPeople', JSON.stringify([
        // What every follower gets by default: the relay turns a zone into its
        // offset band, so this is the privacy model as a row. UTC+10 overlaps
        // none of the cities above, so her band stands alone on the map.
        {
          shareId: 'screenshot-mum',
          name: 'Mum',
          anchor: { kind: 'offset', offsetMinutes: 600 },
          updatedAt: minutesAgo(25),
        },
        // A sharer who turned exact sharing on, aboard: the one case where a
        // follower sees which ship, because the ship's clock is the anchor.
        {
          shareId: 'screenshot-dad',
          name: 'Dad',
          anchor: { kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas', short: 'Wonder' },
          updatedAt: minutesAgo(120),
        },
      ]));
    }

    // So the sharing card's "how you appear to them" row shows a person rather
    // than the "You" it falls back to. Local until an account exists.
    if (!localStorage.getItem('shareName')) localStorage.setItem('shareName', 'Sam');
  } catch {
    // Private mode, or storage disabled. Nothing here is worth failing a launch.
  }
}
