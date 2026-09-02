package ca.matthewcarroll.geotime;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GeoTimeWidgetProvider extends AppWidgetProvider {

    private static final int MAX_ROWS = 8;
    private static final Pattern ETC_GMT = Pattern.compile("^Etc/GMT([+-])(\\d+(?:\\.\\d+)?)$");

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {

        for (int id : ids) updateOne(ctx, mgr, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        updateOne(ctx, mgr, id); // re-render on resize
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {

        super.onReceive(ctx, intent); // dispatches APPWIDGET_UPDATE -> onUpdate
        maybeRefreshShipTime(ctx, intent);
        String action = intent.getAction();
        if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_DATE_CHANGED.equals(action)) {
            refreshAll(ctx);
        }
    }

    /**
     * Re-asks the API for stale ship offsets, then redraws if anything moved.
     *
     * This is what makes the widget follow a mid-cruise clock change when nobody
     * opens the app. The wake-up itself was already happening every 30 minutes
     * for the clock (updatePeriodMillis), so riding it costs no extra alarms.
     *
     * goAsync(), NOT a bare thread. A broadcast receiver's process is only
     * guaranteed to stay alive for the duration of onReceive, so a thread
     * started and left running can be killed mid-request — which is exactly what
     * happened the first time this was written: the fetch silently never
     * completed. goAsync() holds the process for the work and finish() releases
     * it. There is roughly a ten-second budget, which one small GET fits inside.
     *
     * Deliberately after super.onReceive: the widget draws immediately from the
     * cached offset and only redraws if the network had something new to say.
     */
    private void maybeRefreshShipTime(Context ctx, Intent intent) {
        if (!AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(intent.getAction())) return;

        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                if (ShipTimeFetcher.refreshStaleShips(ctx)) refreshAll(ctx);
            } finally {
                pending.finish();
            }
        }).start();
    }

    public static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, GeoTimeWidgetProvider.class));
        for (int id : ids) updateOne(ctx, mgr, id);
    }

    private static void updateOne(Context ctx, AppWidgetManager mgr, int widgetId) {
        List<Row> rows = buildRows(ctx);

        // Height-aware budget. In portrait the widget's height is MAX_HEIGHT
        // (MIN_HEIGHT is the landscape height); ~27dp per row after container
        // padding. The "+N more" footer has its own space below the rows
        // container, so it never costs a row slot.
        Bundle opts = mgr.getAppWidgetOptions(widgetId);
        int heightDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (heightDp <= 0) heightDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110);
        int budget = Math.max(1, Math.min(MAX_ROWS, (heightDp - 28) / 27));

        RemoteViews root = new RemoteViews(ctx.getPackageName(), R.layout.widget_geotime);
        root.removeAllViews(R.id.widget_rows); // rows accumulate across updates otherwise

        // Always keep the special rows (local, device, ship); fill the rest by
        // offset. A ship is special because aboard it is the most important row
        // on the screen — and it only stops being special once a definite
        // "shore" marker arrives, which needs connectivity and therefore means
        // the guest really is ashore. A dead phone in a port yields no marker,
        // so the ship keeps its slot exactly when it matters most.
        List<Row> specials = new ArrayList<>();
        List<Row> others = new ArrayList<>();
        for (Row r : rows) {
            if (r.isLocal || r.isDevice || r.isShip) specials.add(r); else others.add(r);
        }
        List<Row> visible = new ArrayList<>(specials);
        for (Row r : others) {
            if (visible.size() >= budget) break;
            visible.add(r);
        }
        Collections.sort(visible, OFFSET_ORDER);
        int overflow = rows.size() - visible.size();

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        boolean useFullShipName = decideFullShipName(ctx, visible, opts);
        boolean useFullDay = decideFullDay(ctx, visible, opts);
        boolean showLocalLabel = decideLocalLabel(ctx, visible, opts);
        boolean showDeviceLabel = decideDeviceLabel(ctx, visible, opts);
        for (Row r : visible) {
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.row_city,
                    (!useFullShipName && r.shortLabel != null) ? r.shortLabel : r.label);
            row.setString(R.id.row_time, "setTimeZone", r.tzId);   // @RemotableViewMethod
            row.setString(R.id.row_period, "setTimeZone", r.tzId);
            row.setViewVisibility(R.id.row_period, is24 ? View.GONE : View.VISIBLE);
            // A merged row is both local and ship, and shows BOTH marks: the ship
            // says what you are aboard, the pin says it is also where you are.
            // They answer different questions, so neither is left to inference.
            // Mirrors marker(for:) in GeoTimeWidget.swift.
            row.setViewVisibility(R.id.row_ship, r.isShip ? View.VISIBLE : View.GONE);
            row.setViewVisibility(R.id.row_pin, r.isLocal ? View.VISIBLE : View.GONE);
            row.setViewVisibility(R.id.row_local_label, (r.isLocal && showLocalLabel) ? View.VISIBLE : View.GONE);
            row.setViewVisibility(R.id.row_device, r.isDevice ? View.VISIBLE : View.GONE);
            if (r.dayLabel != null) {
                row.setTextViewText(R.id.row_day, useFullDay ? r.dayLabelFull : r.dayLabel);
                row.setViewVisibility(R.id.row_day, View.VISIBLE);
            } else {
                row.setViewVisibility(R.id.row_day, View.GONE);
            }
            if (!r.isLocal) {
                row.setTextViewText(R.id.row_offset, r.offset);
                row.setViewVisibility(R.id.row_offset, View.VISIBLE);
            } else {
                row.setViewVisibility(R.id.row_offset, View.GONE);
            }
            row.setViewVisibility(R.id.row_device_label,
                    (r.isDevice && showDeviceLabel) ? View.VISIBLE : View.GONE);
            root.addView(R.id.widget_rows, row);
        }

        if (overflow > 0) {
            root.setTextViewText(R.id.widget_more, "+" + overflow + " more");
            root.setViewVisibility(R.id.widget_more, View.VISIBLE);
        } else {
            root.setViewVisibility(R.id.widget_more, View.GONE);
        }

        Intent launch = new Intent(ctx, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                ctx, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        root.setOnClickPendingIntent(R.id.widget_root, pi);

        mgr.updateAppWidget(widgetId, root);
    }

    // --- Canonical row algorithm (kept in sync with iOS ZoneRowResolver) ----
    //
    // Zones are deduped by IANA id, NOT by UTC offset: America/Vancouver and
    // America/Los_Angeles read the same today and differ in November, and if both
    // were added the user asked for both. (The device row is still offset-gated;
    // that row exists to answer "is my phone showing a different time".)

    private static final Comparator<Row> OFFSET_ORDER = new Comparator<Row>() {
        public int compare(Row a, Row b) {
            // Offsets can tie now, so break ties by label for a stable order.
            int byOffset = Long.compare(a.offsetMin, b.offsetMin);
            return byOffset != 0 ? byOffset : a.label.compareToIgnoreCase(b.label);
        }
    };

    private static class Row {
        final String label;
        /** Shorter form of `label` where one exists (ships); null otherwise. */
        final String shortLabel;
        final String tzId;         // id passed to TextClock.setTimeZone
        final long offsetMin;
        final boolean isLocal;     // GPS-derived base zone (green pin)
        final boolean isDevice;    // device OS zone when it differs from local (phone)
        final boolean isShip;      // a cruise ship's crew-set clock (ship mark)
        final String dayLabel;     // "Tue" — null unless the calendar day differs
        final String dayLabelFull; // "Tuesday" — used when there's room
        final String offset;       // "+3 hrs" relative to local; "" for local

        Row(String label, String tzId, long offsetMin, boolean isLocal, boolean isDevice,
            String dayLabel, String dayLabelFull, String offset) {
            this(label, null, tzId, offsetMin, isLocal, isDevice, false, dayLabel, dayLabelFull, offset);
        }

        Row(String label, String shortLabel, String tzId, long offsetMin, boolean isLocal,
            boolean isDevice, boolean isShip, String dayLabel, String dayLabelFull, String offset) {
            this.label = label;
            this.shortLabel = shortLabel;
            this.tzId = tzId;
            this.offsetMin = offsetMin;
            this.isLocal = isLocal;
            this.isDevice = isDevice;
            this.isShip = isShip;
            this.dayLabel = dayLabel;
            this.dayLabelFull = dayLabelFull;
            this.offset = offset;
        }
    }

    private static List<Row> buildRows(Context ctx) {
        long now = System.currentTimeMillis();
        TimeZone baseTz = localBaseTimeZone(ctx);   // GPS-derived local
        String baseId = baseTz.getID();
        long baseOffset = baseTz.getOffset(now) / 60000L;

        List<String> stored = readStored(ctx);
        // Names the user actually picked, parallel to `stored`. Searching
        // "San Francisco" stores America/Los_Angeles, and the widget should say
        // San Francisco rather than re-deriving Los Angeles from the id.
        List<String> labels = readList(ctx, WidgetBridgePlugin.PREFS_LABELS_KEY);

        List<Row> rows = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        seen.add(baseId); // local pre-claims its slot

        // ONE RULE for every special row: the base always shows, and device and
        // ship each appear only when they add information — when their offset
        // differs from the base. Kept identical to iOS ZoneRowResolver.resolve.
        //
        // The deliberate asymmetry is how "agreeing" resolves. An agreeing
        // device is hidden: knowing your phone concurs is not worth a row. An
        // agreeing ship is folded INTO the base row, because it brings what a
        // device cannot — a name. Mid-ocean the base row would otherwise read
        // "UTC-5", the nearest-town lookup being capped at 150 km and correctly
        // finding nothing, so lending it "Star" is the difference between naming
        // where you are and naming a number.
        List<Ship> ships = readShips(ctx);
        Ship agreeingShip = null;
        for (Ship ship : ships) {
            if (ship.offsetMin == baseOffset) { agreeingShip = ship; break; }
        }

        // The town the app last placed you in ("Nelson"), else the zone's own name.
        String localPlace = localPlaceName(ctx);
        String baseLabel = agreeingShip != null ? agreeingShip.name
                : (localPlace != null ? localPlace : cityLabel(baseId));
        rows.add(new Row(baseLabel, agreeingShip != null ? agreeingShip.shortName : null,
                baseId, baseOffset, true, false, agreeingShip != null, null, null, ""));

        // Device OS zone, shown separately when it differs from the GPS-local zone.
        TimeZone osTz = TimeZone.getDefault();
        long osOffset = osTz.getOffset(now) / 60000L;
        if (osOffset != baseOffset) {
            seen.add(osTz.getID());
            boolean d = dayDiffers(osTz, baseTz, now);
            rows.add(new Row(cityLabel(osTz.getID()), osTz.getID(), osOffset, false, true,
                    d ? formatDay(osTz, now, false) : null,
                    d ? formatDay(osTz, now, true) : null,
                    relativeOffset(osOffset, baseOffset)));
        }

        // Indexed, because `labels` is parallel to `stored` — skipping an entry
        // must not shift the rest of the names by one.
        for (int i = 0; i < stored.size(); i++) {
            String id = stored.get(i);
            if (id.isEmpty() || id.equals(baseId)) continue;
            Resolved rz = resolveTimeZone(id);
            long off = rz.tz.getOffset(now) / 60000L;
            if (seen.contains(rz.tzId)) continue; // local / device / earlier zone wins the slot
            seen.add(rz.tzId);
            boolean differs = dayDiffers(rz.tz, baseTz, now);
            String dayShort = differs ? formatDay(rz.tz, now, false) : null;
            String dayFull = differs ? formatDay(rz.tz, now, true) : null;
            // The name the user chose, where there is one.
            String chosen = (i < labels.size() && !labels.get(i).isEmpty()) ? labels.get(i) : null;
            rows.add(new Row(chosen != null ? chosen : cityLabel(id), rz.tzId, off, false, false,
                    dayShort, dayFull, relativeOffset(off, baseOffset)));
        }

        // Ships that do NOT match the base offset get their own row; the one
        // that does was folded in above, so a detected ship appears exactly once.
        for (Ship ship : ships) {
            if (ship.offsetMin == baseOffset) continue;
            TimeZone tz = TimeZone.getTimeZone(ship.tzId());
            boolean differs = dayDiffers(tz, baseTz, now);
            rows.add(new Row(ship.name, ship.shortName, ship.tzId(), ship.offsetMin, false, false, true,
                    differs ? formatDay(tz, now, false) : null,
                    differs ? formatDay(tz, now, true) : null,
                    relativeOffset(ship.offsetMin, baseOffset)));
        }

        Collections.sort(rows, OFFSET_ORDER);
        return rows;
    }

    /**
     * A ship as the widget needs it: a name and a fixed offset.
     *
     * Deliberately not an IANA id. A crew-set clock has no rules for a tzdb
     * entry to describe, and a synthetic id would need hand-written parsing on
     * every platform — the exact thing the 1.3.0 restructure removed. A
     * "GMT+HH:MM" id is a real fixed-offset zone with no DST, which is right for
     * a vessel, and TextClock accepts it directly.
     */
    private static class Ship {
        /** Full name, used wherever the layout has room. */
        final String name;
        /** Abbreviated form, used only when the full name will not fit. */
        final String shortName;
        final long offsetMin;

        Ship(String name, String shortName, long offsetMin) {
            this.name = name;
            this.shortName = shortName;
            this.offsetMin = offsetMin;
        }

        String tzId() {
            long abs = Math.abs(offsetMin);
            return String.format(java.util.Locale.US, "GMT%s%02d:%02d",
                    offsetMin < 0 ? "-" : "+", abs / 60, abs % 60);
        }
    }

    /**
     * Ships written by the web layer. An entry without a usable offset is
     * dropped: the web layer already withholds unresolved ships, and a ship with
     * no offset has no time to show — a missing row is honest, where a zero
     * offset would be a confident wrong clock.
     */
    private static List<Ship> readShips(Context ctx) {
        List<Ship> out = new ArrayList<>();
        String json = ctx.getSharedPreferences(WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE)
                .getString(WidgetBridgePlugin.PREFS_SHIPS_KEY, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String name = o.optString("name", "");
                if (name.isEmpty() || !o.has("offsetMinutes")) continue;
                // Falls back to the full name so a store written by an older
                // build still renders, just without the ability to abbreviate.
                String shortName = o.optString("short", name);
                out.add(new Ship(name, shortName, o.optLong("offsetMinutes")));
            }
        } catch (JSONException e) {
            // Malformed store: no ships rather than a wrong clock.
        }
        return out;
    }

    private static class Resolved {
        final TimeZone tz;
        final String tzId;
        Resolved(TimeZone tz, String tzId) { this.tz = tz; this.tzId = tzId; }
    }

    // "Etc/GMT+5.5" is not a valid tzdb id (naive getTimeZone => GMT+0). Parse it,
    // invert the POSIX sign, and build a real "GMT±HH:MM" id.
    private static Resolved resolveTimeZone(String id) {
        Matcher m = ETC_GMT.matcher(id);
        if (m.matches()) {
            double n = Double.parseDouble(m.group(2));
            double inverted = m.group(1).equals("+") ? -n : n;
            String sign = inverted < 0 ? "-" : "+";
            double abs = Math.abs(inverted);
            int h = (int) abs;
            int min = (int) Math.round((abs - h) * 60);
            String tzId = String.format(Locale.US, "GMT%s%02d:%02d", sign, h, min);
            return new Resolved(TimeZone.getTimeZone(tzId), tzId);
        }
        return new Resolved(TimeZone.getTimeZone(id), id);
    }

    // Matches getDisplayTimezoneName (src/time.ts).
    private static String cityLabel(String id) {
        Matcher m = ETC_GMT.matcher(id);
        if (m.matches()) {
            double n = Double.parseDouble(m.group(2));
            double inverted = m.group(1).equals("+") ? -n : n;
            String num = (inverted == Math.rint(inverted))
                    ? String.valueOf((int) inverted)
                    : String.valueOf(inverted);
            return "UTC" + (inverted >= 0 ? "+" : "") + num;
        }
        int slash = id.lastIndexOf('/');
        String seg = slash >= 0 ? id.substring(slash + 1) : id;
        return seg.replace('_', ' ');
    }

    // Port of getTimezoneOffset (src/time.ts): "+3 hrs", "−5½ hrs" (U+2212 minus).
    //
    // Only ever called for rows that are NOT the local one — the local row sets
    // its own text — so a zero difference means "a different place that happens
    // to read the same right now", not "here".
    private static String relativeOffset(long zoneOffsetMin, long deviceOffsetMin) {
        long diff = zoneOffsetMin - deviceOffsetMin;
        if (diff == 0) return "+0 hrs";
        String sign = diff > 0 ? "+" : "−";
        long abs = Math.abs(diff);
        long hours = abs / 60;
        long frac = abs % 60;
        StringBuilder hs = new StringBuilder();
        if (hours > 0) hs.append(hours);
        if (frac == 30) hs.append("½");
        else if (frac == 45) hs.append("¾");
        else if (frac == 15) hs.append("¼");
        String plural = abs > 60 ? "s" : "";
        return sign + hs + " hr" + plural;
    }

    private static boolean dayDiffers(TimeZone tz, TimeZone deviceTz, long now) {
        Calendar a = Calendar.getInstance(tz);
        a.setTimeInMillis(now);
        Calendar b = Calendar.getInstance(deviceTz);
        b.setTimeInMillis(now);
        return a.get(Calendar.YEAR) != b.get(Calendar.YEAR)
                || a.get(Calendar.DAY_OF_YEAR) != b.get(Calendar.DAY_OF_YEAR);
    }

    private static String formatDay(TimeZone tz, long now, boolean full) {
        SimpleDateFormat f = new SimpleDateFormat(full ? "EEEE" : "EEE", Locale.getDefault());
        f.setTimeZone(tz);
        return f.format(new Date(now));
    }

    // Full weekday names ("Tuesday") only if every day-labeled row still fits the
    // widget width without truncating its city — city size/legibility wins.
    /**
     * Whether a ship's full name fits, or the abbreviation is needed.
     *
     * Mirrors the iOS metrics decision, and is checked BEFORE the optional
     * labels: a name is content where a label is garnish, so it would be wrong
     * to keep "Tuesday" at the cost of abbreviating a vessel. In practice the
     * full name fits on medium and large and only the small widget falls back
     * to "Star".
     */
    private static boolean decideFullShipName(Context ctx, List<Row> rows, Bundle opts) {
        boolean anyShip = false;
        for (Row r : rows) if (r.shortLabel != null) { anyShip = true; break; }
        if (!anyShip) return true;

        android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int widthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180);
        float usable = (widthDp - 24) * dm.density;          // inside the 12dp root padding
        float gap = 6 * dm.density;

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        android.graphics.Paint cityPaint = new android.graphics.Paint();
        cityPaint.setTextSize(15 * dm.scaledDensity);
        android.graphics.Paint detailPaint = new android.graphics.Paint();
        detailPaint.setTextSize(11 * dm.scaledDensity);

        for (Row r : rows) {
            if (r.shortLabel == null) continue;
            float need = cityPaint.measureText(r.label) + gap;   // the FULL name
            need += 12 * dm.density + gap;                       // ship marker
            // A merged local+ship row carries the pin as well.
            if (r.isLocal) need += 12 * dm.density + gap;
            if (!r.isLocal) need += detailPaint.measureText(r.offset) + gap;
            if (r.dayLabel != null) need += detailPaint.measureText(r.dayLabel) + gap;
            need += cityPaint.measureText(is24 ? "88:88" : "8:88") + gap;
            if (!is24) need += detailPaint.measureText("PM") + gap;
            if (need > usable) return false;
        }
        return true;
    }

    private static boolean decideFullDay(Context ctx, List<Row> rows, Bundle opts) {
        boolean anyDay = false;
        for (Row r : rows) if (r.dayLabelFull != null) { anyDay = true; break; }
        if (!anyDay) return true;

        android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int widthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180);
        float usable = (widthDp - 24) * dm.density;          // inside the 12dp root padding
        float gap = 6 * dm.density;

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        android.graphics.Paint cityPaint = new android.graphics.Paint();
        cityPaint.setTextSize(15 * dm.scaledDensity);
        android.graphics.Paint detailPaint = new android.graphics.Paint();
        detailPaint.setTextSize(11 * dm.scaledDensity);

        for (Row r : rows) {
            if (r.dayLabelFull == null) continue;
            float need = cityPaint.measureText(r.label) + gap;
            need += detailPaint.measureText(r.offset) + gap;            // inline offset
            if (r.isDevice) need += 12 * dm.density + gap;             // phone marker
            need += detailPaint.measureText(r.dayLabelFull) + gap;      // full day name
            need += cityPaint.measureText(is24 ? "88:88" : "8:88") + gap; // time
            if (!is24) need += detailPaint.measureText("PM") + gap;     // AM/PM column
            if (need > usable) return false;
        }
        return true;
    }

    // The "Local time" tag next to the pin, only if the local row still fits.
    private static boolean decideLocalLabel(Context ctx, List<Row> rows, Bundle opts) {
        Row local = null;
        for (Row r : rows) if (r.isLocal) { local = r; break; }
        if (local == null) return false;

        android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int widthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180);
        float usable = (widthDp - 24) * dm.density;
        float gap = 6 * dm.density;

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        android.graphics.Paint cityPaint = new android.graphics.Paint();
        cityPaint.setTextSize(15 * dm.scaledDensity);
        android.graphics.Paint detailPaint = new android.graphics.Paint();
        detailPaint.setTextSize(11 * dm.scaledDensity);

        float need = cityPaint.measureText(local.label) + gap;
        need += 12 * dm.density + gap;                               // pin
        need += detailPaint.measureText("Local time") + gap;        // the tag
        need += cityPaint.measureText(is24 ? "88:88" : "8:88") + gap; // time
        if (!is24) need += detailPaint.measureText("PM") + gap;      // AM/PM column
        return need <= usable;
    }

    // The "· Device time" tag on the device row, only if it still fits.
    private static boolean decideDeviceLabel(Context ctx, List<Row> rows, Bundle opts) {
        Row device = null;
        for (Row r : rows) if (r.isDevice) { device = r; break; }
        if (device == null) return false;

        android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int widthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180);
        float usable = (widthDp - 24) * dm.density;
        float gap = 6 * dm.density;

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        android.graphics.Paint cityPaint = new android.graphics.Paint();
        cityPaint.setTextSize(15 * dm.scaledDensity);
        android.graphics.Paint detailPaint = new android.graphics.Paint();
        detailPaint.setTextSize(11 * dm.scaledDensity);

        float need = cityPaint.measureText(device.label) + gap;
        need += detailPaint.measureText(device.offset) + gap;       // offset
        need += detailPaint.measureText("· Device time") + gap;     // the tag
        need += 12 * dm.density + gap;                              // phone marker
        if (device.dayLabelFull != null) {
            need += detailPaint.measureText(device.dayLabel) + gap; // day label
        }
        need += cityPaint.measureText(is24 ? "88:88" : "8:88") + gap; // time
        if (!is24) need += detailPaint.measureText("PM") + gap;      // AM/PM column
        return need <= usable;
    }

    // The app's GPS-derived local zone (falls back to the OS default). This is the
    // "local" base for the pin and offsets, matching the app's Local Time card.
    private static TimeZone localBaseTimeZone(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(
                WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String id = prefs.getString(WidgetBridgePlugin.PREFS_LOCAL_TZ_KEY, null);
        if (id != null && !id.isEmpty()) {
            Resolved rz = resolveTimeZone(id);
            return rz.tz;
        }
        return TimeZone.getDefault();
    }

    // Resolved by the app: the city index it comes from is far too large to
    // parse in a widget provider.
    private static String localPlaceName(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(
                WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String name = prefs.getString(WidgetBridgePlugin.PREFS_LOCAL_PLACE_KEY, null);
        return (name != null && !name.isEmpty()) ? name : null;
    }

    private static List<String> readStored(Context ctx) {
        return readList(ctx, WidgetBridgePlugin.PREFS_KEY);
    }

    private static List<String> readList(Context ctx, String key) {
        List<String> result = new ArrayList<>();
        SharedPreferences prefs = ctx.getSharedPreferences(
                WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(key, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                // Kept positional: labels are parallel to the zone list, so a
                // blank entry must occupy its slot rather than shift the rest.
                result.add(arr.optString(i, ""));
            }
        } catch (Exception ignored) {
            // malformed prefs -> treat as empty
        }
        return result;
    }
}
