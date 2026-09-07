/// <reference types="vite/client" />
// src/main.ts

import './style.css';
import { Loader } from '@googlemaps/js-api-loader';
import * as dom from './dom';
import { addShipClock, loadDebugFleet, migrateStoredTimezones, persistZones, savedZoneByKey, state, syncWidget } from './state';
import { refreshAnchorChip, refreshMapStyles, initMaps, onLocationError, onLocationSuccess, selectSavedZone, selectShip, selectPlace, setHoveredShip, setHoveredPlace, renderWorldClocks, keepZone, updateUserTimezoneDetails, showLocationUnavailable, loadTimezoneGeoJson, revealAnchor, clearSelection, hoverAnchor, hoverSelected, hoverClockRow } from './map';
import { updateAllClocks, syncClock, startClockWatch, getDisplayTimezoneName, startClocks, findTimezoneFromGeoJSON } from './time';
import { Capacitor } from '@capacitor/core';
import { getDeviceTimezone, onDeviceTimezoneChanged } from './widget';
import { Geolocation, PositionOptions } from '@capacitor/geolocation';
import { createSearchCombobox } from './combobox';
import { loadShipRoster, refreshShipRoster, shipRosterNow, shipKey } from './ships';
import { initShipTime } from './rccl';
import { forgetShip, resolveAllShipClocks, startShipTimeWatch } from './shiptime';
import { initShipTrack, cachedVoyageFor } from './shiptrack';
import { portRefsFrom } from './ports';
import { zoneKey, type StoredZone } from './stored-zones';
import { refreshShipMarkers, startShipMarkerWatch, type PlaceMarkerDetail } from './ship-markers';
import { installDiagnostics } from './diagnostics';
import { maybeRunShipProbe } from './ship-probe';
import { library, dom as faDom } from '@fortawesome/fontawesome-svg-core';
import { faLocationDot, faWifi, faBullseye, faMobileAlt, faSatellite, faShip, faAnchor } from '@fortawesome/free-solid-svg-icons';

// Every icon the markup names has to be registered here — the tree-shaken
// core renders an unregistered one as a placeholder box, which is what the
// anchor did until it was added.
library.add(faLocationDot, faWifi, faBullseye, faMobileAlt, faSatellite, faShip, faAnchor);
faDom.watch();

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

function handleUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('timezones')) {
        const timezonesParam = urlParams.get('timezones');
        if (timezonesParam) {
            // The shared list arrives as records already — the same shape the
            // store holds — so names travel with it instead of being written
            // onto their zones after the fact.
            const shared = migrateStoredTimezones(timezonesParam.split(','));
            persistZones(shared);
            state.timezonesFromUrl = shared;
        }

        history.replaceState(null, '', window.location.pathname);
    }
}

