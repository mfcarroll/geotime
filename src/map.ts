// src/map.ts

import * as dom from './dom';
import { aboardShip, state, persistTimezones, setLocalPlaceName, syncWidget } from './state';
import { timezoneForCoordinates, findTimezoneFromGeoJSON, startClocks, relativeTextForZone, relativeTextForShip, getFormattedTime, getUtcOffset, getDisplayTimezoneName, getZoneLabel, updateAllClocks, formatOffsetDiff } from './time';
import { locationMapStyles, worldTimezoneMapStyles } from './map-styles';
import { distance, formatAccuracy, fold } from './utils';
import { loadCityIndex, nearestPlace } from './cities';
import { resolveZoneStyle } from './map-highlight';
import { clockKey, clockLabel, clockSubLabel, formatFixedOffsetTime, visibleClocks, type ClockEntry } from './clocks';
import { shipKey, type ShipClock } from './ships';
import { voyageForShip, type ShipVoyage } from './shiptrack';
import { clearShipChart, drawShipChart, fitToShip, refreshShipMarkers } from './ship-markers';
import { voyageLine } from './voyage-line';

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
 * Two Map IDs, one style. They were meant to differ — the small map carrying
 * local roads the large one suppressed — and for a while they did; both now
 * point at the same cloud style. The second ID is kept so they can diverge
 * again without a code change, not because anything needs it today.
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
  valueType: 'offset' | 'time',
  /**
   * Which of the three slots this is.
   *
   * Only the selected slot changes colour with its contents. The hovered slot
   * is white whatever it holds, because white is not saying what the zone IS —
   * it is saying the pointer is over it, which the map echoes with a white
   * outline. Colouring it would break that pairing, and did: the first version
   * of this coloured every card the same way and turned hover gold.
   */
  role: 'selected' | 'hovered' = 'selected',
) {
  if (tzid) {
    nameEl.textContent = getDisplayTimezoneName(tzid);

    if (valueType === 'offset') {
      // Measured from the anchor, like every offset in the list below it — a map
      // that disagreed with the World Clock beneath it would be worse than
      // either answer on its own.
      valueEl.textContent = relativeTextForZone(tzid);
    }

    if (role === 'selected') {
      // Blue when the zone selected is the one you are standing in, gold
      // otherwise. The colour answers "what is this" rather than "how did it get
      // here", so it always agrees with the marks above the map.
      const isGround = tzid === state.gpsTzid;
      cardEl.classList.toggle('border-blue-500', isGround);
      cardEl.classList.toggle('border-yellow-500', !isGround);
    }

    cardEl.classList.remove('hidden');
  } else {
    cardEl.classList.add('hidden');
    nameEl.textContent = '';
    valueEl.textContent = '';
  }
}

/**
 * The left slot above the map: what you are living by.
 *
 * Ashore that is the ground, in blue, matching the GPS band under it. Aboard it
 * becomes the ship, in green, matching its own band — because the slot has
 * always meant "the clock everything else is measured from", and aboard that is
 * no longer the place you are standing. The ground does not disappear: it
 * becomes an ordinary zone on the map and an ordinary row in the list, with an
 * offset like any other, which is what the widget already does.
 */
let lastAnchorTzid: string | null = null;

/**
 * Repaint the anchor slot without needing to be told the zone again.
 *
 * Boarding moves the anchor, and the event that says so carries no timezone —
 * nor should it. Requiring one meant the slot silently kept its old colour
 * wherever the GPS zone had never resolved, which is every browser that has not
 * been granted location.
 */
export function refreshAnchorChip(): void {
    if (lastAnchorTzid) updateUserTimezoneDetails(lastAnchorTzid);
}

