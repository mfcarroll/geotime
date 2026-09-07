// src/map.ts

import * as dom from './dom';
import { aboardShip, addSavedZone, state, persistZones, savedZoneByKey, setLocalPlaceName, syncWidget, whenMapReady } from './state';
import { timezoneForCoordinates, findTimezoneFromGeoJSON, mapSelection, zoneForCoordinates, startClocks, relativeTextForZone, relativeTextForShip, getFormattedTime, getUtcOffset, getDisplayTimezoneName, updateAllClocks, formatOffsetDiff } from './time';
import { locationMapStyles, worldTimezoneMapStyles } from './map-styles';
import { debugFlag, distance, formatAccuracy, fold } from './utils';
import { loadCityIndex, nearestPlace } from './cities';
import { feature as topoFeature } from 'topojson-client';
import { resolveZoneStyle } from './map-highlight';
import { flyTo, flyToBox } from './map-fly';
import { clockKey, clockLabel, clockSubLabel, formatFixedOffsetTime, visibleClocks, type ClockEntry } from './clocks';
import { shipKey, type ShipClock } from './ships';
import { cachedVoyageFor, voyageForShip, type ShipPort, type ShipVoyage } from './shiptrack';
import { clearShipChart, drawShipChart, fitToShip, refreshPlaceMarkers, refreshShipMarkers, type PlaceMarkerDetail } from './ship-markers';
import { voyageLine } from './voyage-line';
import { isUnlocatedZone } from './ports';
import { zoneKey, type StoredZone } from './stored-zones';
import { fontOf, widthOf } from './second-line';

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
  // Fractional zoom is native to vector and off by default on raster, where
  // without it a flight would climb in whole zoom levels — a staircase where
  // the vector map has a curve.
  if (!mapId) return { styles: fallbackStyles, isFractionalZoomEnabled: true };
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

/**
 * Writes a card's value line, monospaced only when it holds a clock reading.
 *
 * A time wants tabular figures so the digits stop shuffling as the minute
 * changes — the anchor card has had them all along, and a ship's time in the
 * selected slot is the same kind of thing. An offset is prose: "Local time",
 * "−1 hr". Setting it in the clock face would be borrowing the wrong voice.
 */
