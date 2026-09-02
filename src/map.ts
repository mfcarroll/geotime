// src/map.ts

import * as dom from './dom';
import { state, persistTimezones, setLocalPlaceName, syncWidget } from './state';
import { timezoneForCoordinates, findTimezoneFromGeoJSON, startClocks, getTimezoneOffset, getFormattedTime, getUtcOffset, getDisplayTimezoneName, getZoneLabel, updateAllClocks, formatOffsetDiff } from './time';
import { locationMapStyles, worldTimezoneMapStyles } from './map-styles';
import { distance, formatAccuracy, fold } from './utils';
import { loadCityIndex, nearestPlace } from './cities';
import { resolveZoneStyle } from './map-highlight';
import { clockKey, clockLabel, clockSubLabel, visibleClocks, type ClockEntry } from './clocks';
import { shipKey, type ShipClock } from './ships';
import { voyageForShip, type ShipVoyage } from './shiptrack';
import { clearShipChart, drawShipChart, fitToShip, refreshShipMarkers } from './ship-markers';

/**
 * Cloud-styled vector maps.
 *
 * The base map used to be raster tiles styled server-side from the arrays in
 * map-styles.ts, which meant every label was baked pixels — upscaled on a 3x
 * display and soft no matter what colours it was given. Measured on device:
 * raster served 512px tiles into 256 CSS px in every configuration, so the
 * softness was never something styling or resolution could fix. Vector draws
 * labels client-side at device resolution instead.
 *
 * The trade is that a Map ID replaces inline `styles` — the API ignores them
 * when one is present — so the palette now lives in Google Cloud console styling
 * against these two IDs. They are public identifiers, not secrets: they travel
 * in every tile request, and the API key is what carries the restrictions.
 *
 * Defaulted in code rather than required from the environment on purpose. As
 * env-only they would be absent in CI, and the maps would quietly fall back to
 * raster in exactly the builds nobody inspects by hand. Overriding to an empty
 * string is the deliberate way back to the old path.
 */
/**
 * Both maps go vector, each with its own style.
 *
 * This was one map for a while, on a finding that turned out to be wrong. Two
 * vector maps really did fail in WKWebView — one rendered, the other stayed a
 * flat beige — but the cause was not a WebGL context limit. It was our own CSP:
 * no worker-src, so it fell back to script-src, which does not allow blob:, and
 * the renderer's WebGL workers were blocked. See the comment on the policy in
 * index.html. The measurements were real; the explanation was a guess, and it
 * held for as long as it did because the failure names nothing.
 *
 * Re-measured on the simulator with the policy fixed: both maps render, styled,
 * across six cold launches for the location map and three for the world map,
 * pixel-identical each time, with no CSP violation reaching the device log.
 *
 * Confirmed on a real iPhone as well, which is the check that counts: the
 * simulator's WebGL does not go through a phone's driver, and a context limit —
 * the wrong answer here — is exactly the kind of thing that would have differed.
 *
 * Two Map IDs rather than one, because the small map wants more detail than the
 * large one: locationMapStyles keeps the local roads the world map suppresses,
 * which is the whole point of it being a separate style.
 */
const LOCATION_MAP_ID: string =
  import.meta.env.VITE_MAP_ID_LOCATION ?? 'c75a3fdf244efe751e1f1767';
const TIMEZONE_MAP_ID: string =
  import.meta.env.VITE_MAP_ID_TIMEZONE ?? 'c75a3fdf244efe75fccc5434';

/**
 * Vector where there is a Map ID to render it, the old styled raster otherwise.
 *
 * `renderingType` is passed explicitly rather than left to the API. A Map ID
 * configured for vector should select it unprompted, but a silent fall back to
 * raster looks like nothing more than a slightly worse map — which is precisely
 * the kind of failure that goes unnoticed for months.
 */
function renderingOptions(
  mapId: string,
  fallbackStyles: google.maps.MapTypeStyle[]
): google.maps.MapOptions {
  if (!mapId) return { styles: fallbackStyles };
  return { mapId, renderingType: google.maps.RenderingType.VECTOR };
}

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
  // The map card names the zone; the Local Time card names the town you're in.
  dom.userTimezoneNameEl.textContent = getDisplayTimezoneName(tzid);
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

    // One gold band, one "selected" card: picking a zone drops any ship.
    state.selectedShipKey = null;

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
    // The ship selection was just cleared above; its marker has to stop looking
    // selected and its chart has to go, or the map shows two answers at once.
    refreshShipMarkers();
    clearShipChart();
    // Cleared, not just hidden: leaving one ship's ETA in a hidden element is a
    // trap for whoever next changes when this line is shown.
    setShipVoyageLine(null);
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
}