export function updateUserTimezoneDetails(tzid: string) {
    lastAnchorTzid = tzid;
    if (userTimeInterval) window.clearInterval(userTimeInterval);

    // Decided on every tick rather than once at paint time.
    //
    // Boarding is three separate events — the marker arrives, the ship is added,
    // its offset resolves — and this slot has to change on the last of them. An
    // event-driven repaint has to be subscribed to all three and has to be
    // listening before any of them fire, which on a fast connection it is not:
    // a same-origin HEAD to a nearby host can answer before the listeners are
    // even attached, and the slot then keeps the wrong colour indefinitely.
    // Re-reading once a second costs nothing and cannot miss a transition.
    const paint = () => {
        const ship = aboardShip();
        const aboard = ship !== null && ship.offsetHours !== null;

        dom.userTimezoneDetailsEl.classList.toggle('border-green-500', aboard);
        dom.userTimezoneDetailsEl.classList.toggle('border-blue-500', !aboard);
        dom.userTimezoneDetailsEl.classList.remove('hidden');

        if (aboard) {
            // The full name, not `short`. The slot is narrow and this wraps to
            // two lines because of it — which is the cheaper of the two costs.
            // A vessel's name is content; the row it sits in is layout.
            dom.userTimezoneNameEl.textContent = ship!.name;
            dom.userTimezoneTimeEl.textContent = formatFixedOffsetTime(
                ship!.offsetHours as number, { hour: 'numeric', minute: '2-digit' });
            setAnchorVoyageLine(shipKey(ship!));
            return;
        }

        setAnchorVoyageLine(null);

        // The map card names the zone; the Local Time card names the town you're in.
        dom.userTimezoneNameEl.textContent = getDisplayTimezoneName(tzid);
        dom.userTimezoneTimeEl.textContent = getFormattedTime(tzid, {
            hour: 'numeric',
            minute: '2-digit',
        });
    };

    paint();
    userTimeInterval = window.setInterval(paint, 1000);
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

    // Only a deselection empties this slot.
    //
    // It used to empty when the ground zone was picked, on the reasoning that
    // the card beside it already said the same thing. But the map paints the
    // picked zone yellow either way, and a yellow zone with no yellow card
    // breaks the pairing the colours exist to make. The two cards are also not
    // saying the same thing: the left one names the place you are standing and
    // gives its time, this one names the zone you clicked and measures it
    // against the anchor. Aboard they are not even close — the ground can be
    // hours off the ship.
    updateCard(
        dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl, dom.selectedTimezoneOffsetEl,
        isDeselecting ? null : newTzid,
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
    setShipVoyageLine(null, null);
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
        if (state.selectedShipKey === key) setShipVoyageLine(resolved, key);
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
        setShipVoyageLine(null, null);
        return;
    }
    // Cleared until the voyage arrives, so a previous ship's destination cannot
    // sit under a new ship's name.
    setShipVoyageLine(null, null);

    // The short name, not the full one. This card is a compact overlay, and
    // "Independence of the Seas" truncates to "Independence of the S…" in it —
    // where `short` was built for exactly this: the same name with the words
    // that distinguish nothing removed. Ambiguity is not a risk here, since the
    // user just picked this row.
    dom.selectedTimezoneNameEl.textContent = ship.name;
    if (ship.offsetHours === null) {
        // The same wording the clock row uses, for the same reason: no offset
        // means nothing sensible to show, and the embark port's zone is the
        // obvious wrong answer.
        dom.selectedTimezoneOffsetEl.textContent = 'Finding ship time…';
    } else if (aboardShip() && shipKey(aboardShip()!) === shipKey(ship)) {
        // The ship you are ON, picked deliberately. "Ship time" is a list-row
        // label — it earns its place there because the list has no colour to
        // mark the reference — and in a card that is already green-and-leftmost
        // it says nothing while occupying the one line that could. An offset
        // would be worse still: measured from itself, always +0.
        dom.selectedTimezoneOffsetEl.textContent = formatFixedOffsetTime(
            ship.offsetHours, { hour: 'numeric', minute: '2-digit' });
    } else {
        dom.selectedTimezoneOffsetEl.textContent =
            relativeTextForShip(ship as { brand: string; code: string; offsetHours: number });
    }
    dom.selectedTimezoneDetailsEl.classList.remove('hidden');
}

