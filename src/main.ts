/// <reference types="vite/client" />
// src/main.ts

import './style.css';
import { Loader } from '@googlemaps/js-api-loader';
import * as dom from './dom';
import { state, persistTimezones, migrateStoredTimezones, setZoneLabel, syncWidget, addShipClock } from './state';
import { initMaps, onLocationError, onLocationSuccess, selectTimezone, selectShip, renderWorldClocks, addUniqueTimezoneToList, updateUserTimezoneDetails, showLocationUnavailable, loadTimezoneGeoJson } from './map';
import { updateAllClocks, syncClock, getDisplayTimezoneName, startClocks } from './time';
import { Capacitor } from '@capacitor/core';
import { getDeviceTimezone, onDeviceTimezoneChanged } from './widget';
import { Geolocation, PositionOptions } from '@capacitor/geolocation';
import { createSearchCombobox } from './combobox';
import { loadShipRoster, refreshShipRoster, shipRosterNow } from './ships';
import { initShipTime } from './rccl';
import { forgetShip, resolveAllShipClocks, startShipTimeWatch } from './shiptime';
import { initShipTrack } from './shiptrack';
import { refreshShipMarkers, startShipMarkerWatch } from './ship-markers';
import { installDiagnostics } from './diagnostics';
import { library, dom as faDom } from '@fortawesome/fontawesome-svg-core';
import { faLocationDot, faWifi, faBullseye, faMobileAlt, faSatellite, faShip } from '@fortawesome/free-solid-svg-icons';

library.add(faLocationDot, faWifi, faBullseye, faMobileAlt, faSatellite, faShip);
faDom.watch();

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

function handleUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('timezones')) {
        const timezonesParam = urlParams.get('timezones');
        if (timezonesParam) {
            const shared = migrateStoredTimezones(timezonesParam.split(','));
            const timezones = shared.map((z) => z.tz);
            for (const zone of shared) setZoneLabel(zone.tz, zone.label);

            persistTimezones(timezones);

            state.timezonesFromUrl = timezones;
        }

        history.replaceState(null, '', window.location.pathname);
    }
}

async function startApp() {
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
  });
  installDiagnostics(dom.deviceTimezoneEl);

  // Start watching for location immediately.
  if (Capacitor.isNativePlatform()) {
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
    onSelect: (place) => {
      if (place.kind === 'ship') {
        // No map selection: a ship has no position on it, and its clock is set
        // by the crew rather than by where it happens to be floating.
        addShipClock(place.ship);
        renderWorldClocks();
        updateAllClocks();
        void resolveAllShipClocks();
        return;
      }
      setZoneLabel(place.tzid, place.kind === 'city' ? place.label : undefined);
      addUniqueTimezoneToList(place.tzid);
      selectTimezone(place.tzid);
      updateAllClocks();
    },
  });

  dom.worldClocksContainerEl.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const removeBtn = target.closest('.remove-btn');
    const pinBtn = target.closest('.pin-btn');

    if (removeBtn) {
      const key = (removeBtn as HTMLElement).dataset.clockTarget!;
      if (key.startsWith('ship:')) {
        forgetShip(key.slice('ship:'.length));
      } else {
        persistTimezones(state.addedTimezones.filter((tz: string) => tz !== key));
      }
      renderWorldClocks();
      updateAllClocks();
    } else if (pinBtn) {
      // Only zones are ever transient — the pin button promotes the map's
      // temporary selection into the saved list, and ships are saved on add.
      const timezoneToPin = (pinBtn as HTMLElement).dataset.clockTarget!;
      addUniqueTimezoneToList(timezoneToPin);
      renderWorldClocks();
      updateAllClocks();
    } else {
        const clockDiv = target.closest<HTMLElement>('[data-clock-key]');
        const key = clockDiv?.dataset.clockKey;
        if (!key) return;
        // A ship highlights every zone keeping its time, without any zone being
        // the ship. The "ship:" prefix exists only in the DOM, so it is stripped
        // before the key reaches anything that stores or resolves it.
        if (key.startsWith('ship:')) selectShip(key.slice('ship:'.length));
        else selectTimezone(key);
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
  });

  // Stepping aboard or ashore changes which surface the ship appears on: the
  // Ship Time section while detected, an ordinary World Clock row otherwise.
  document.addEventListener('aboardshipchanged', () => {
    renderWorldClocks();
    updateAllClocks();
  });

  document.addEventListener('gpstimezoneSelectionChanged', (e: Event) => {
      const { selected } = (e as CustomEvent).detail;
      if (selected) {
          dom.userTimezoneDetailsEl.classList.add('border-yellow-500');
          dom.userTimezoneDetailsEl.classList.remove('border-blue-500');
      } else {
          dom.userTimezoneDetailsEl.classList.remove('border-yellow-500');
          dom.userTimezoneDetailsEl.classList.add('border-blue-500');
      }
  });

  document.addEventListener('gpstimezonefound', (e) => {
    const { tzid } = (e as CustomEvent).detail;
    dom.localTimezoneEl.textContent = getDisplayTimezoneName(tzid);
    addUniqueTimezoneToList(tzid);

    if (state.timezonesFromUrl) {
      const timezoneToSelect = state.timezonesFromUrl.find(tz => tz !== tzid);
      if (timezoneToSelect) {
          selectTimezone(timezoneToSelect);
      }
      state.timezonesFromUrl = null;
    }

    renderWorldClocks();
  });

  renderWorldClocks();
}

startApp();