export function selectTimezone(tzid: string) {
    selectZone(tzid);
}

/**
 * Selects a ship, or toggles it off if it is already selected.
 *
 * The band this lights is "everywhere keeping the same time as this ship" —
 * which is a genuinely different question from the one a zone answers, and the
 * reason the feature exists. It is also why no zone goes solid gold: the ship
 * keeps that time without being anywhere on land.
 *
 * Note what is NOT reachable here: the ship's band can coincide with your own,
 * in which case the map does not change colour at all, because the GPS band
 * outranks the selected band where they are the same band. That is the existing
 * rule for zones and it is right for ships too — the ship keeps your time, so it
 * is still your band. The row border, the card and the marker carry the
 * selection in that case.
 */
export function selectShip(key: string): void {
    const isDeselecting = state.selectedShipKey === key;

    state.selectedShipKey = isDeselecting ? null : key;
    // A ship and a zone cannot both be selected; clear the zone side, including
    // the transient map pick, so the list does not keep showing a stray row.
    if (!isDeselecting) {
        state.selectedTzid = null;
        state.temporaryTimezone = null;
        if (state.gpsTimezoneSelected) {
            state.gpsTimezoneSelected = false;
            document.dispatchEvent(
                new CustomEvent('gpstimezoneSelectionChanged', { detail: { selected: false } })
            );
        }
    }

    const ship = state.shipClocks.find((s) => shipKey(s) === key);
    updateShipCard(isDeselecting ? null : ship ?? null);

    if (isTouchDevice) setHoveredZone(null);
    refreshMapStyles();
    refreshShipMarkers();
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));

    if (isDeselecting) {
        clearShipChart();
        return;
    }

    // One request, two consumers: the extent frames the map and the track, route
    // and ports draw the chart. Fetched once here and shared, rather than each
    // asking for the same thing.
    const voyage = voyageForShip(key);
    // Framing the ROUTE rather than the position is the difference between
    // framing a cruise and framing a dot in an ocean — which is also why the
    // ship lands off-centre, and looks right only once the route is drawn under
    // it. Falls back to the position when there is no route: a repositioning leg
    // has none.
    void fitToShip(key, voyage);
    void drawShipChart(key, voyage);
    void voyage.then((resolved) => {
        // Same guard as the map's: the user may have moved on, and a stale
        // destination under a new ship's name is worse than none.
        if (state.selectedShipKey === key) setShipVoyageLine(resolved);
    }).catch(() => {});
}

/**
 * Names the selected ship on the map's detail card, or hides it.
 *
 * Reuses the zone card rather than adding a second one: it already means "the
 * thing you picked", and a ship is a thing you picked. The value line is the
 * offset from local time — the same reading the card gives for a zone, so the
 * two are directly comparable.
 */
function updateShipCard(ship: ShipClock | null): void {
    if (!ship) {
        updateCard(
            dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl,
            dom.selectedTimezoneOffsetEl, null, 'offset'
        );
        setShipVoyageLine(null);
        return;
    }
    // Cleared until the voyage arrives, so a previous ship's destination cannot
    // sit under a new ship's name.
    setShipVoyageLine(null);

    // The short name, not the full one. This card is a compact overlay, and
    // "Independence of the Seas" truncates to "Independence of the S…" in it —
    // where `short` was built for exactly this: the same name with the words
    // that distinguish nothing removed. Ambiguity is not a risk here, since the
    // user just picked this row.
    dom.selectedTimezoneNameEl.textContent = ship.short;
    if (ship.offsetHours === null) {
        // The same wording the clock row uses, for the same reason: no offset
        // means nothing sensible to show, and the embark port's zone is the
        // obvious wrong answer.
        dom.selectedTimezoneOffsetEl.textContent = 'Finding ship time…';
    } else {
        const referenceTz = state.gpsTzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
        dom.selectedTimezoneOffsetEl.textContent =
            formatOffsetDiff(ship.offsetHours - getUtcOffset(referenceTz));
    }
    dom.selectedTimezoneDetailsEl.classList.remove('hidden');
}

/**
 * The third line of the card: where she is headed, and when she is due.
 *
 * Both come from the operator's own AIS and itinerary rather than from us, and
 * the ETA is quoted as they state it — a scheduled arrival at that port, in that
 * port's time. That is the conventional reading of an ETA and the only one it
 * can have, but it is the reason this line is small and subordinate: an
 * unqualified time is exactly what this app spends the rest of its surface
 * avoiding, so it should not compete with the clock above it.
 *
 * Hidden entirely when there is nothing to say, which is common — a third of
 * the fleet reports no usable destination.
 */