/**
 * The third line of the card: where she is, or where she is going.
 *
 * The reasoning lives in voyage-line.ts, which has to read the fleet fix and two
 * clocks to decide between them. This end only paints the result and hides the
 * line when there is nothing to say.
 */
function setShipVoyageLine(voyage: ShipVoyage | null, key: string | null): void {
    // Suppressed when this ship is also the anchor, because the green card is
    // already showing the same line for the same vessel and two copies of one
    // ETA side by side is noise, not emphasis. A DIFFERENT ship selected while
    // aboard keeps its line: two destinations are two facts.
    const aboard = aboardShip();
    const duplicate = key !== null && aboard !== null && shipKey(aboard) === key;
    const line = duplicate ? '' : voyageLine(voyage, key);
    dom.selectedShipVoyageEl.textContent = line;
    dom.selectedShipVoyageEl.classList.toggle('hidden', line === '');
}

/**
 * The anchor card's third line, while aboard.
 *
 * Fetched on the key changing rather than on every repaint: the slot repaints
 * once a second by design, and a voyage is a per-voyage fact. voyageForShip
 * caches, but asking it sixty times a minute would still churn a promise for
 * nothing.
 */
let anchorVoyageKey: string | null = null;

function setAnchorVoyageLine(key: string | null): void {
    if (key === anchorVoyageKey) return;
    anchorVoyageKey = key;

    dom.userShipVoyageEl.textContent = '';
    dom.userShipVoyageEl.classList.add('hidden');
    if (!key) return;

    void voyageForShip(key).then((resolved) => {
        // The anchor may have moved on while this was in flight — stepping
        // ashore, or boarding another vessel.
        if (anchorVoyageKey !== key) return;
        const line = voyageLine(resolved, key);
        dom.userShipVoyageEl.textContent = line;
        dom.userShipVoyageEl.classList.toggle('hidden', line === '');
    }).catch(() => {});
}

/**
 * The blue GPS dot, as an element rather than a Symbol path.
 *
 * AdvancedMarkerElement anchors its content by the bottom centre, so the dot is
 * nudged down half its own height to sit ON the coordinate rather than above it.
 * That offset is the one thing a Symbol did for free and an element does not.
 */
function blueDot(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'gps-dot';
  el.innerHTML =
    '<svg viewBox="-10 -10 20 20" width="20" height="20">' +
    '<circle r="5" fill="#4285F4" stroke="#FFFFFF" stroke-width="2"/></svg>';
  return el;
}

/**
 * AdvancedMarkerElement has no setVisible. Detaching from the map would work but
 * costs a re-add; hiding the content leaves the marker in place, which is what
 * this is for — a dot with no fix yet, not a dot that has gone away.
 */
function setMarkerVisible(marker: google.maps.marker.AdvancedMarkerElement, visible: boolean): void {
  const content = marker.content as HTMLElement | null;
  if (content) content.style.visibility = visible ? 'visible' : 'hidden';
}

/**
 * A crosshair that recentres the map on the last known position.
 *
 * The glyph is inline SVG rather than an <img src>. As a file it was one more
 * request that could fail — and did, showing a broken-image icon — for a 500-byte
 * shape that never changes. Inline it cannot 404, it inherits currentColor, and
 * it stays sharp at any density.
 *
 * The button is 44x44 with a transparent frame around a smaller visible face.
 * That is Apple's minimum touch target and this control had been 30, hard
 * against the map edge. Undersizing it was not a quiet failure either: a near
 * miss falls through to the zone layer underneath, so tapping at the compass and
 * slightly missing SELECTS A TIMEZONE — the map appears to ignore the button and
 * do something random instead. Whatever hit area this ends up with, it must stay
 * larger than the face it draws.
 */