function setCardValue(el: HTMLElement, text: string, mono: boolean): void {
  el.textContent = text;
  el.classList.toggle('font-mono', mono);
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
  /** What the thing was called when it was picked, if it had a name of its own. */
  name?: string,
) {
  if (tzid) {
    // The name the user gave it, where they gave it one. Picking "Cozumel" out
    // of the search or off the map and being answered "Cancun" is the zone
    // being pedantic at somebody who was not asking about the zone — and the
    // row below already says Cozumel, so the card was contradicting the list.
    nameEl.textContent = name ?? getDisplayTimezoneName(tzid);

    if (valueType === 'offset') {
      // Measured from the anchor, like every offset in the list below it — a map
      // that disagreed with the World Clock beneath it would be worse than
      // either answer on its own.
      setCardValue(valueEl, relativeTextForZone(tzid), false);
    }

    // The selected slot is gold, always — including when the zone picked is the
    // one you are standing in.
    //
    // It used to go blue in that case, which contradicted both the map and the
    // list: resolveZoneStyle tests `tzid === selectedTzid` FIRST, so the zone
    // under your feet turns gold the moment you pick it, and only the band
    // around it stays blue. Blue is where you are; gold is what you chose; a
    // zone can be both and the choice is what this slot reports.
    //
    // The rule was never seen until now because the card was hidden in exactly
    // the case that triggered it — selecting the GPS zone set
    // gpsTimezoneSelected, which emptied this slot. Unfolding the slot exposed
    // a branch that had never rendered.

    cardEl.classList.remove('hidden');
  } else {
    cardEl.classList.add('hidden');
    nameEl.textContent = '';
    setCardValue(valueEl, '', false);
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

        // The selected slot can now hold a clock reading too, and a reading has
        // to keep up with the minute. Painting it only on selection was enough
        // while it held an offset: that moves when a ship's clock is re-resolved,
        // not as time passes.
        refreshSelectedShipTime();
        refreshHoveredShipTime();
        applyShipReserve();
        syncAboardChart();

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
/**
 * Selects one place: its zone on the map, and the place itself in the card.
 *
 * Takes the whole record rather than a zone id, and that is not tidiness. The
 * transient row and the card are both written here, and the re-render is
 * dispatched from the bottom of this function — so a caller that set the record
 * AFTERWARDS had its correction land after the list had already been drawn.
 * Picking Tampa lit the New York row, on a device, exactly once.
 */
function selectZone(picked: StoredZone | null) {
    if (!picked) return;
    const newTzid = picked.tz;

    // One gold band, one "selected" card: picking a zone drops any ship, and
    // any port — a port is a point inside a zone, so a zone selection is a
    // strictly coarser answer to the same question.
    state.selectedShipKey = null;
    state.selectedPlace = null;

    const isGpsTz = newTzid === state.gpsTzid;
    // By PLACE: clicking the zone under Tampa is not clicking Tampa, so it does
    // not toggle her off.
    const isDeselecting = !!state.temporaryZone
        && zoneKey(state.temporaryZone) === zoneKey(picked);

    const nextGpsSelectedState = !isDeselecting && isGpsTz;
    if (state.gpsTimezoneSelected !== nextGpsSelectedState) {
        state.gpsTimezoneSelected = nextGpsSelectedState;
        document.dispatchEvent(new CustomEvent('gpstimezoneSelectionChanged', { detail: { selected: state.gpsTimezoneSelected } }));
    }

    if (isDeselecting) {
        state.selectedTzid = null;
        state.temporaryZone = null;
    } else {
        state.selectedTzid = newTzid;
        state.temporaryZone = picked;
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
        'offset',
        'selected',
        // The row's own name, so picking Tampa does not answer "New York".
        picked.label,
    );

    if (isTouchDevice) setHoveredZone(null);
    refreshMapStyles();
    // The ship selection was just cleared above; its marker has to stop looking
    // selected and its chart has to go, or the map shows two answers at once.
    refreshShipMarkers();
    resetShipChart();
    // Cleared, not just hidden: leaving one ship's ETA in a hidden element is a
    // trap for whoever next changes when this line is shown.
    setShipVoyageLine(null, null);
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
}

/**
 * Where to put the map when something is picked, or nothing to leave it alone.
 *
 * A coordinate frames that point; 'zone' frames the whole region. The
 * difference matters: somebody who types "Nelson" wants Nelson, and somebody
 * who types "America/Vancouver" wants the shape that name refers to.
 */
export type Frame = { lat: number; lon: number } | 'zone';

export function selectTimezone(tzid: string, frame?: Frame) {
    selectSavedZone({ tz: tzid }, frame);
}

/**
 * Selects one saved place: its zone on the map, and the place itself where it
 * is one.
 *
 * A row for Tampa or for Cozumel names a POINT, not the region around it, so it
 * selects the same way its marker does — including finding the cruise that
 * calls there, where one does. A row with no coordinates is a region and can
 * only be answered with one: an ordinary zone, or a place kept by a build that
 * did not record where it was.
 */
export function selectSavedZone(zone: StoredZone, frame?: Frame) {
    // Any row we hold a POINT for selects that point, port or town — the same
    // thing its marker does. A row with no coordinates is a region and can only
    // be answered with one — and, since migrateStoredTimezones drops a name it
    // has no position for, it is one: the row reads as the zone it selects.
    if (zone.at) {
        selectPlace(
            {
                name: zone.label ?? zone.tz,
                lat: zone.at.lat,
                lon: zone.at.lon,
                detail: '',
                kind: zone.kind,
            },
            frame !== undefined);
        return;
    }
    selectZone(zone);
    if (frame === 'zone') frameZone(zone.tz);
    else if (frame) frameAt(frame.lat, frame.lon);
}

/** Centres on a point, coming closer if the map was further out than PLACE_ZOOM. */
function frameAt(lat: number, lon: number): void {
    whenMapReady((map) => {
        flyTo(map, { lat, lng: lon, zoom: Math.max(map.getZoom() ?? 0, PLACE_ZOOM) });
    });
}

/**
 * Fits the map to a zone's own shape.
 *
 * Walked from the Data layer rather than the raw GeoJSON, so a zone drawn as
 * several features — most of them are — is framed as the one place it is. An
 * enormous zone honestly zooms out, and a nautical band that runs pole to pole
 * honestly zooms all the way out: the answer to "where is Etc/GMT+5" really is
 * "a stripe down the whole map".
 *
 * LatLngBounds.extend grows the shorter way round, which is what keeps Alaska
 * from being framed as the entire Pacific because the Aleutians cross 180.
 */
function frameZone(tzid: string): void {
    whenMapReady((map) => {
        const bounds = new google.maps.LatLngBounds();
        let framed = false;
        map.data.forEach((feature) => {
            if (feature.getProperty('tzid') !== tzid) return;
            feature.getGeometry()?.forEachLatLng((latLng) => {
                bounds.extend(latLng);
                framed = true;
            });
        });
        if (framed) flyToBox(map, bounds, 48);
    });
}

/**
 * Selects a ship, or toggles it off if it is already THE selection.
 *
 * Which is not the same as being on screen: a port of hers may be selected, in
 * which case her route is drawn but the port is what is picked, and tapping the
 * vessel promotes her rather than dismissing the cruise.
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
    // A ship is only the selection when nothing stands in front of it. Picking
    // one of her ports puts the cruise on screen and leaves selectedShipKey set
    // — the PORT is what is selected there, so reading the key alone made the
    // ship's own tap deselect a ship the user had never selected, dropping the
    // route instead of promoting the vessel.
    const isDeselecting = state.selectedShipKey === key && !state.selectedPlace;
    // Picking the vessel is a coarser answer than picking one of her calls.
    state.selectedPlace = null;

    state.selectedShipKey = isDeselecting ? null : key;
    // A ship and a zone cannot both be selected; clear the zone side, including
    // the transient map pick, so the list does not keep showing a stray row.
    if (!isDeselecting) {
        state.selectedTzid = null;
        state.temporaryZone = null;
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
    refreshPlaceMarkers();
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));

    if (isDeselecting) {
        resetShipChart();
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

/** The chart currently drawn on the aboard ship's behalf, if any. */
let aboardChartKey: string | null = null;

/**
 * Keeps the ship you are ON drawn on the map whether or not she is selected.
 *
 * The chart used to be a response to a selection and nothing else, so aboard you
 * saw your own route only while you happened to have your own ship picked. Your
 * itinerary is not a thing you look up while aboard — it is the shape of the
 * week — so it stays.
 *
 * A selection still wins the canvas. There is one chart, and drawing two would
 * put two routes over each other; the selected one is the question just asked,
 * and deselecting brings the aboard one straight back.
 */
function syncAboardChart(): void {
    // Nothing to draw on yet. Returning BEFORE the latch matters: drawShipChart
    // gives up silently without a map, and latching first would record a chart
    // that was never drawn and then refuse to draw it once the map arrived.
    // Same shape as the voyage-line bug — a failure recorded as a success.
    if (!state.timezoneMap) return;

    const key = state.selectedShipKey ? null : state.aboardShipKey;
    if (key === aboardChartKey) return;
    aboardChartKey = key;
    // No fitToShip here: the chart appearing must never move the map under
    // someone who did not ask for it.
    if (key) void drawShipChart(key, voyageForShip(key));
}

/** Tears the chart down and lets the aboard ship's own reclaim the canvas. */
function resetShipChart(): void {
    clearShipChart();
    aboardChartKey = null;
    syncAboardChart();
}

/**
 * The value line for a ship, wherever it is shown.
 *
 * The ship underfoot reads as a TIME; every other reads as a distance from the
 * anchor. Shared by the selected and hovered cards so the two cannot drift into
 * saying the same fact two different ways.
 *
 * The time is there in place of "Ship time", which is a list-ROW label: it earns
 * its place in the list because the list has no colour to mark which clock is
 * the reference, and in a card that is already green-and-leftmost it says
 * nothing while occupying the one line that could say something. An offset would
 * be worse still — measured from itself, always +0.
 */
function shipCardValue(ship: ShipClock): { text: string; mono: boolean } {
    // The same wording the clock row uses, for the same reason: no offset means
    // nothing sensible to show, and the embark port's zone is the obvious wrong
    // answer.
    if (ship.offsetHours === null) return { text: 'Finding ship time…', mono: false };

    const aboard = aboardShip();
    if (aboard && shipKey(aboard) === shipKey(ship)) {
        return {
            text: formatFixedOffsetTime(ship.offsetHours, { hour: 'numeric', minute: '2-digit' }),
            mono: true,
        };
    }
    return {
        text: relativeTextForShip(ship as { brand: string; code: string; offsetHours: number }),
        mono: false,
    };
}

/** The zone under the pointer, remembered even while a hull is over the top of it. */
let hoveredZoneTzid: string | null = null;

/** The port of call under the pointer, with the zone it keeps time by. */
let hoveredPlace: { detail: PlaceMarkerDetail; tzid: string } | null = null;

/**
 * Repaints the white card from both hover sources, ship first.
 *
 * The two used to write to it independently and fought for it. A hull sits ON a
 * zone, so crossing onto one fires enter for the marker AND keeps firing
 * mouseover for the region underneath — which overwrote the ship with the zone
 * while the pointer had not moved off the ship at all. Leaving a hull then
 * cleared the card outright rather than falling back to the region it is
 * standing on.
 *
 * Both are remembered; this decides. The ship wins because it is the smaller,
 * more specific target, and the one you had to aim at.
 */
function paintHoverCard(): void {
    // A port outranks both. It is the smallest target on the map, it sits on a
    // zone and often within a hull's width of the ship calling there, and it is
    // the one you had to aim at.
    if (hoveredPlace) {
        dom.hoveredTimezoneNameEl.textContent = hoveredPlace.detail.name;
        setCardValue(dom.hoveredTimezoneOffsetEl, relativeTextForZone(hoveredPlace.tzid), false);
        // The line a hovered ship uses for her destination carries the call's
        // own particulars here — "day 2 · departs 17:00" — which is the rest of
        // what the itinerary knows and has never had anywhere to be said.
        setVoyageLine(dom.hoveredShipVoyageEl, hoveredPlace.detail.detail);
        dom.hoveredTimezoneDetailsEl.classList.remove('hidden');
        return;
    }

    if (state.hoveredShipKey) {
        const ship = state.shipClocks.find((sc) => shipKey(sc) === state.hoveredShipKey);
        if (ship) {
            dom.hoveredTimezoneNameEl.textContent = ship.name;
            const value = shipCardValue(ship);
            setCardValue(dom.hoveredTimezoneOffsetEl, value.text, value.mono);
            dom.hoveredTimezoneDetailsEl.classList.remove('hidden');
            return;
        }
    }

    setVoyageLine(dom.hoveredShipVoyageEl, '');
    updateCard(dom.hoveredTimezoneDetailsEl, dom.hoveredTimezoneNameEl,
               dom.hoveredTimezoneOffsetEl, hoveredZoneTzid, 'offset', 'hovered');
}

/**
 * Puts a port of call in the white card, or takes it out again.
 *
 * A port resolving to a nautical band has not been located — its coordinates
 * landed offshore, which is common for a tender anchorage — and a fixed offset
 * is a plausible-looking wrong answer, right in winter and an hour out all
 * summer wherever the shore keeps DST. The search already refuses those; so
 * does this, and so does the tap below. The ring stays on the map with its
 * tooltip, which is all we can honestly say about it.
 */
export function setHoveredPlace(detail: PlaceMarkerDetail | null): void {
    const tzid = detail ? findTimezoneFromGeoJSON(detail.lat, detail.lon) : null;
    hoveredPlace = detail && tzid && !isUnlocatedZone(tzid) ? { detail, tzid } : null;
    paintHoverCard();
}

/**
 * Selects the zone a port of call stands in, under the port's own name.
 *
 * The same act as tapping the region it sits in, which is what makes it
 * unsurprising: one gold band, one card, and the temporary row below with its
 * pin to keep it. What the port adds is the NAME — "Cozumel" rather than
 * "Cancun" — and the anchor beside it, exactly as picking it out of the search
 * would, so a place reached two ways is stored one way.
 */
export function selectPlace(detail: PlaceMarkerDetail, reveal = false): void {
    const tzid = zoneForCoordinates(detail.lat, detail.lon);
    if (!tzid || isUnlocatedZone(tzid)) return;

    const already = state.selectedPlace;
    const deselecting = !!already
        && already.tzid === tzid
        && Math.abs(already.lat - detail.lat) < 1e-6
        && Math.abs(already.lon - detail.lon) < 1e-6;

    hoveredPlace = null;
    hoveredZoneTzid = null;

    if (deselecting) {
        state.selectedPlace = null;
        state.temporaryZone = null;
        // The cruise goes with it. A port and the itinerary it belongs to are
        // ONE selection: picking the port is what put the route on screen, so
        // unpicking it is what takes the route off again.
        //
        // Which leaves the map to the anchor's own route, where there is one —
        // resetShipChart hands it straight back, because a ship underfoot was
        // never a selection to begin with.
        state.selectedShipKey = null;
        updateShipCard(null);
        resetShipChart();
        paintHoverCard();
        refreshMapStyles();
        // The hulls too: a ship keeping the selected time wears the band's
        // colour, so dropping the selection has to give it back.
        refreshShipMarkers();
        refreshPlaceMarkers();
        renderWorldClocks();
        document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
        return;
    }

    state.selectedPlace = { tzid, name: detail.name, lat: detail.lat, lon: detail.lon };
    // Dropped like every other selection drops it. Left standing, the ground
    // zone kept its gold while a place elsewhere took the card — which is how
    // Nelson, Vancouver and Calgary came to be picked all at once.
    if (state.gpsTimezoneSelected) {
        state.gpsTimezoneSelected = false;
        document.dispatchEvent(
            new CustomEvent('gpstimezoneSelectionChanged', { detail: { selected: false } }));
    }
    // A row of its own so it can be kept, and the pin beside it to keep it
    // with. The row carries the port's name, its anchor and its position — it
    // does not WRITE them onto the zone, which is how a look at Cabo San Lucas
    // used to rename the timezone it stands in, on every surface, permanently.
    //
    // And NOT `selectedTzid`, which is what paints a whole zone gold. The zone
    // is not the place: lighting America/Cancun because somebody tapped Cozumel
    // answers a question they did not ask.
    state.temporaryZone = {
        tz: tzid,
        label: detail.name,
        // What it IS, carried from the marker. Hardcoding 'port' here was fine
        // while ports were the only thing on the map you could point at; it
        // would now put an anchor beside Tampa.
        ...(detail.kind === 'port' ? { kind: 'port' as const } : {}),
        at: { lat: detail.lat, lon: detail.lon },
    };
    // A PORT is the one place that keeps a ship. It belongs to an itinerary, so
    // picking one is a request to see that cruise rather than to dismiss it —
    // and if none is showing, framedCruiseFor finds the one that calls here.
    //
    // A city belongs to nobody's itinerary and drops the cruise exactly as a
    // zone does. Left standing, a ship outlived every selection that followed
    // her: going Calgary, then Coco Cay looked like the PORT choosing a vessel,
    // and which vessel it chose depended on what had been selected minutes
    // before. Aboard, none of this reaches the ship underfoot — she is drawn
    // because she is the anchor, and being aboard is its own disambiguation.
    if (detail.kind !== 'port' && state.selectedShipKey) {
        state.selectedShipKey = null;
        resetShipChart();
    }
    const framed = framedCruiseFor(detail);

    // Reached from the search box rather than from the map, the map is wherever
    // it was — usually the whole world, where a ring four pixels across says
    // nothing. Picking a place there is a request to be shown it. Tapping its
    // ring is not: the map is already where you were looking, and moving it
    // under you would be the surprise.
    if (reveal && !framed) frameAt(detail.lat, detail.lon);

    updateCard(dom.selectedTimezoneDetailsEl, dom.selectedTimezoneNameEl,
               dom.selectedTimezoneOffsetEl, tzid, 'offset', 'selected', detail.name);
    setVoyageLine(dom.selectedShipVoyageEl, detail.detail);
    paintHoverCard();
    refreshMapStyles();
    refreshShipMarkers();
    refreshPlaceMarkers();
    renderWorldClocks();
    document.dispatchEvent(new CustomEvent('temporarytimezonechanged'));
}

/**
 * Close enough to see a place and the coast or country it sits on.
 *
 * Never zooms OUT: someone who was already looking at one island does not want
 * the map pulled back to a region because they searched for the place they were
 * already standing on.
 */
const PLACE_ZOOM = 6;

/**
 * How near a fix has to be to count as the same port. Generous, because several
 * calls are tender berths marked at the anchorage rather than at a pier.
 */
const SAME_PORT_KM = 25;

/**
 * Brings up the cruise a port belongs to, when there is exactly one.
 *
 * The point of tapping a port is usually the voyage behind it — "who calls
 * here, and when" — so leaving the map blank and the card alone would be
 * answering half the question. But only when the answer is unambiguous: two
 * ships calling at Cozumel this week is the common case in the Caribbean, and
 * picking one of them would be inventing a preference the user did not express.
 *
 * Aboard is the exception, and it outranks the count. The ship underfoot is the
 * one whose itinerary a passenger means, whoever else happens to call there.
 *
 * Returns whether THIS CALL framed the map, which is a narrower thing than
 * whether a cruise is up: only the branch that fits to an itinerary claims the
 * viewport. Everything else leaves the place free to frame itself.
 */
function framedCruiseFor(detail: PlaceMarkerDetail): boolean {
    // A cruise on screen is not a map that has been MOVED. Saying "framed" here
    // is what stopped a city from framing itself once any port had been tapped:
    // the port selected a cruise, selectedShipKey stayed set for the rest of the
    // session, and every later place was told its viewport had been dealt with.
    if (state.selectedShipKey) return false;

    const calling = state.shipClocks
        .map((ship) => shipKey(ship))
        .filter((key) => {
            const voyage = cachedVoyageFor(key);
            return !!voyage?.ports.some((p: ShipPort) =>
                distance(p.lat, p.lon, detail.lat, detail.lon) <= SAME_PORT_KM);
        });

    // Drawn already, as the anchor always is — so, again, nothing has moved.
    const aboard = state.aboardShipKey;
    if (aboard && calling.includes(aboard)) return false;
    if (calling.length !== 1) return false;

    const key = calling[0];
    state.selectedShipKey = key;
    refreshShipMarkers();
    void drawShipChart(key, voyageForShip(key));
    // The one branch that does own the viewport: the whole itinerary is a
    // better answer than the single point on it that was picked.
    void fitToShip(key, voyageForShip(key));
    return true;
}

/**
 * Puts a ship in the white card.
 *
 * Hover reached only zones before, which left the hulls — the one thing on this
 * map you can point at that is not a region — silently unexplained.
 */
export function setHoveredShip(key: string | null): void {
    if (key === state.hoveredShipKey) return;
    state.hoveredShipKey = key;

    // The hull itself changes, the way a zone's outline does — pointing at
    // something should show that it has been pointed at.
    refreshShipMarkers();
    setVoyageLine(dom.hoveredShipVoyageEl, '');
    paintHoverCard();
    if (!key) return;

    void voyageForShip(key).then((resolved) => {
        if (state.hoveredShipKey !== key) return;   // pointer moved on
        setVoyageLine(dom.hoveredShipVoyageEl, voyageLine(resolved, key));
    }).catch(() => {});
}

/**
 * Keeps a hovered ship's time ticking, for the same reason the selected one
 * does: a reading that stops reading is worse than an offset that never moved.
 */
function refreshHoveredShipTime(): void {
    if (!state.hoveredShipKey) return;
    const ship = state.shipClocks.find((s) => shipKey(s) === state.hoveredShipKey);
    if (!ship) return;
    const value = shipCardValue(ship);
    setCardValue(dom.hoveredTimezoneOffsetEl, value.text, value.mono);
}

/**
 * Keeps the selected ship's time ticking.
 *
 * Only the ship you are ON shows a time here — every other selection shows an
 * offset, which does not move on its own. Deliberately narrow: it rewrites one
 * line and nothing else, because updateShipCard clears the voyage line on its
 * way through and calling that once a second would blank the destination
 * forever.
 */
function refreshSelectedShipTime(): void {
    // The card belongs to the port while one is picked; her time is not what it
    // is saying, and rewriting the value line here would put it back.
    if (state.selectedPlace) return;
    const key = state.selectedShipKey;
    if (!key) return;

    const ship = state.shipClocks.find((s) => shipKey(s) === key);
    if (!ship) return;

    const value = shipCardValue(ship);
    setCardValue(dom.selectedTimezoneOffsetEl, value.text, value.mono);
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
    const value = shipCardValue(ship);
    setCardValue(dom.selectedTimezoneOffsetEl, value.text, value.mono);
    dom.selectedTimezoneDetailsEl.classList.remove('hidden');
}

/**
 * The third line of the card: where she is, or where she is going.
 *
 * The reasoning lives in voyage-line.ts, which has to read the fleet fix and two
 * clocks to decide between them. This end only paints the result and hides the
 * line when there is nothing to say.
 */
/**
 * Writes a card's voyage line, holding the space open when it is empty.
 *
 * Three cards sit in one grid row, so the tallest sets the height of all of
 * them — which means a line appearing on ANY of them shoves the map down. That
 * is tolerable when you click something and intolerable when you merely sweep
 * the pointer across a hull, which is now possible.
 *
 * So while there is a ship on the list at all, every card keeps a blank line in
 * reserve. The row is then already as tall as it will ever need to be, and
 * hovering changes what the cards say without changing where the map is. With
 * no ships the line cannot appear, and the reserve would just be a gap.
 */
function setVoyageLine(el: HTMLElement, line: string): void {
    el.textContent = line || RESERVED;
    el.classList.toggle('hidden', line === '' && state.shipClocks.length === 0);
}

/** A line held open: present, occupying its height, saying nothing. */
const RESERVED = '\u00A0';

const VOYAGE_LINES = () => [
    dom.userShipVoyageEl, dom.selectedShipVoyageEl, dom.hoveredShipVoyageEl,
];
/**
 * Holds the card row at its full height whenever a ship could appear in it.
 *
 * One blank line is the whole mechanism. A min-height on the row was tried and
 * removed: measured at 1280 and 375, aboard and ashore, it changed nothing about
 * the jump and cost 28px of dead space under every card. The line that appears
 * on hover is the only thing that grows the row, so holding that one line is
 * exactly enough.
 *
 * Applied centrally, on the tick, rather than from the writers — and that is the
 * point. Both writers dedupe on their key, and both of them dedupe away their
 * very FIRST call: setAnchorVoyageLine(null) and setHoveredShip(null) each see
 * "same as current" before anything has been painted and return early. Hanging
 * the reserve off them left exactly the cards that never hold a ship — the ones
 * that most need the space held — without it, and the map still jumped by a
 * line when a pointer crossed a hull.
 *
 * Only ever fills in a line that is already empty, so a real destination is
 * never overwritten.
 */
function applyShipReserve(): void {
    const reserve = state.shipClocks.length > 0;

    for (const el of VOYAGE_LINES()) {
        const text = el.textContent ?? '';
        // A real line is left alone; only an empty one is filled in.
        if (text === '' || text === RESERVED) el.textContent = RESERVED;
        el.classList.toggle('hidden', !reserve);
    }

    // Measured after un-hiding, because a display:none element has no width to
    // measure against.
    const rows = reserve ? voyageLineRows() : 1;
    for (const el of VOYAGE_LINES()) {
        el.style.minHeight = reserve ? `${rows * lineHeightOf(el)}px` : '';
    }
}

/**
 * How many lines the cards must hold open, not how many they are showing.
 *
 * One blank line stopped being enough the moment these lines got longer. "→
 * Cozumel · ETA Tue 10:45 AM port time" wraps in the card at ordinary desktop
 * widths, so hovering the ONE hull that says it grew the row by a line and
 * shoved the map down — and moved it back when the pointer left. A map that
 * jumps while you are sweeping a pointer across it is the exact fault the
 * single reserved line was added to fix, reappearing one line further up.
 *
 * So the reserve is measured rather than assumed: every ship that could put a
 * line in one of these cards is asked how wide its line is, and the row is held
 * at whatever the widest of them needs. Every ship on the list, not just the
 * one showing, because the whole point is to have the space already there
 * before the pointer arrives.
 *
 * Measured on a canvas rather than by writing the text and reading the height
 * back, for the same reason the clock rows are: this runs on the tick, and a
 * layout pass per card per second to learn a number we can compute is a poor
 * trade.
 */
function voyageLineRows(): number {
    const width = cardLineWidth();
    if (width <= 0) return 1;

    const font = fontOf(dom.hoveredShipVoyageEl);
    let widest = 0;
    for (const ship of state.shipClocks) {
        const key = shipKey(ship);
        const line = voyageLine(cachedVoyageFor(key), key);
        if (line) widest = Math.max(widest, widthOf(line, font));
    }

    // A hair of slack, because measureText and the layout engine round
    // differently and a line that only just fits must not be called a wrap.
    return Math.max(1, Math.ceil(widest / (width - 2)));
}

/**
 * How wide a line inside one of these cards may be.
 *
 * Read from the GRID rather than from a card, because two of the three cards
 * are display:none most of the time and a box with no layout has no width to
 * measure. `grid-template-columns` resolves to used pixel values, so the column
 * is there to be read whether anything is standing in it or not — which is the
 * point, since what has to be measured is the card that has not appeared yet.
 */
function cardLineWidth(): number {
    const card = dom.hoveredTimezoneDetailsEl;
    const grid = card.parentElement;
    if (!grid) return 0;

    const columns = getComputedStyle(grid).gridTemplateColumns
        .split(' ').map(parseFloat).filter((n) => Number.isFinite(n) && n > 0);
    if (columns.length === 0) return 0;

    const style = getComputedStyle(card);
    const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    // The narrowest column sets it: the cards share a grid row, so the tallest
    // of them is the height of all of them anyway.
    return Math.min(...columns) - (Number.isFinite(inset) ? inset : 28);
}

/** A line's height in px, or a reasonable guess where the style will not say. */
function lineHeightOf(el: HTMLElement): number {
    const style = getComputedStyle(el);
    const height = parseFloat(style.lineHeight);
    return Number.isFinite(height) ? height : parseFloat(style.fontSize) * 1.35 || 16;
}

function setShipVoyageLine(voyage: ShipVoyage | null, key: string | null): void {
    // Shown even when this ship is also the anchor. The two cards are then the
    // same vessel at the same time, and making them differ — by withholding one
    // line from one of them — reads as a discrepancy rather than as economy.
    setVoyageLine(dom.selectedShipVoyageEl, voyageLine(voyage, key));
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

/**
 * When a lookup that came back empty may be tried again; 0 once one has settled.
 *
 * Latching on the key alone was wrong, and wrong in a way that hid itself.
 * voyageForShip returns null IMMEDIATELY when the ship has no IMO yet — which is
 * exactly the state a freshly auto-added vessel is in, since the identity is
 * backfilled from the roster a moment later. Latching then meant the first
 * attempt failed, the guard refused every attempt after it, and the line stayed
 * blank for the rest of the session. Selecting the ship masked it by driving a
 * second lookup through a different path.
 */
let anchorVoyageRetryAt = 0;
const ANCHOR_VOYAGE_RETRY_MS = 5000;

function setAnchorVoyageLine(key: string | null): void {
    const sameShip = key === anchorVoyageKey;
    if (sameShip && anchorVoyageRetryAt === 0) return;              // settled
    if (sameShip && Date.now() < anchorVoyageRetryAt) return;       // waiting to retry

    if (!sameShip) {
        anchorVoyageKey = key;
        setVoyageLine(dom.userShipVoyageEl, '');
    }
    if (!key) { anchorVoyageRetryAt = 0; return; }

    anchorVoyageRetryAt = Date.now() + ANCHOR_VOYAGE_RETRY_MS;
    void voyageForShip(key).then((resolved) => {
        // The anchor may have moved on while this was in flight — stepping
        // ashore, or boarding another vessel.
        if (anchorVoyageKey !== key) return;
        // No voyage yet is not the same as no voyage. Leave the retry window
        // standing so the next tick asks again once the identity resolves.
        if (!resolved) return;

        anchorVoyageRetryAt = 0;
        setVoyageLine(dom.userShipVoyageEl, voyageLine(resolved, key));
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

  void showGeometryDebugLayers();

  state.timezoneMap.data.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
    if (isTouchDevice) return;

    const tzid = event.feature.getProperty('tzid') as string;
    setHoveredZone(tzid);

    // Shown whatever else is on screen. It used to be withheld when the zone
    // was already named by another card, which meant sweeping the pointer over
    // your own zone gave nothing back while every neighbour answered — the one
    // place the map's white outline had no card to match it.
    hoveredZoneTzid = tzid;
    paintHoverCard();
  });

  document.getElementById('timezone-map')!.addEventListener('mouseleave', () => {
    if (isTouchDevice) return;
    setHoveredZone(null);
    hoveredZoneTzid = null;
    paintHoverCard();
  });

  state.timezoneMap.data.addListener('click', (event: google.maps.Data.MouseEvent) => {
    hoveredZoneTzid = null;
    paintHoverCard();
    // The bare zone: clicking the map is clicking the region, not any place
    // inside it.
    selectZone({ tz: event.feature.getProperty('tzid') as string });
  });
}

/**
 * `?debug=geometry` draws where the boundary data disagrees with itself.
 *
 * Two layers, both built by scripts/tz-analysis/build-debug-layers.mjs from
 * whatever timezones.topojson currently holds:
 *
 *   magenta  claimed by more than one zone — the scan order decides who wins
 *   red      claimed by no zone at all — a click there hits nothing
 *
 * The files are gitignored, so in a build that has not generated them the fetch
 * 404s and this quietly does nothing. That is the intended behaviour in
 * production, not a failure worth reporting.
 *
 * These are their own Data layers rather than extra features on the main one:
 * the main layer is indexed by offset and restyled on hover, and debug shapes
 * have no offset to be indexed by.
 */
async function showGeometryDebugLayers(): Promise<void> {
  if (!debugFlag('geometry')) return;
  if (!state.timezoneMap) return;

  const layers: Array<[string, string, string]> = [
    ['debug-overlaps.geojson', '#FF00AA', 'claimed by 2+ zones'],
    ['debug-gaps.geojson',     '#FF3B30', 'claimed by NOTHING'],
    ['debug-adopted.geojson',  '#00E5A0', 'was a band, adopted by the land'],
  ];

  for (const [file, colour, label] of layers) {
    try {
      const response = await fetch(file);
      if (!response.ok) {
        console.warn(`[debug=geometry] ${file} is missing — run scripts/tz-analysis/build-debug-layers.mjs`);
        continue;
      }
      const layer = new google.maps.Data({ map: state.timezoneMap });
      layer.addGeoJson(await response.json());
      layer.setStyle({
        fillColor: colour, fillOpacity: 0.55,
        strokeColor: colour, strokeWeight: 1.5,
        zIndex: 900,
      });
      let count = 0;
      layer.forEach(() => { count++; });
      layer.addListener('click', (event: google.maps.Data.MouseEvent) => {
        const from = event.feature.getProperty('from');
        if (from) {
          console.log(`[debug=geometry] ${event.feature.getProperty('km2')} km2 `
            + `was ${from}, now ${event.feature.getProperty('to')}`);
          return;
        }
        const zones = event.feature.getProperty('zoneList');
        const winner = event.feature.getProperty('winner');
        if (!zones) { console.log(`[debug=geometry] ${label} — nothing claims this`); return; }
        // An overlap is not a bug on its own; what matters is whether the app
        // still lands on the right zone. Say who wins and on what grounds.
        console.log(`[debug=geometry] ${zones}`
          + `\n   -> resolves to ${winner} (${event.feature.getProperty('decided') === 'override'
              ? 'explicit DEFER_TO rule' : 'smallest zone wins'})`
          + `\n   -> loses: ${event.feature.getProperty('loses')}`);
      });
      console.log(`[debug=geometry] ${count} patches ${label} (${colour})`);
    } catch (error) {
      console.warn(`[debug=geometry] could not draw ${file}:`, error);
    }
  }
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
function styleFor(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
  const selection = mapSelection();
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

    // A chart is up because someone asked for one. Aboard with nothing picked
    // is the app's resting state at sea and keeps the map at full strength.
    chartShown: state.selectedShipKey !== null || state.selectedPlace !== null,
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
    // TopoJSON on the wire, GeoJSON in memory. Every coastline is a boundary of
    // two zones at once — the land one and the ocean one beside it — and geojson
    // has no way to say that, so it stores the line twice. topojson stores it
    // once and both zones point at it, which is most of why the file is a third
    // the size. topoFeature stitches the arcs back into ordinary polygons, and
    // nothing downstream (Google's data layer, turf's point-in-polygon) can tell
    // the difference.
    const response = await fetch('timezones.topojson');
    const topology = await response.json();
    const objectName = Object.keys(topology.objects)[0];
    const geoJson = topoFeature(topology, topology.objects[objectName]) as any;

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

/**
 * Keeps a place on the World Clock, if it is not kept already.
 *
 * By PLACE, so Tampa and New York can both be kept and adding Tampa twice
 * cannot. There is no longer anything to overwrite: a rename used to be a write
 * to a shared label map, which is why this had to persist even when the list
 * itself had not changed.
 */
export function keepZone(zone: StoredZone) {
    persistZones(addSavedZone(zone));
    renderWorldClocks();
}

/** Keeps a bare zone. The old name, for callers that only have an id. */
export function addUniqueTimezoneToList(tz: string) {
    keepZone({ tz });
}

/**
 * The one row that stands for where you are, or null.
 *
 * ONE row, which is the whole point of it existing. Blue means "this is where
 * you are", and standing in Vancouver with Nelson also on the list used to
 * paint both of them — they share a zone, and the zone was what was being
 * compared. Only one of them is where you are.
 *
 * The bare row wins where there is one, because that row IS the zone and the
 * app added it on your behalf. Where a named place got there first — and the
 * auto-add then stood down, deliberately — that place is the only row for the
 * zone and so it is the one you are standing in.
 */
function localRowKey(): string | null {
    const tz = state.gpsTzid;
    if (!tz) return null;
    const here = state.savedZones.filter((zone) => zone.tz === tz);
    if (here.length === 0) return null;
    return zoneKey(here.find((zone) => !zone.label) ?? here[0]);
}

export function renderWorldClocks() {
    dom.worldClocksContainerEl.innerHTML = '';

    for (const entry of visibleClocks()) {
        dom.worldClocksContainerEl.appendChild(createClockElement(entry));
    }

    // The list is where ports are kept, so it is where the map hears that one
    // has been kept or dropped. Cheap and idempotent; no map, no work.
    refreshPlaceMarkers();

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
    const zone = entry.kind === 'zone' ? entry.zone : null;
    const tzid = zone?.tz ?? null;

    clockDiv.classList.remove('border-transparent', 'border-blue-500', 'border-yellow-500');

    // A ship whose port is the actual selection is CONTEXT, not the pick — the
    // same standing as a zone that merely shares the selected offset, which
    // gets no border either. Her band and hull stay as they are on the map,
    // where they are saying something the list has no way to say.
    const isSelectedShip = entry.kind === 'ship'
        && shipKey(entry.ship) === state.selectedShipKey
        && !state.selectedPlace;

    // Compared by PLACE, all of it. Both of these used to test the ZONE, which
    // was the same thing right up until a zone could hold two rows: standing in
    // Vancouver with Nelson also saved lit them both, and picking a third place
    // left all three bordered at once because nothing had cleared the first.
    const picked = !!zone && !!state.temporaryZone
        && zoneKey(zone) === zoneKey(state.temporaryZone);

    if (picked) {
        clockDiv.classList.add('border-yellow-500');
    } else if (zone && zoneKey(zone) === localRowKey()) {
        clockDiv.classList.add('border-blue-500');
    } else if (isSelectedShip) {
        // Same gold as a selected zone: the row, the band and the marker are one
        // selection shown three ways, so they should not look like three states.
        clockDiv.classList.add('border-yellow-500');
    } else {
        clockDiv.classList.add('border-transparent');
    }

    // Transient means picked but not kept — the row with the pin beside it.
    // Compared by PLACE: Tampa is not "already saved" because New York is.
    const isTransient = picked && !savedZoneByKey(zoneKey(zone!));

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
    // An anchor says this row is a port a ship on the list calls at, not a
    // place the user chose for its own sake. Mutually exclusive with the ship
    // mark by construction: a ship row has no tzid to have been added under.
    if (zone?.kind === 'port') {
        clone.querySelector('.port-icon')!.classList.remove('hidden');
    }

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