async function startApp() {
  // An unlinked diagnostic, reached at ?shipprobe. It answers the one
  // question about browser ship mode that cannot be settled from shore, so it
  // takes over the page rather than running behind a working app.
  if (maybeRunShipProbe()) return;

  handleUrlParameters();
  
  setTimeout(() => {
    if (!state.locationAvailable) {
      showLocationUnavailable();
    }
  }, 5000);

  if (Capacitor.getPlatform() === 'ios') {
    document.body.classList.add('is-ios');
  }
  if (Capacitor.getPlatform() === 'android') {
    document.body.classList.add('is-android');
  }

  const initialTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  state.localTimezone = initialTimezone;
  state.gpsTzid = initialTimezone;
  updateUserTimezoneDetails(initialTimezone);

  // Device (OS) timezone from native — WKWebView's Intl can be stale after the
  // OS timezone changes, so trust native and refresh on its change event.
  getDeviceTimezone().then((id) => { if (id) state.deviceTimezone = id; });
  onDeviceTimezoneChanged((id) => { state.deviceTimezone = id; });

  startClocks();
  syncClock();
  startClockWatch();

  // Heal the native home-screen widget on every launch, in case a previous
  // write was missed (app killed mid-write, data predating the widget, etc).
  syncWidget();

  // Last known ship positions, from storage, before anything touches the
  // network. A launch with no connection — in a port, or aboard, where the
  // position source is unreachable — still draws where the ships were.
  initShipTrack();

  // Ship offsets are the one thing in this app that cannot be derived on
  // device, so they are re-asked for on launch. Failure is silent and leaves the
  // stored offset in place — which is what keeps a ship readable in a port with
  // no data.
  // Resolved before anything renders, because it decides whether ship features
  // exist at all: an un-injected build has no key, and a ship that can never
  // tell the time is worse than no ship.
  void initShipTime().then((on) => {
    if (!on) return;
    void resolveAllShipClocks();
    void refreshShipRoster();
    startShipTimeWatch();
    // `?debug=ships` only, and here rather than earlier because the roster is
    // empty until the app key resolves — loadShipRoster memoises the empty
    // answer if it is asked first, which is exactly what a call up in the
    // startup block did.
    //
    // Then asked the time, because the pass above has already gone out with
    // whatever list existed a moment ago. Every other way a ship joins the list
    // resolves right after — the search box does it below, and boarding does it
    // from inside the pass itself — so this was the one door with nobody behind
    // it, and forty-four ships sat blank until the watch's next tick or a
    // reload.
    void loadDebugFleet().then((added) => {
      if (added) void resolveAllShipClocks();
    });
  });
  installDiagnostics(dom.deviceTimezoneEl);

  // Start watching for location immediately.
  //
  // A test build can be told where to stand instead. Position is the only input
  // to browser ship detection and a desk is not on a ship, so without this the
  // aboard path is unreachable in the one place it is quickest to look at.
  // Compiled out of every ordinary build along with __SHIP_GATEWAY__, which is
  // null unless --mode shiptest.
  if (__SHIP_GATEWAY__ && standAt()) {
    // standAt() has already delivered the fix; no watch is started.
  } else if (Capacitor.isNativePlatform()) {
    let options: PositionOptions = {}
    if (Capacitor.getPlatform() === 'android') {
      options.enableHighAccuracy = true;
      options.maximumAge = 30000;  // accept a fix up to 30s old
      options.timeout = 30000;     // allow 30s to acquire (1s was too short for a cold GPS fix)
    }
    Geolocation.watchPosition(options, (position, err) => {
      if (err) {
        onLocationError(err as GeolocationPositionError);
        return;
      }
      if (position) {
          // Capacitor's Position lacks GeolocationPosition's toJSON; shape is
          // otherwise compatible.
          onLocationSuccess(position as unknown as GeolocationPosition);
      }
    });
  } else {
    navigator.geolocation.watchPosition(
      onLocationSuccess, 
      onLocationError
    );
  }

  // The boundaries drive zone-id search and the offline GPS lookup, neither of
  // which should wait on Google Maps — or be lost entirely when it fails to load.
  const geoJsonReady = loadTimezoneGeoJson();


  // Load maps separately. A failure here will not block location services.
  const loader = new Loader({
    apiKey: GOOGLE_MAPS_API_KEY,
    version: "weekly",
    region: "CA"
  });

  try {
    await loader.load();
    await initMaps();
  } catch (e) {
    console.error("Failed to load Google Maps.", e);
    // You could add UI to show the map is unavailable here if desired.
    // The location card will function independently.
  }

  await geoJsonReady;

  // The roster is tiny (44 vessels, ~3 KB) and bundled, so it is simply awaited
  // rather than warmed lazily the way the 1.8 MB city index is. Returns empty
  // when ship features are disabled, which removes ships from search.
  await initShipTime();
  await loadShipRoster();

  // Positions come after the roster, not before: a marker is looked up by the
  // ship's IMO, and the IMO lives on the roster. Started here rather than beside
  // the other ship work above because it also needs the map to exist.
  refreshShipMarkers();
  startShipMarkerWatch();

  createSearchCombobox({
    input: dom.timezoneInput,
    listbox: dom.timezoneResults,
    zoneIds: () => (state.geoJsonData?.features ?? []).map((f: any) => f.properties.tzid),
    origin: () => state.lastFetchedCoords
      ? { lat: state.lastFetchedCoords.lat, lon: state.lastFetchedCoords.lon }
      : null,
    // A getter, not the awaited array: a weekly roster refresh can land while
    // the search box is open, and capturing it would freeze that out.
    ships: () => shipRosterNow(),
    /**
     * Ports of call from whatever itineraries are loaded, resolved here because
     * findTimezoneFromGeoJSON needs the boundary data and ports.ts stays pure.
     *
     * A ship's own row is what makes her itinerary load, so in practice this is
     * populated for the ships the user is actually watching.
     */
    ports: () => portRefsFrom(
      state.shipClocks.map((ship) => ({
        // The full name, not the short one. A clock row uses `short` because it
        // competes with a time for width; this line is a dropdown subtitle with
        // room to spare, and "Star of the Seas" identifies the vessel where
        // "Star" alone reads like another place name.
        ship: ship.name,
        voyage: cachedVoyageFor(shipKey(ship)),
      })),
      findTimezoneFromGeoJSON),
    onSelect: (place) => {
      if (place.kind === 'ship') {
        const clock = addShipClock(place.ship);
        renderWorldClocks();
        updateAllClocks();
        void resolveAllShipClocks();
        // And shown, like every other thing picked out of this box. This used
        // to add the row and stop, on the reasoning that a ship has no position
        // on the map — which stopped being true the day she got a hull, a wake
        // and a route. Picking her here now does what picking her row does:
        // lights her band, draws her chart, and frames the cruise.
        //
        // Guarded because selectShip toggles: without this, searching for the
        // vessel already selected would turn her off.
        const key = shipKey(clock);
        if (state.selectedShipKey !== key) selectShip(key);
        return;
      }
      // One record for the place, rather than a zone plus three side-tables
      // keyed by it. A port keeps its own name on the row ("Cozumel"), the same
      // way a city does, and is marked with an anchor so it reads as somewhere
      // the ship calls rather than somewhere the user lives — and where it is,
      // so the map can draw the berth rather than the region around it.
      const zone: StoredZone = { tz: place.tzid };
      if (place.kind === 'city' || place.kind === 'port') zone.label = place.label;
      if (place.kind === 'port') { zone.kind = 'port'; zone.at = place.at; }
      if (place.kind === 'city') zone.at = place.at;

      keepZone(zone);
      // Shown as well as selected. The map is wherever it was left — usually
      // the whole world, where a port's ring is four pixels and a city is none
      // at all — so picking a place here frames it: the point for a town or a
      // berth, the whole shape for a zone, which is what its name refers to.
      selectSavedZone(zone, place.kind === 'zone' ? 'zone' : place.at);
      updateAllClocks();
    },
  });

  /**
   * Brings the map back into view.
   *
   * On a phone the World Clock list is below the fold, so picking a row framed
   * a map that was off the bottom of the screen — the answer arrived somewhere
   * the user could not see it.
   *
   * Unconditional, on purpose. This used to skip when enough of the map was
   * already showing, and the threshold turned out to be the wrong idea rather
   * than the wrong number: a map half on screen is still a map you have to go
   * looking at, and a rule about how much counts is a rule the user has to
   * learn. Going every time is the predictable thing, and where the map has
   * not moved this costs a scroll of nothing.
   *
   * The MAP's own top edge, not the card's. Taking the card in meant taking
   * its header too, which is further than the ask: the map is the thing being
   * looked at, and the cards above it stay a scroll away rather than costing
   * every trip a header's worth of overshoot.
   */
  function revealMap(): void {
    document.getElementById('timezone-map')?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
      block: 'start',
    });
  }

  // The cards above the map name places too, so they answer to a tap the way a
  // row does: shown on the map, and the map brought into view. Not the hovered
  // card — it exists only while a pointer is somewhere else, and moving to
  // click it is what makes it go away.
  dom.userTimezoneDetailsEl.addEventListener('click', () => {
    revealAnchor();
    revealMap();
  });
  // The gold card puts the selection DOWN rather than going to it — see
  // clearSelection. No trip to the map either: there is nothing left to look at.
  dom.selectedTimezoneDetailsEl.addEventListener('click', () => clearSelection());

  // And answering a pointer, where there is one. Asked as a capability rather
  // than guessed from the user agent, because the question really is whether
  // this device can hover: the native apps cannot, and on a touchscreen a
  // mouseenter arrives with the tap and then has nothing to end it.
  //
  // Highlight only. A card is not a place to zoom from — the map would move
  // under a pointer that was only passing over.
  if (window.matchMedia?.('(hover: hover)').matches) {
    const lightUp = (el: HTMLElement, light: (on: boolean) => void) => {
      el.addEventListener('mouseenter', () => light(true));
      el.addEventListener('mouseleave', () => light(false));
    };
    lightUp(dom.userTimezoneDetailsEl, hoverAnchor);
    lightUp(dom.selectedTimezoneDetailsEl, hoverSelected);

    // The rows below answer too. Delegated on mouseOVER rather than per-row on
    // mouseenter, because rows come and go with every render and enter does not
    // bubble — one listener on the container outlives them all. Moving between
    // rows arrives as another mouseover with the new key, and the gaps between
    // them as one with no key at all, which is the clear.
    dom.worldClocksContainerEl.addEventListener('mouseover', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-clock-key]');
      hoverClockRow(row?.dataset.clockKey ?? null);
    });
    // Leaving the list entirely, which no mouseover reports.
    dom.worldClocksContainerEl.addEventListener('mouseleave', () => hoverClockRow(null));
  }

  dom.worldClocksContainerEl.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const removeBtn = target.closest('.remove-btn');
    const pinBtn = target.closest('.pin-btn');

    if (removeBtn) {
      const key = (removeBtn as HTMLElement).dataset.clockTarget!;
      if (key.startsWith('ship:')) {
        forgetShip(key.slice('ship:'.length));
      } else {
        // By place, so removing Tampa leaves New York alone.
        persistZones(state.savedZones.filter((zone) => zoneKey(zone) !== key));
      }
      renderWorldClocks();
      updateAllClocks();
    } else if (pinBtn) {
      // Only zones are ever transient — the pin button promotes the map's
      // temporary selection into the saved list, and ships are saved on add.
      // The whole record is promoted, name and anchor and position with it.
      const pinned = state.temporaryZone;
      if (pinned && zoneKey(pinned) === (pinBtn as HTMLElement).dataset.clockTarget) {
        keepZone(pinned);
      }
      renderWorldClocks();
      updateAllClocks();
    } else {
        const clockDiv = target.closest<HTMLElement>('[data-clock-key]');
        const key = clockDiv?.dataset.clockKey;
        if (!key) return;
        // A ship highlights every zone keeping its time, without any zone being
        // the ship. The "ship:" prefix exists only in the DOM, so it is stripped
        // before the key reaches anything that stores or resolves it.
        if (key.startsWith('ship:')) {
            selectShip(key.slice('ship:'.length));
        } else {
            // The row's own record, so a port row selects the port and a city
            // row does not answer with the name of its zone.
            const zone = savedZoneByKey(key)
              ?? (state.temporaryZone && zoneKey(state.temporaryZone) === key
                    ? state.temporaryZone : null);
            // And shown, the way a ship's row has always shown her. Tapping a
            // row is asking about that place; leaving the map wherever it
            // happened to be answered half the question, and answered it
            // differently depending on which kind of row was tapped.
            if (!zone) return;
            selectSavedZone(zone, zone.at ?? 'zone');
        }

        // And the map brought up to where it can be seen — see revealMap. The
        // row is below the fold on a phone, so framing it moved a map that was
        // off the bottom of the screen: the answer arrived out of sight.
        //
        // Every tap, including the one that turns a row OFF. Deselecting still
        // changes the map, and a rule about which taps travel is more to know
        // than it is worth.
        revealMap();
    }
  });

  document.addEventListener('temporarytimezonechanged', () => {
    renderWorldClocks();
    updateAllClocks();
  });

  // Tapping a ship's marker is the same act as tapping its row. Routed through
  // an event so ship-markers.ts does not have to import from map.ts, which
  // already imports from it.
  document.addEventListener('shipmarkerclick', (e) => {
    selectShip((e as CustomEvent<{ key: string }>).detail.key);
  });

  // Pointing at a hull explains it, the same way pointing at a zone does. Muted
  // on touch, where there is no pointing — only tapping, which selects.
  document.addEventListener('shipmarkerhover', (e) => {
    if (matchMedia('(hover: none)').matches) return;
    setHoveredShip((e as CustomEvent<{ key: string | null }>).detail.key);
  });

  // A port of call is a place like any other on this map: point at it and the
  // card names it, tap it and it is selected, with the pin beside its row to
  // keep it. Both routed the same way as the hull's, and muted on touch for the
  // same reason.
  document.addEventListener('placemarkerhover', (e) => {
    if (matchMedia('(hover: none)').matches) return;
    setHoveredPlace((e as CustomEvent<PlaceMarkerDetail | null>).detail);
  });

  document.addEventListener('placemarkerclick', (e) => {
    selectPlace((e as CustomEvent<PlaceMarkerDetail>).detail);
  });

  // The ship we are aboard has no row to tap — it collapsed into this card — so
  // the card itself is its affordance. Exactly the same act, just promoted.
  dom.shipTimeSectionEl.addEventListener('click', () => {
    const aboard = state.aboardShipKey;
    if (aboard) selectShip(aboard);
  });

  // A ship that has just resolved needs the list rebuilt, because its offset is
  // what decides where it sorts — until then it sits at the end, having no
  // offset to place it by.
  document.addEventListener('shipclockschanged', () => {
    renderWorldClocks();
    updateAllClocks();
    // The anchor slot needs this too, not just the boarding event. Boarding is
    // detected BEFORE the ship's offset resolves — the marker arrives on one
    // response and the clock on a later one — and a ship with no offset cannot
    // anchor anything, so without this the slot keeps the shore's colours for
    // the whole of a first launch aboard.
    refreshAnchorChip();
    refreshMapStyles();
  });

  // Stepping aboard or ashore changes which surface the ship appears on: the
  // Ship Time section while detected, an ordinary World Clock row otherwise.
  document.addEventListener('aboardshipchanged', () => {
    renderWorldClocks();
    updateAllClocks();
    // Boarding moves the anchor, and the anchor is what the left slot names and
    // what the green band paints. Neither follows from the clock list alone.
    refreshAnchorChip();
    refreshMapStyles();
  });

  // The left slot keeps its own colour now, whatever is selected: blue for the
  // ground ashore, green for the ship aboard. Selecting the zone you are
  // standing in turns the SELECTED slot blue instead — see updateZoneCard — so a
  // colour always names the thing rather than the act of choosing it, and the
  // two slots can never both claim gold.
  document.addEventListener('gpstimezoneSelectionChanged', () => {
      refreshMapStyles();
  });

  document.addEventListener('gpstimezonefound', (e) => {
    const { tzid } = (e as CustomEvent).detail;
    dom.localTimezoneEl.textContent = getDisplayTimezoneName(tzid);
    // Only if nothing on the list already keeps this zone. The point is that
    // your own zone is represented, and a row named "Nelson" represents
    // America/Vancouver perfectly well — adding a bare "Vancouver" beside it
    // would be the app disagreeing with the name the user chose. This is the
    // one place that folds by ZONE rather than by place, and it is because the
    // list is being added to on the user's behalf rather than by them.
    if (!state.savedZones.some((zone) => zone.tz === tzid)) keepZone({ tz: tzid });

    if (state.timezonesFromUrl) {
      const toSelect = state.timezonesFromUrl.find((zone) => zone.tz !== tzid);
      if (toSelect) selectSavedZone(toSelect);
      state.timezonesFromUrl = null;
    }

    renderWorldClocks();
  });

  renderWorldClocks();
}

startApp();

/**
 * `?fix=lat,lon` in a shiptest build: pretend the device is there.
 *
 * Reports altitude, speed and heading so the fix reads as sensor-derived. Ship
 * detection refuses a network fix on purpose — a ship's wifi is Starlink, and
 * one of those can place you on another continent — so a stand-in that skipped
 * that would be exercising a path no real device takes.
 */
function standAt(): boolean {
  const raw = new URLSearchParams(window.location.search).get('fix');
  if (!raw) return false;
  const [lat, lon] = raw.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

  console.warn(`[shiptest] standing at ${lat}, ${lon} — real geolocation is off.`);
  void onLocationSuccess({
    coords: {
      latitude: lat, longitude: lon, accuracy: 8,
      altitude: 12, altitudeAccuracy: 5, speed: 0, heading: 0,
    },
    timestamp: Date.now(),
  } as unknown as GeolocationPosition);
  return true;
}