function setShipVoyageLine(voyage: ShipVoyage | null): void {
    const parts: string[] = [];
    if (voyage?.destination) parts.push(`→ ${voyage.destination}`);
    if (voyage?.eta) parts.push(`ETA ${voyage.eta}`);

    dom.selectedShipVoyageEl.textContent = parts.join(' · ');
    dom.selectedShipVoyageEl.classList.toggle('hidden', parts.length === 0);
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
    disableDefaultUI: true,
    zoomControl: false,
    ...renderingOptions(LOCATION_MAP_ID, locationMapStyles),
  };

  const timezoneMapOptions: google.maps.MapOptions = {
    center: { lat: 0, lng: 0 },
    zoom: 2,
    disableDefaultUI: true,
    zoomControl: false,
    ...renderingOptions(TIMEZONE_MAP_ID, worldTimezoneMapStyles),
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
  await loadTimezoneGeoJson();   // usually already resolved; see startApp

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

/**
 * The zone id the gold *segment* belongs to, and the offset the gold *band*
 * covers. A ship has the second without the first.
 */
function selectionFor(): { tzid: string | null; offset: number | null } {
  if (state.selectedShipKey) {
    const ship = state.shipClocks.find((s) => shipKey(s) === state.selectedShipKey);
    // No tzid: nothing on land is the ship. And no offset until one resolves —
    // otherwise an unresolved ship reads as 0 and lights up UTC.
    return { tzid: null, offset: ship?.offsetHours ?? null };
  }
  // The GPS zone is shown as "selected" (gold) while it is the active choice.
  const tzid = state.gpsTimezoneSelected ? state.gpsTzid : state.selectedTzid;
  return { tzid, offset: tzid ? getUtcOffset(tzid) : null };
}

function styleFor(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
  const selection = selectionFor();
  return resolveZoneStyle({
    tzid: feature.getProperty('tzid') as string,
    offset: feature.getProperty('current_offset') as number,
    selectedTzid: selection.tzid,
    selectedOffset: selection.offset,
    gpsTzid: state.gpsTzid,
    hoveredTzid: state.hoveredTzid,
    offsetOf: getUtcOffset,
  });
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

export async function loadTimezoneGeoJson() {
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
  const { coords } = pos;
  const { latitude, longitude, accuracy, altitude, speed, heading } = coords;

  // Whether the fix came from GPS or from wifi is not a detail at sea. A ship's
  // wifi is Starlink, and a wifi-derived position can land on the other side of
  // the world from the hull it was taken aboard — so the heading says which
  // kind of fix this is, and the user gets to distrust it accordingly.
  // Accuracy alone does not separate them: the tell is the sensor-only fields,
  // which a network fix cannot supply.
  if (accuracy <= 15 && (altitude !== null || speed !== null || heading !== null)) {
    dom.locationTitleEl.innerHTML = `<i class="fas fa-satellite fa-fw mr-2 text-blue-400"></i>GPS Location`;
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
    // Wait for the boundaries rather than guessing without them: resolving early
    // would fall through to the nautical fallback and put a coastal city in the
    // middle of the ocean.
    await loadTimezoneGeoJson();
    const tzid = timezoneForCoordinates(latitude, longitude);

    if (tzid && tzid !== state.localTimezone) {
      console.log(`Timezone updated to ${tzid}`);
      state.localTimezone = tzid;
      state.gpsTzid = tzid;

      updateUserTimezoneDetails(tzid);

      // The widget bases its pin/offsets on the GPS-derived local zone.
      syncWidget();

      refreshMapStyles();

      document.dispatchEvent(new CustomEvent('gpstimezonefound', { detail: { tzid } }));
    }
  }

  // After the zone is settled, not before: the nearest-town lookup is scoped to
  // the zone you are actually in, so running it against a stale gpsTzid finds
  // nothing and falls back to the zone name.
  void refreshLocalPlaceName(latitude, longitude);
}

/**
 * Adds a zone, keyed on its IANA id.
 *
 * Deliberately does NOT evict zones sharing the new one's current UTC offset.
 * That rule is what silently turned America/Vancouver into America/Los_Angeles:
 * two zones can read the same today and differ in November, and if the user
 * asked for both they get both.
 */
/**
 * Names the town the user is standing in, for the Local Time card and the
 * widget. Restricted to the user's own zone: a town just over a timezone
 * boundary keeps a different time, so naming it on a "local time" card would be
 * wrong. Falls back to the zone's own name when nothing is within range.
 */
let lastPlaceLookup: { lat: number; lon: number; tzid: string } | null = null;

async function refreshLocalPlaceName(lat: number, lon: number): Promise<void> {
  const tzid = state.gpsTzid;
  if (!tzid) return;

  // Only worth redoing once the fix has actually moved, or the zone changed.
  if (lastPlaceLookup && lastPlaceLookup.tzid === tzid
      && distance(lat, lon, lastPlaceLookup.lat, lastPlaceLookup.lon) < 1) {
    return;
  }
  lastPlaceLookup = { lat, lon, tzid };

  const place = nearestPlace(await loadCityIndex(), { lat, lon }, tzid);
  const name = place?.name ?? null;
  if (name === state.localPlaceName) return;

  setLocalPlaceName(name);
  updateAllClocks();
  syncWidget();
}

export function addUniqueTimezoneToList(tz: string) {
    if (state.addedTimezones.includes(tz)) return;

    persistTimezones([...state.addedTimezones, tz]);
    renderWorldClocks();
}

export function renderWorldClocks() {
    dom.worldClocksContainerEl.innerHTML = '';

    for (const entry of visibleClocks()) {
        dom.worldClocksContainerEl.appendChild(createClockElement(entry));
    }

    // Times first, then measure. The template ships "--:--" as a placeholder and
    // the time column is flex-none, so its width is set by its content — measure
    // before the real "12:13 AM" lands and every name is judged against a column
    // narrower than the one it will actually sit beside.
}

function createClockElement(entry: ClockEntry): HTMLElement {
    const template = dom.worldClockTemplate;
    const clone = template.content.cloneNode(true) as DocumentFragment;
    const clockDiv = clone.querySelector('.clock-row') as HTMLElement;

    // Zone ids contain hyphens (America/Port-au-Prince, Etc/GMT-5), so a
    // slugified id cannot be turned back into the zone. Carry it verbatim.
    // Ships use a "ship:R/ST" key, which exists only here in the DOM — it is
    // never stored and never handed to any timezone API.
    const key = clockKey(entry);
    clockDiv.dataset.clockKey = key;

    const isShip = entry.kind === 'ship';
    const tzid = entry.kind === 'zone' ? entry.tzid : null;

    clockDiv.classList.remove('border-transparent', 'border-blue-500', 'border-yellow-500');

    const isSelectedShip =
        entry.kind === 'ship' && shipKey(entry.ship) === state.selectedShipKey;

    if (tzid && tzid === state.gpsTzid && state.gpsTimezoneSelected) {
        clockDiv.classList.add('border-yellow-500');
    } else if (tzid && tzid === state.gpsTzid) {
        clockDiv.classList.add('border-blue-500');
    } else if (tzid && tzid === state.temporaryTimezone) {
        clockDiv.classList.add('border-yellow-500');
    } else if (isSelectedShip) {
        // Same gold as a selected zone: the row, the band and the marker are one
        // selection shown three ways, so they should not look like three states.
        clockDiv.classList.add('border-yellow-500');
    } else {
        clockDiv.classList.add('border-transparent');
    }

    const isTransient = !!tzid
        && tzid === state.temporaryTimezone
        && !state.addedTimezones.includes(tzid);

    if (isTransient) {
        clockDiv.classList.add('bg-yellow-800', 'bg-opacity-50');
    } else {
        clockDiv.classList.remove('bg-yellow-800', 'bg-opacity-50');
    }

    clone.querySelector('.city')!.textContent = clockLabel(entry);
    // When the row is named after a place rather than its zone ("Nelson"), name
    // the zone underneath so the mapping is visible ("Vancouver"). A ship has no
    // zone, so it names its line instead.
    clone.querySelector('.region')!.textContent = clockSubLabel(entry);
    if (isShip) clone.querySelector('.ship-icon')!.classList.remove('hidden');

    const removeBtn = clone.querySelector('.remove-btn') as HTMLElement;
    const pinBtn = clone.querySelector('.pin-btn') as HTMLElement;

    // A DIFFERENT attribute from the row's, deliberately: `data-clock-key`
    // identifies rows, and a row lookup that could also match one of its own
    // buttons breaks both the per-second clock update and the tap handler.
    removeBtn.dataset.clockTarget = key;
    pinBtn.dataset.clockTarget = key;

    // The ship you are currently aboard cannot be removed. Detection would put
    // it straight back on the next response, so the button would appear to do
    // nothing — and while aboard it is not really a choice, any more than your
    // own local time is. Step ashore and it becomes an ordinary removable row.
    const isAboard = entry.kind === 'ship' && shipKey(entry.ship) === state.aboardShipKey;

    // Only a zone can be transient — it is the map's unsaved selection. A ship
    // is saved the moment it is added, so it otherwise always offers removal.
    if (isTransient) {
        removeBtn.classList.add('hidden');
        pinBtn.classList.remove('hidden');
    } else {
        removeBtn.classList.toggle('hidden', isAboard);
        pinBtn.classList.add('hidden');
    }

    return clockDiv;
}