function createMyLocationButton(map: google.maps.Map) {
    const controlButton = document.createElement('button');
    controlButton.type = 'button';
    controlButton.className = 'map-recentre';
    controlButton.title = 'Recentre the map on your location';
    controlButton.setAttribute('aria-label', 'Recentre the map on your location');
    controlButton.innerHTML = `
      <span class="map-recentre-face" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <circle cx="12" cy="12" r="4"/>
          <path d="M13 4.069V2h-2v2.069A8.01 8.01 0 0 0 4.069 11H2v2h2.069A8.008 8.008 0 0 0 11 19.931V22h2v-2.069A8.007 8.007 0 0 0 19.931 13H22v-2h-2.069A8.008 8.008 0 0 0 13 4.069zM12 18c-3.309 0-6-2.691-6-6s2.691-6 6-6 6 2.691 6 6-2.691 6-6 6z"/>
        </svg>
      </span>`;
    map.controls[google.maps.ControlPosition.TOP_RIGHT].push(controlButton);

    controlButton.addEventListener('click', (event) => {
        // The zone layer is listening on the map underneath. A click that lands
        // on the button is not also a click on the world.
        event.stopPropagation();
        if (state.lastFetchedCoords) {
            map.setCenter({ lat: state.lastFetchedCoords.lat, lng: state.lastFetchedCoords.lon });
        }
    });
}

/**
 * Two maps is one too many on a phone.
 *
 * The location map is a small high-zoom view of the streets around a blue dot.
 * On a wide layout it sits beside the world map and costs nothing; in a single
 * column it sits *above* the World Clock list and pushes it a screen further
 * down, so the price of it is a scroll past a map you were not looking at.
 *
 * Width alone cannot express that, which a first attempt at a single min-width
 * got wrong: an iPhone 17 in landscape is 874pt wide and an 11" iPad upright is
 * 834pt, so the phone to exclude is wider than the tablet to keep. Height is
 * what separates them, and it is the real criterion rather than a proxy — a
 * phone on its side has 402pt of height and is the worst case for burying the
 * list, not an exception to it.
 *
 * The query below must stay in step with .two-map-only in style.css, which owns
 * the visibility and carries the full reasoning for both of its clauses.
 *
 * When it does not match the map is not merely hidden, it is never constructed —
 * which spares the device least able to afford it a second vector map, its
 * WebGL context and its tile traffic. Everything that touches state.locationMap
 * is already null-guarded, so absence is an ordinary state rather than a
 * special case.
 */
const TWO_MAP_LAYOUT = window.matchMedia(
  '(min-width: 700px) and (min-height: 600px), (min-width: 1024px)'
);

function createLocationMap(): void {
  if (state.locationMap) return;
  const el = document.getElementById('location-map');
  if (!el) return;

  state.locationMap = new google.maps.Map(el, {
    center: { lat: 0, lng: 0 },
    zoom: 2,
    disableDefaultUI: true,
    zoomControl: false,
    ...renderingOptions(LOCATION_MAP_ID, locationMapStyles),
  });
  createMyLocationButton(state.locationMap);

  state.locationMarker = new google.maps.marker.AdvancedMarkerElement({
    map: state.locationMap,
    position: { lat: 0, lng: 0 },
    content: blueDot(),
  });
  setMarkerVisible(state.locationMarker, false);

  state.accuracyCircle = new google.maps.Circle({
    map: state.locationMap,
    radius: 0,
    fillColor: '#4285F4',
    fillOpacity: 0.2,
    strokeColor: '#4285F4',
    strokeOpacity: 0.5,
    strokeWeight: 1,
    center: { lat: 0, lng: 0 },
  });

  // Built late, on a resize, this map has missed every fix so far — and
  // updateLocationMap only frames the view on the first one, so left alone it
  // would sit at zoom 2 over the Atlantic with a marker somewhere off-screen.
  // The accuracy radius is not recoverable here (only the position is kept), so
  // the circle stays empty and a plain street zoom stands in until the next fix
  // arrives and sizes it properly.
  const fix = state.lastFetchedCoords;
  if (fix) {
    const pos = { lat: fix.lat, lng: fix.lon };
    state.locationMarker.position = pos;
    setMarkerVisible(state.locationMarker, true);
    state.locationMap.setCenter(pos);
    state.locationMap.setZoom(14);
  }
}

