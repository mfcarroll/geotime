// src/map.ts

import * as dom from './dom';
import { state, persistTimezones } from './state';
import { fetchTimezoneForCoordinates, findTimezoneFromGeoJSON, startClocks, getTimezoneOffset, getFormattedTime, getUtcOffset, getDisplayTimezoneName, getValidTimezoneName, updateAllClocks } from './time';
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
  feature: google.maps.Data.Feature | null,
  valueType: 'offset' | 'time',
  forceTzid?: string
) {
  if (feature || forceTzid) {
    let tzid, zone;
    if (feature) {
      tzid = feature.getProperty('tz_name1st') as string | null;
      zone = feature.getProperty('zone') as number;
    } else {
      tzid = forceTzid!;
      zone = getUtcOffset(tzid);
    }
    
    const finalTz = forceTzid || getValidTimezoneName(tzid, zone);
    nameEl.textContent = getDisplayTimezoneName(finalTz);

    if (valueType === 'offset') {
      const referenceTz = state.gpsTzid || Intl.DateTimeFormat().resolvedOptions().timeZone;
      valueEl.textContent = getTimezoneOffset(finalTz, referenceTz);
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

function selectFeature(feature: google.maps.Data.Feature | null, tzidToSelect?: string) {
    let tzid, currentOffset, zone, newTzid;

    if (tzidToSelect) {
        currentOffset = getUtcOffset(tzidToSelect);
        newTzid = tzidToSelect;
    } else if (feature) {
        tzid = feature.getProperty('tz_name1st') as string | null;
        currentOffset = feature.getProperty('current_offset') as number;
        zone = feature.getProperty('zone') as number;
        newTzid = getValidTimezoneName(tzid, zone);
    } else {
        return;
    }

    if (state.gpsTzid && getUtcOffset(state.gpsTzid) === currentOffset) {
        newTzid = state.gpsTzid;
    }

    const isGpsTz = newTzid === state.gpsTzid;
    const isDeselecting = state.temporaryTimezone === newTzid;

    const nextGpsSelectedState = !isDeselecting && isGpsTz;
    if (state.gpsTimezoneSelected !== nextGpsSelectedState) {
        state.gpsTimezoneSelected = nextGpsSelectedState;
        document.dispatchEvent(new CustomEvent('gpstimezoneSelectionChanged', { detail: { selected: state.gpsTimezoneSelected } }));
    }

    if (isDeselecting) {
        state.selectedZone = null;
        state.temporaryTimezone = null;
    } else {
        state.selectedZone = currentOffset;
        state.temporaryTimezone = newTzid;
    }

    if (isDeselecting || state.gpsTimezoneSelected) {
        updateCard(dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl, dom.selectedTimezoneOffsetEl, null, 'offset');
    } else {
        updateCard(dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl, dom.selectedTimezoneOffsetEl, feature, 'offset', newTzid);
    }

    const existingTzWithOffset = state.addedTimezones.find((tz) => getUtcOffset(tz) === currentOffset);
    if (!isDeselecting && existingTzWithOffset && existingTzWithOffset !== newTzid) {
        document.dispatchEvent(new CustomEvent('replacetimezone', { detail: { tzid: newTzid } }));
    }

    if (isTouchDevice) state.hoveredZone = null;
    updateMapHighlights();
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
}

export function selectTimezone(tzid: string) {
    if (!state.geoJsonLoaded || !state.timezoneMap) return;

    const offset = getUtcOffset(tzid);
    let feature: google.maps.Data.Feature | null = null;
    
    state.timezoneMap.data.forEach((f: any) => {
        if (!feature && f.getProperty('current_offset') === offset) {
            feature = f as google.maps.Data.Feature;
        }
    });

    selectFeature(feature, tzid);
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
  updateMapHighlights();
  
  state.timezoneMap.data.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
    if (isTouchDevice) return;
    
    const feature = event.feature;
    const currentOffset = feature.getProperty('current_offset') as number;
    
    const tzidFromFeature = feature.getProperty('tz_name1st') as string | null;
    state.hoveredZone = currentOffset;
    state.hoveredTimezoneName = tzidFromFeature;
    updateMapHighlights();

    const zoneFromFeature = feature.getProperty('zone') as number;
    const validHoveredTzid = getValidTimezoneName(tzidFromFeature, zoneFromFeature);
    
    if (validHoveredTzid === state.gpsTzid || validHoveredTzid === state.temporaryTimezone) {
      updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset');
    } else {
      updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, feature, 'offset');
    }
  });
  
  document.getElementById('timezone-map')!.addEventListener('mouseleave', () => {
    if (isTouchDevice) return;
    state.hoveredZone = null;
    state.hoveredTimezoneName = null;
    updateMapHighlights();
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset');
  });
  
  state.timezoneMap.data.addListener('click', (event: google.maps.Data.MouseEvent) => {
    if (event.latLng) {
      console.log(`Map clicked at: Lat: ${event.latLng.lat()}, Lng: ${event.latLng.lng()}`);
    }

    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset');
    selectFeature(event.feature);
  });
}

