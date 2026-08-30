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
        String action = intent.getAction();
        if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_DATE_CHANGED.equals(action)) {
            refreshAll(ctx);
        }
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

        // Always keep the special rows (local + device); fill the rest by offset.
        List<Row> specials = new ArrayList<>();
        List<Row> others = new ArrayList<>();
        for (Row r : rows) {
            if (r.isLocal || r.isDevice) specials.add(r); else others.add(r);
        }
        List<Row> visible = new ArrayList<>(specials);
        for (Row r : others) {
            if (visible.size() >= budget) break;
            visible.add(r);
        }
        Collections.sort(visible, OFFSET_ORDER);
        int overflow = rows.size() - visible.size();

        boolean is24 = android.text.format.DateFormat.is24HourFormat(ctx);
        boolean useFullDay = decideFullDay(ctx, visible, opts);
        boolean showLocalLabel = decideLocalLabel(ctx, visible, opts);
        boolean showDeviceLabel = decideDeviceLabel(ctx, visible, opts);
        for (Row r : visible) {
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.row_city, r.label);
            row.setString(R.id.row_time, "setTimeZone", r.tzId);   // @RemotableViewMethod
            row.setString(R.id.row_period, "setTimeZone", r.tzId);
            row.setViewVisibility(R.id.row_period, is24 ? View.GONE : View.VISIBLE);
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
        final String tzId;         // id passed to TextClock.setTimeZone
        final long offsetMin;
        final boolean isLocal;     // GPS-derived base zone (green pin)
        final boolean isDevice;    // device OS zone when it differs from local (phone)
        final String dayLabel;     // "Tue" — null unless the calendar day differs
        final String dayLabelFull; // "Tuesday" — used when there's room
        final String offset;       // "+3 hrs" relative to local; "" for local

        Row(String label, String tzId, long offsetMin, boolean isLocal, boolean isDevice,
            String dayLabel, String dayLabelFull, String offset) {
            this.label = label;
            this.tzId = tzId;
            this.offsetMin = offsetMin;
            this.isLocal = isLocal;
            this.isDevice = isDevice;
            this.dayLabel = dayLabel;
            this.dayLabelFull = dayLabelFull;
            this.offset = offset;
        }
    }

    private static List<Row> buildRows(Context ctx) {
        long now = System.currentTimeMillis();
        TimeZone osTz = TimeZone.getDefault();

        LocalZone local = resolveLocal(ctx, osTz);
        TimeZone baseTz = local.tz;                 // GPS-derived local, unless stale
        String baseId = baseTz.getID();
        long baseOffset = baseTz.getOffset(now) / 60000L;

        List<String> stored = readStored(ctx);

        List<Row> rows = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        seen.add(baseId); // local pre-claims its slot

        // The town the app last placed you in ("Nelson"), else the zone's own name.
        String baseLabel = local.placeName != null ? local.placeName : cityLabel(baseId);
        rows.add(new Row(baseLabel, baseId, baseOffset, true, false, null, null, ""));

        // Device OS zone, shown separately when it differs from the GPS-local zone.
        long osOffset = osTz.getOffset(now) / 60000L;
        if (osOffset != baseOffset) {
            seen.add(osTz.getID());
            boolean d = dayDiffers(osTz, baseTz, now);
            rows.add(new Row(cityLabel(osTz.getID()), osTz.getID(), osOffset, false, true,
                    d ? formatDay(osTz, now, false) : null,
                    d ? formatDay(osTz, now, true) : null,
                    relativeOffset(osOffset, baseOffset)));
        }

        for (String id : stored) {
            if (id.equals(baseId) || !isKnownZone(id)) continue;
            Resolved rz = resolveTimeZone(id);
            long off = rz.tz.getOffset(now) / 60000L;
            if (seen.contains(rz.tzId)) continue; // local / device / earlier zone wins the slot
            seen.add(rz.tzId);
            boolean differs = dayDiffers(rz.tz, baseTz, now);
            String dayShort = differs ? formatDay(rz.tz, now, false) : null;
            String dayFull = differs ? formatDay(rz.tz, now, true) : null;
            rows.add(new Row(cityLabel(id), rz.tzId, off, false, false, dayShort, dayFull, relativeOffset(off, baseOffset)));
        }

        Collections.sort(rows, OFFSET_ORDER);
        return rows;
    }

    private static class Resolved {
        final TimeZone tz;
        final String tzId;
        Resolved(TimeZone tz, String tzId) { this.tz = tz; this.tzId = tzId; }
    }

    /**
     * Whether tzdb actually knows this id.
     *
     * TimeZone.getTimeZone silently returns GMT for anything it doesn't
     * recognise, so an id that never resolves would quietly show the wrong time
     * rather than falling back. (Swift's TimeZone(identifier:) returns nil here,
     * so without this check the two platforms disagree on corrupt input.)
     */
    private static boolean isKnownZone(String id) {
        if (ETC_GMT.matcher(id).matches()) return true;      // remapped below
        if (id.equals("GMT") || id.equals("UTC")) return true;
        return !TimeZone.getTimeZone(id).getID().equals("GMT");
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
    private static String relativeOffset(long zoneOffsetMin, long deviceOffsetMin) {
        long diff = zoneOffsetMin - deviceOffsetMin;
        if (diff == 0) return "Local time";
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

    static class LocalZone {
        final TimeZone tz;
        final String placeName;
        /** True when the stored GPS zone was discarded as overtaken by travel. */
        final boolean supersededByDevice;
        LocalZone(TimeZone tz, String placeName, boolean supersededByDevice) {
            this.tz = tz; this.placeName = placeName;
            this.supersededByDevice = supersededByDevice;
        }
    }

    /**
     * What the widget should treat as "local", and what to call it.
     *
     * The stored zone is GPS-derived and only refreshed while the app runs, so on
     * its own the widget stays on your old timezone for a whole trip until you
     * happen to open the app. Phones update their *own* timezone on landing, so a
     * device zone that has changed since the app last wrote is firm evidence the
     * stored one has been overtaken — trust the OS, and drop the place name with
     * it, since it names a town you have left.
     *
     * Pure so the rule can be tested directly, and so it can be read beside the
     * iOS twin, chooseLocal in WidgetSharedStore.swift.
     */
    static LocalZone chooseLocal(String storedZone, String writtenUnder,
                                 String placeName, TimeZone deviceTz) {
        if (storedZone == null || storedZone.isEmpty() || !isKnownZone(storedZone)) {
            return new LocalZone(deviceTz, null, false);
        }
        if (writtenUnder != null && !writtenUnder.equals(deviceTz.getID())) {
            return new LocalZone(deviceTz, null, true);
        }
        return new LocalZone(resolveTimeZone(storedZone).tz,
                (placeName != null && !placeName.isEmpty()) ? placeName : null, false);
    }

    /** Reads the stored values and applies {@link #chooseLocal}. */
    private static LocalZone resolveLocal(Context ctx, TimeZone osTz) {
        SharedPreferences prefs = ctx.getSharedPreferences(
                WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        return chooseLocal(
                prefs.getString(WidgetBridgePlugin.PREFS_LOCAL_TZ_KEY, null),
                prefs.getString(WidgetBridgePlugin.PREFS_DEVICE_TZ_AT_WRITE_KEY, null),
                prefs.getString(WidgetBridgePlugin.PREFS_LOCAL_PLACE_KEY, null),
                osTz);
    }

    private static List<String> readStored(Context ctx) {
        List<String> result = new ArrayList<>();
        SharedPreferences prefs = ctx.getSharedPreferences(
                WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(WidgetBridgePlugin.PREFS_KEY, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, null);
                if (id != null && !id.isEmpty()) result.add(id);
            }
        } catch (Exception ignored) {
            // malformed prefs -> treat as empty
        }
        return result;
    }
}
