/// <reference types="vite/client" />
// src/main.ts

import './style.css';
import { Loader } from '@googlemaps/js-api-loader';
import * as dom from './dom';
import { state, persistTimezones, migrateStoredTimezones } from './state';
import { initMaps, onLocationError, onLocationSuccess, selectTimezone, renderWorldClocks, addUniqueTimezoneToList, updateUserTimezoneDetails, showLocationUnavailable } from './map';
import { updateAllClocks, syncClock, getDisplayTimezoneName, startClocks, isValidTimezone } from './time';
import { Capacitor } from '@capacitor/core';
import { syncWidgetTimezones, getDeviceTimezone, onDeviceTimezoneChanged } from './widget';
import { Geolocation, PositionOptions } from '@capacitor/geolocation';
import { library, dom as faDom } from '@fortawesome/fontawesome-svg-core';
import { faLocationDot, faWifi, faBullseye, faMobileAlt, faSatelliteDish } from '@fortawesome/free-solid-svg-icons';

library.add(faLocationDot, faWifi, faBullseye, faMobileAlt, faSatelliteDish);
faDom.watch();

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

function handleUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('timezones')) {
        const timezonesParam = urlParams.get('timezones');
        if (timezonesParam) {
            const timezones = migrateStoredTimezones(timezonesParam.split(','));

            persistTimezones(timezones);

            state.timezonesFromUrl = timezones;
        }

        history.replaceState(null, '', window.location.pathname);
    }
}

function handleAddTimezone() {
    const newTimezone = dom.timezoneInput.value.trim();
    if (!newTimezone) return;

    if (isValidTimezone(newTimezone)) {
        addUniqueTimezoneToList(newTimezone);
        if (state.localTimezone) {
          updateAllClocks();
        }
        dom.timezoneInput.value = '';
    } else {
        alert('Invalid or unsupported timezone. Please select from the list.');
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
  syncWidgetTimezones(state.addedTimezones, state.localTimezone);

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

  // Load maps separately. A failure here will not block location services.
  const loader = new Loader({
    apiKey: GOOGLE_MAPS_API_KEY,
    version: "weekly",
  });

  try {
    await loader.load();
    await initMaps();
  } catch (e) {
    console.error("Failed to load Google Maps.", e);
    // You could add UI to show the map is unavailable here if desired.
    // The location card will function independently.
  }

  // Union of what the runtime lists and what the map data uses. They disagree:
  // supportedValuesOf returns engine-dependent aliases (Asia/Calcutta on V8,
  // Asia/Kolkata on WebKit) while the boundaries always use the modern name, so
  // listing only one of them leaves zones you can click but cannot type.
  const listedZones = new Set<string>(Intl.supportedValuesOf('timeZone'));
  for (const f of state.geoJsonData?.features ?? []) listedZones.add(f.properties.tzid);
  dom.timezoneList.innerHTML = [...listedZones].sort()
    .map((tz) => `<option value="${tz}"></option>`).join('');

  dom.addTimezoneBtn.addEventListener('click', handleAddTimezone);
  dom.timezoneInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddTimezone();
  });
  
  dom.timezoneInput.addEventListener('input', () => {
    // Picking a datalist option fires 'input' with the full value; typing toward
    // one usually doesn't land on a valid id until the pick.
    if (isValidTimezone(dom.timezoneInput.value)) {
        handleAddTimezone();
    }
  });

  dom.worldClocksContainerEl.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const removeBtn = target.closest('.remove-btn');
    const pinBtn = target.closest('.pin-btn');

    if (removeBtn) {
      const timezoneToRemove = (removeBtn as HTMLElement).dataset.timezone!;
      persistTimezones(state.addedTimezones.filter((tz: string) => tz !== timezoneToRemove));
      renderWorldClocks();
      updateAllClocks();
    } else if (pinBtn) {
      const timezoneToPin = (pinBtn as HTMLElement).dataset.timezone!;
      addUniqueTimezoneToList(timezoneToPin);
      renderWorldClocks();
      updateAllClocks();
    } else {
        const clockDiv = target.closest<HTMLElement>('[data-clock-tz]');
        if (clockDiv?.dataset.clockTz) {
            selectTimezone(clockDiv.dataset.clockTz);
        }
    }
  });

  document.addEventListener('temporarytimezonechanged', () => {
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