export function updateMapHighlights() {
    if (!state.timezoneMap) return;
    state.timezoneMap.data.setStyle(feature => {
        const featureOffset = feature.getProperty('current_offset') as number;

        const styles = {
            default: { fillColor: 'transparent', strokeColor: 'rgba(255, 255, 255, 0.2)', strokeWeight: 1, zIndex: 1 },
            gps: { fillColor: 'rgba(63, 128, 255, 0.7)', strokeColor: 'transparent', strokeWeight: 1, zIndex: 1 },
            hover: { fillColor: 'rgba(255, 255, 255, 0.5)', strokeColor: 'transparent', strokeWeight: 1, zIndex: 2 },
            selected: { fillColor: 'rgba(255, 215, 0, 0.7)', strokeColor: 'transparent', strokeWeight: 1, zIndex: 3 },
        };

        let style = { ...styles.default };

        if (state.gpsTimezoneSelected && state.gpsZone === featureOffset) {
            style = { ...styles.selected };
        } else if (state.gpsZone === featureOffset) {
            style = { ...styles.gps };
        } else if (state.selectedZone === featureOffset) {
            style = { ...styles.selected };
        } else if (state.hoveredZone === featureOffset) {
            style = { ...styles.hover };
        }

        return style;
    });
}

async function loadTimezoneGeoJson() {
  if (state.geoJsonLoaded) return;
  try {
    const response = await fetch('timezones.geojson');
    const geoJson = await response.json();

    geoJson.features.forEach((feature: any) => {
        const tzid = feature.properties.tz_name1st;
        const zone = feature.properties.zone;
        const validTimezone = getValidTimezoneName(tzid, zone);
        feature.properties.current_offset = getUtcOffset(validTimezone);
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

      state.gpsZone = getUtcOffset(tzid);

      // The widget bases its pin/offsets on the GPS-derived local zone.
      syncWidgetTimezones(state.addedTimezones, state.localTimezone);

      updateMapHighlights();

      document.dispatchEvent(new CustomEvent('gpstimezonefound', { detail: { tzid } }));
    }
  }
}

export function addUniqueTimezoneToList(tz: string) {
    if (state.addedTimezones.includes(tz)) {
        return;
    }

    const newOffset = getUtcOffset(tz);

    if (state.gpsTzid && getUtcOffset(state.gpsTzid) === newOffset && tz !== state.gpsTzid) {
        return;
    }

    const next = state.addedTimezones.filter(existingTz => getUtcOffset(existingTz) !== newOffset);
    next.push(tz);

    persistTimezones(next);
    renderWorldClocks();
}

export function renderWorldClocks() {
    dom.worldClocksContainerEl.innerHTML = '';

    const timezonesToRender = [...state.addedTimezones];
    if (state.temporaryTimezone && !timezonesToRender.includes(state.temporaryTimezone)) {
        timezonesToRender.push(state.temporaryTimezone);
    }

    timezonesToRender
        .sort((a, b) => getUtcOffset(a) - getUtcOffset(b))
        .forEach((tz: string) => {
            const clockElement = createClockElement(tz);
            dom.worldClocksContainerEl.appendChild(clockElement);
        });
}

function createClockElement(tz: string): HTMLElement {
    const template = dom.worldClockTemplate;
    const clone = template.content.cloneNode(true) as DocumentFragment;
    const clockDiv = clone.querySelector('.grid') as HTMLElement;

    clockDiv.id = `clock-${tz.replace(/\//g, '-')}`;

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