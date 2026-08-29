// src/map.ts

import * as dom from './dom';
import { state, persistTimezones } from './state';
import { fetchTimezoneForCoordinates, findTimezoneFromGeoJSON, startClocks, getTimezoneOffset, getFormattedTime, getUtcOffset, getDisplayTimezoneName } from './time';
import { locationMapStyles, worldTimezoneMapStyles } from './map-styles';
import { syncWidgetTimezones } from './widget';
import { distance, formatAccuracy } from './utils';

let userTimeInterval: number | null = null;
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export function showLocationUnavailable() {
  if (state.locationAvailable) return;

  console.log("Location unavailable")
  
  dom.locationLoader.classList.add('hidden');
  dom.locationContent.classList.remove('hidden');

  dom.locationTitleEl.innerHTML = `<i class="fas fa-location-dot fa-fw mr-3 text-red-400"></i>Location Unavailable`;
  dom.latitudeEl.textContent = '---.----°';
  dom.longitudeEl.textContent = '---.----°';
  
  dom.accuracyDisplayEl.innerHTML = `<i class="fas fa-bullseye fa-fw mr-2 text-gray-400"></i>Accuracy: Unknown`;
  dom.accuracyDisplayEl.classList.remove('hidden');
}

function updateCard(
  cardEl: HTMLElement,
  nameEl: HTMLElement,
  valueEl: HTMLElement,
  tzid: string | null,
  valueType: 'offset' | 'time'
) {
  if (tzid) {
    nameEl.textContent = getDisplayTimezoneName(tzid);

    if (valueType === 'offset') {
      const referenceTz = state.gpsTzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
      valueEl.textContent = getTimezoneOffset(tzid, referenceTz);
    }

    cardEl.classList.remove('hidden');
  } else {
    cardEl.classList.add('hidden');
    nameEl.textContent = '';
    valueEl.textContent = '';
  }
}