export async function initMaps() {
  const { Map } = await google.maps.importLibrary("maps") as google.maps.MapsLibrary;
  // Imported for its side effect: AdvancedMarkerElement is reached through the
  // google.maps.marker namespace below, which the library populates.
  await google.maps.importLibrary("marker");

  const timezoneMapOptions: google.maps.MapOptions = {
    center: { lat: 0, lng: 0 },
    zoom: 2,
    disableDefaultUI: true,
    zoomControl: false,
    ...renderingOptions(TIMEZONE_MAP_ID, worldTimezoneMapStyles),
  };

  if (TWO_MAP_LAYOUT.matches) createLocationMap();
  // A window being widened, or a phone turned on its side, should get the map it
  // did not have. Not removed again on the way back: once it exists the CSS
  // hides it, and tearing a map down to save a hidden container is not worth the
  // teardown path it would need.
  TWO_MAP_LAYOUT.addEventListener('change', () => {
    if (TWO_MAP_LAYOUT.matches) createLocationMap();
  });

  const timezoneMapEl = document.getElementById('timezone-map') as HTMLElement;
  state.timezoneMap = new Map(timezoneMapEl, timezoneMapOptions);
  createMyLocationButton(state.timezoneMap);
  const timezoneDot = new google.maps.marker.AdvancedMarkerElement({
    map: state.timezoneMap,
    position: { lat: 0, lng: 0 },
    content: blueDot(),
  });
  setMarkerVisible(timezoneDot, false);
  state.timezoneMapMarker = timezoneDot;

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
      'offset',
      'hovered'
    );
  });

  document.getElementById('timezone-map')!.addEventListener('mouseleave', () => {
    if (isTouchDevice) return;
    setHoveredZone(null);
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset', 'hovered');
  });

  state.timezoneMap.data.addListener('click', (event: google.maps.Data.MouseEvent) => {
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl, dom.hoveredTimezoneOffsetEl, null, 'offset', 'hovered');
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

    // Green paints the clock we are keeping, which is only a ship's when a

    // marker says so. aboardShip() is null every other moment.

    anchorShipOffset: aboardShip()?.offsetHours ?? null,
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

        state.locationMarker.position = pos;
        setMarkerVisible(state.locationMarker, true);
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
    state.timezoneMapMarker.position = pos;
    setMarkerVisible(state.timezoneMapMarker, true);
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
  // A network fix can land on the other side of the world from the hull it was
  // taken aboard, so ship detection must never see one. Same test, one answer,
  // used for both the icon and that guard — see isUsableFix.
  const sensorFix = altitude !== null || speed !== null || heading !== null;
  state.deviceFix = { lat: latitude, lon: longitude, accuracy, sensor: sensorFix };
  document.dispatchEvent(new CustomEvent('devicefixchanged'));

  if (accuracy <= 15 && sensorFix) {
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
      state.locationMarker.position = { lat: latitude, lng: longitude };
    }
    if (state.timezoneMapMarker) {
      state.timezoneMapMarker.position = { lat: latitude, lng: longitude };
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

    // Split so the ship mark cannot wrap away from the name it belongs to.
    // Everything up to and including the final space goes in the wrapping part;
    // the last word joins the mark in a nowrap group. See index.html.
    const label = clockLabel(entry);
    const lastSpace = label.lastIndexOf(' ');
    clone.querySelector('.city')!.textContent = lastSpace === -1 ? '' : label.slice(0, lastSpace + 1);
    clone.querySelector('.city-last')!.textContent =
        lastSpace === -1 ? label : label.slice(lastSpace + 1);
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