export function updateUserTimezoneDetails(tzid: string) {
  const city = getDisplayTimezoneName(tzid);
  dom.userTimezoneNameEl.textContent = city;
  dom.userTimezoneDetailsEl.classList.remove('hidden');

  if (userTimeInterval) window.clearInterval(userTimeInterval);

  const updateTime = () => {
    dom.userTimezoneTimeEl.textContent = getFormattedTime(tzid, {
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  
  updateTime();
  userTimeInterval = window.setInterval(updateTime, 1000);
}

/**
 * Selects a zone by id, or toggles it off if it is already selected.
 *
 * Clicking a *different* zone inside the currently selected band moves the
 * selection rather than deselecting — only re-clicking the selected zone itself
 * clears it. That is the behaviour the offset-keyed version had, generalised
 * from "one zone per band" to "any zone".
 */
function selectZone(newTzid: string | null) {
    if (!newTzid) return;

    const isGpsTz = newTzid === state.gpsTzid;
    const isDeselecting = state.temporaryTimezone === newTzid;

    const nextGpsSelectedState = !isDeselecting && isGpsTz;
    if (state.gpsTimezoneSelected !== nextGpsSelectedState) {
        state.gpsTimezoneSelected = nextGpsSelectedState;
        document.dispatchEvent(new CustomEvent('gpstimezoneSelectionChanged', { detail: { selected: state.gpsTimezoneSelected } }));
    }

    if (isDeselecting) {
        state.selectedTzid = null;
        state.temporaryTimezone = null;
    } else {
        state.selectedTzid = newTzid;
        state.temporaryTimezone = newTzid;
    }

    updateCard(
        dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl, dom.selectedTimezoneOffsetEl,
        (isDeselecting || state.gpsTimezoneSelected) ? null : newTzid,
        'offset'
    );

    if (isTouchDevice) setHoveredZone(null);
    refreshMapStyles();
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
}

export function selectTimezone(tzid: string) {
    selectZone(tzid);
}

function createMyLocationButton(map: google.maps.Map) {
    const controlButton = document.createElement('button');
    controlButton.style.backgroundColor = '#aaa';
    controlButton.style.border = 'none';
    controlButton.style.borderRadius = '2px';
    controlButton.style.boxShadow = '0 2px 6px rgba(0,0,0,.3)';
    controlButton.style.cursor = 'pointer';
    controlButton.style.margin = '10px';
    controlButton.style.padding = '3px';
    controlButton.style.textAlign = 'center';
    controlButton.title = 'Click to recenter the map on your location';
    map.controls[google.maps.ControlPosition.TOP_RIGHT].push(controlButton);

    const controlText = document.createElement('div');
    controlText.innerHTML = '<img src="/current-location.svg" width="24" height="24"/>';
    controlButton.appendChild(controlText);

    controlButton.addEventListener('click', () => {
        if (state.lastFetchedCoords) {
            map.setCenter({ lat: state.lastFetchedCoords.lat, lng: state.lastFetchedCoords.lon });
        }
    });
}

export async function initMaps() {
  const { Map } = await google.maps.importLibrary("maps") as google.maps.MapsLibrary;
  const { Marker } = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
  const { Circle } = await google.maps.importLibrary("maps") as google.maps.MapsLibrary;

  const locationMapOptions: google.maps.MapOptions = {
    center: { lat: 0, lng: 0 },
    zoom: 2,
    styles: locationMapStyles,
    disableDefaultUI: true,
    zoomControl: false,
  };

  const timezoneMapOptions: google.maps.MapOptions = {
    center: { lat: 0, lng: 0 },
    zoom: 2,
    styles: worldTimezoneMapStyles,
    disableDefaultUI: true,
    zoomControl: false,
  };

  const locationMapEl = document.getElementById('location-map') as HTMLElement;
  state.locationMap = new Map(locationMapEl, locationMapOptions);
  createMyLocationButton(state.locationMap);
  
  const blueDotIcon: google.maps.Symbol = {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 5,
      fillColor: '#4285F4',
      fillOpacity: 1,
      strokeColor: '#FFFFFF',
      strokeWeight: 2,
  };

  state.locationMarker = new Marker({ map: state.locationMap, position: { lat: 0, lng: 0 }, icon: blueDotIcon, visible: false });
  state.accuracyCircle = new Circle({
    map: state.locationMap,
    radius: 0,
    fillColor: '#4285F4',
    fillOpacity: 0.2,
    strokeColor: '#4285F4',
    strokeOpacity: 0.5,
    strokeWeight: 1,
    center: { lat: 0, lng: 0 }
  });

  const timezoneMapEl = document.getElementById('timezone-map') as HTMLElement;
  state.timezoneMap = new Map(timezoneMapEl, timezoneMapOptions);
  createMyLocationButton(state.timezoneMap);
  state.timezoneMapMarker = new Marker({ map: state.timezoneMap, position: { lat: 0, lng: 0 }, icon: blueDotIcon, visible: false });

  await setupTimezoneMapListeners();

  state.mapsReady = true;

  if (state.lastFetchedCoords && !state.initialLocationSet) {
    updateLocationMap(state.lastFetchedCoords.lat, state.lastFetchedCoords.lon, 0); // accuracy can be 0, it doesn't affect centering
    updateTimezoneMapMarker(state.lastFetchedCoords.lat, state.lastFetchedCoords.lon);
    state.initialLocationSet = true;
  }
}

async function setupTimezoneMapListeners() {
  if (!state.timezoneMap) return;
  await loadTimezoneGeoJson();

  state.timezoneMap.data.addGeoJson(state.geoJsonData);
  indexFeaturesByOffset();
  refreshMapStyles();

  state.timezoneMap.data.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
    if (isTouchDevice) return;

    const tzid = event.feature.getProperty('tzid') as string;
    setHoveredZone(tzid);

    const isAlreadyShown = tzid === state.gpsTzid || tzid === state.temporaryTimezone;
    updateCard(
      dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl,
      isAlreadyShown ? null : tzid,
      'offset'
    );
  });

  document.getElementById('timezone-map')!.addEventListener('mouseleave', () => {
    if (isTouchDevice) return;
    setHoveredZone(null);
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset');
  });

  state.timezoneMap.data.addListener('click', (event: google.maps.Data.MouseEvent) => {
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset');
    selectZone(event.feature.getProperty('tzid') as string);
  });
}

// Features grouped by their current UTC offset, so "highlight everything at this
// time" is a map lookup rather than a scan of all 444 features on every hover.
const featuresByOffset = new Map<number, google.maps.Data.Feature[]>();

function indexFeaturesByOffset() {
  featuresByOffset.clear();
  state.timezoneMap!.data.forEach((f) => {
    const offset = f.getProperty('current_offset') as number;
    const bucket = featuresByOffset.get(offset);
    if (bucket) bucket.push(f); else featuresByOffset.set(offset, [f]);
  });
}

function bandOf(tzid: string | null): google.maps.Data.Feature[] {
  if (!tzid) return [];
  return featuresByOffset.get(getUtcOffset(tzid)) ?? [];
}

const STYLES = {
  // Two tiers per state: the whole same-time band gets a wash, the individual
  // zone under the cursor/selection gets a stronger fill and an outline, so a
  // segment reads as part of its band rather than as a separate thing.
  base:           { fillColor: '#000000', fillOpacity: 0, strokeColor: 'rgba(255,255,255,0.2)', strokeWeight: 1, zIndex: 1 },
  gpsBand:        { fillColor: '#3F80FF', fillOpacity: 0.35, strokeColor: 'rgba(255,255,255,0.2)', strokeWeight: 1, zIndex: 2 },
  gpsSegment:     { fillColor: '#3F80FF', fillOpacity: 0.75, strokeColor: '#FFFFFF', strokeWeight: 1.5, zIndex: 5 },
  hoverBand:      { fillColor: '#FFFFFF', fillOpacity: 0.18, strokeColor: 'rgba(255,255,255,0.3)', strokeWeight: 1, zIndex: 3 },
  hoverSegment:   { fillColor: '#FFFFFF', fillOpacity: 0.45, strokeColor: '#FFFFFF', strokeWeight: 1.5, zIndex: 4 },
  selectedBand:   { fillColor: '#FFD700', fillOpacity: 0.3, strokeColor: 'rgba(255,255,255,0.25)', strokeWeight: 1, zIndex: 6 },
  selectedSegment:{ fillColor: '#FFD700', fillOpacity: 0.8, strokeColor: '#FFFFFF', strokeWeight: 2, zIndex: 7 },
} satisfies Record<string, google.maps.Data.StyleOptions>;

function styleFor(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
  const tzid = feature.getProperty('tzid') as string;
  const offset = feature.getProperty('current_offset') as number;

  const sameOffsetAs = (other: string | null) =>
    other !== null && getUtcOffset(other) === offset;

  // The GPS zone is shown as "selected" (gold) while it is the active choice.
  const selectedTzid = state.gpsTimezoneSelected ? state.gpsTzid : state.selectedTzid;

  if (tzid === selectedTzid) return STYLES.selectedSegment;
  if (tzid === state.gpsTzid) return STYLES.gpsSegment;
  if (sameOffsetAs(selectedTzid)) return STYLES.selectedBand;
  if (sameOffsetAs(state.gpsTzid)) return STYLES.gpsBand;
  if (tzid === state.hoveredTzid) return STYLES.hoverSegment;
  if (sameOffsetAs(state.hoveredTzid)) return STYLES.hoverBand;
  return STYLES.base;
}

/** Full restyle. Only for selection changes — hover uses the delta path below. */
export function refreshMapStyles() {
  if (!state.timezoneMap) return;
  state.timezoneMap.data.revertStyle();   // drop any hover overrides
  state.timezoneMap.data.setStyle(styleFor);
}

/**
 * Hover restyles only the features that actually changed (the band being left
 * plus the band being entered) via overrideStyle, instead of re-running
 * setStyle across every feature on every mouse move.
 */
function setHoveredZone(tzid: string | null) {
  if (!state.timezoneMap || state.hoveredTzid === tzid) return;

  const touched = new Set([...bandOf(state.hoveredTzid), ...bandOf(tzid)]);
  state.hoveredTzid = tzid;
  for (const f of touched) state.timezoneMap.data.overrideStyle(f, styleFor(f));
}

async function loadTimezoneGeoJson() {
  if (state.geoJsonLoaded) return;
  try {
    const response = await fetch('timezones.geojson');
    const geoJson = await response.json();

    // Cache each zone's current offset once; it drives band grouping and sorting.
    geoJson.features.forEach((feature: any) => {
        feature.properties.current_offset = getUtcOffset(feature.properties.tzid);
    });

    state.geoJsonData = geoJson;
    state.geoJsonLoaded = true;
  } catch (error) {
    console.error('Could not load timezone GeoJSON:', error);
  }
}

function updateLocationMap(lat: number, lon: number, accuracy: number) {
    if (state.locationMap && state.locationMarker && state.accuracyCircle) {
        const pos = { lat, lng: lon };

        state.locationMarker.setPosition(pos);
        state.locationMarker.setVisible(true);
        state.accuracyCircle.setCenter(pos);
        state.accuracyCircle.setRadius(accuracy);

        if (!state.initialLocationSet) {
            const circleBounds = state.accuracyCircle.getBounds();
            if (circleBounds) {
                state.locationMap.fitBounds(circleBounds);

                google.maps.event.addListenerOnce(state.locationMap, 'idle', () => {
                    if (state.locationMap && state.locationMap.getZoom()! > 17) {
                        state.locationMap.setZoom(17);
                    }
                });

            } else {
                state.locationMap.setCenter(pos);
                state.locationMap.setZoom(12);
            }
        }
    }
}

function updateTimezoneMapMarker(lat: number, lon: number) {
  if (state.timezoneMap && state.timezoneMapMarker) {
    const pos = { lat, lng: lon };
    if (!state.initialLocationSet) {
        state.timezoneMap.setCenter(pos);
    }
    state.timezoneMapMarker.setPosition(pos);
    state.timezoneMapMarker.setVisible(true);
  }
}

export function onLocationError(error: GeolocationPositionError) {
  console.error(`Geolocation error: ${error.message}`);
  if (!state.localTimezone) {
    state.localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    startClocks();
  }
}

export async function onLocationSuccess(pos: GeolocationPosition) {
  state.locationAvailable = true;
  console.log('Location success:', pos.coords);
  const { coords } = pos;
  const { latitude, longitude, accuracy, altitude, speed, heading } = coords;

  if (accuracy <= 15 && (altitude !== null || speed !== null || heading !== null)) {
    dom.locationTitleEl.innerHTML = `<i class="fas fa-satellite-dish fa-fw mr-2 text-blue-400"></i>GPS Location`;
  } else if (accuracy <= 15) {
    dom.locationTitleEl.innerHTML = `<i class="fas fa-location-dot fa-fw mr-2 text-blue-400"></i>Location`;
  } else {
    dom.locationTitleEl.innerHTML = `<i class="fas fa-wifi fa-fw mr-2 text-blue-400"></i>Approximate Location`;
  }
  
  dom.accuracyDisplayEl.innerHTML = `<i class="fas fa-bullseye fa-fw mr-1 text-gray-400"></i>Accuracy: ${formatAccuracy(accuracy)}`;
  dom.accuracyDisplayEl.classList.remove('hidden');

  const formatCoordinate = (value: number, padding: number): string => {
      const [integer, fractional] = value.toFixed(4).split('.');
      return `${integer.padStart(padding, '\u00A0')}.${fractional}°`;
  };

  dom.latitudeEl.textContent = formatCoordinate(latitude, 4);
  dom.longitudeEl.textContent = formatCoordinate(longitude, 4);
  
  dom.locationLoader.classList.add('hidden');
  dom.locationContent.classList.remove('hidden');

  // --- MODIFICATION START ---
  // Only center the map if it's ready and this is the first location update of the session.
  if (state.mapsReady && !state.initialLocationSet) {
    updateLocationMap(latitude, longitude, accuracy);
    updateTimezoneMapMarker(latitude, longitude);
    state.initialLocationSet = true; // Set the flag AFTER the first update
  } else if (state.mapsReady) {
    // For subsequent updates, just move the markers without re-centering.
    if (state.locationMarker) {
      state.locationMarker.setPosition({ lat: latitude, lng: longitude });
    }
    if (state.timezoneMapMarker) {
      state.timezoneMapMarker.setPosition({ lat: latitude, lng: longitude });
    }
    if (state.accuracyCircle) {
      const pos = { lat: latitude, lng: longitude };
      state.accuracyCircle.setCenter(pos);
      state.accuracyCircle.setRadius(accuracy);
    }
  }

  const geoJsonTz = findTimezoneFromGeoJSON(latitude, longitude);
  const crossedBoundary = geoJsonTz !== state.localTimezone;

  const dist = distance(latitude, longitude, state.lastFetchedCoords?.lat || 0, state.lastFetchedCoords?.lon || 0);
  if (dist > 0.1 || crossedBoundary) {
    state.lastFetchedCoords = { lat: latitude, lon: longitude };
    const tzid = await fetchTimezoneForCoordinates(latitude, longitude);

    if (tzid && tzid !== state.localTimezone) {
      console.log(`Timezone updated to ${tzid}`);
      state.localTimezone = tzid;
      state.gpsTzid = tzid;

      updateUserTimezoneDetails(tzid);

      // The widget bases its pin/offsets on the GPS-derived local zone.
      syncWidgetTimezones(state.addedTimezones, state.localTimezone);

      refreshMapStyles();

      document.dispatchEvent(new CustomEvent('gpstimezonefound', { detail: { tzid } }));
    }
  }
}

/**
 * Adds a zone, keyed on its IANA id.
 *
 * Deliberately does NOT evict zones sharing the new one's current UTC offset.
 * That rule is what silently turned America/Vancouver into America/Los_Angeles:
 * two zones can read the same today and differ in November, and if the user
 * asked for both they get both.
 */
export function addUniqueTimezoneToList(tz: string) {
    if (state.addedTimezones.includes(tz)) return;

    persistTimezones([...state.addedTimezones, tz]);
    renderWorldClocks();
}

export function renderWorldClocks() {
    dom.worldClocksContainerEl.innerHTML = '';

    const timezonesToRender = [...state.addedTimezones];
    if (state.temporaryTimezone && !timezonesToRender.includes(state.temporaryTimezone)) {
        timezonesToRender.push(state.temporaryTimezone);
    }

    timezonesToRender
        .sort((a, b) =>
            getUtcOffset(a) - getUtcOffset(b) ||
            getDisplayTimezoneName(a).localeCompare(getDisplayTimezoneName(b)))
        .forEach((tz: string) => {
            const clockElement = createClockElement(tz);
            dom.worldClocksContainerEl.appendChild(clockElement);
        });
}

function createClockElement(tz: string): HTMLElement {
    const template = dom.worldClockTemplate;
    const clone = template.content.cloneNode(true) as DocumentFragment;
    const clockDiv = clone.querySelector('.grid') as HTMLElement;

    // Zone ids contain hyphens (America/Port-au-Prince, Etc/GMT-5), so a
    // slugified id cannot be turned back into the zone. Carry it verbatim.
    // Distinct from the buttons' data-timezone so row lookups can't match a button.
    clockDiv.dataset.clockTz = tz;

    clockDiv.classList.remove('border-transparent', 'border-blue-500', 'border-yellow-500');

    if (tz === state.gpsTzid && state.gpsTimezoneSelected) {
        clockDiv.classList.add('border-yellow-500');
    } else if (tz === state.gpsTzid) {
        clockDiv.classList.add('border-blue-500');
    } else if (tz === state.temporaryTimezone) {
        clockDiv.classList.add('border-yellow-500');
    } else {
        clockDiv.classList.add('border-transparent');
    }

    if (tz === state.temporaryTimezone && !state.addedTimezones.includes(tz)) {
        clockDiv.classList.add('bg-yellow-800', 'bg-opacity-50');
    } else {
        clockDiv.classList.remove('bg-yellow-800', 'bg-opacity-50');
    }

    clone.querySelector('.city')!.textContent = getDisplayTimezoneName(tz);
    const removeBtn = clone.querySelector('.remove-btn') as HTMLElement;
    const pinBtn = clone.querySelector('.pin-btn') as HTMLElement;

    removeBtn.dataset.timezone = tz;
    pinBtn.dataset.timezone = tz;

    if (tz === state.temporaryTimezone && !state.addedTimezones.includes(tz)) {
        removeBtn.classList.add('hidden');
        pinBtn.classList.remove('hidden');
    } else {
        removeBtn.classList.remove('hidden');
        pinBtn.classList.add('hidden');
    }

    return clockDiv;
}