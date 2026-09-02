package ca.matthewcarroll.geotime;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Fetches a ship's current UTC offset for the home-screen widget.
 *
 * A deliberate second implementation of what src/rccl.ts does, and the reason is
 * unavoidable: an AppWidgetProvider cannot call into the WebView, so it cannot
 * reuse the TypeScript client. Without this the widget only ever changes when
 * somebody opens the app, which on a cruise means the home screen quietly drifts
 * an hour out for a day at a time.
 *
 * Kept as small as it can be — one GET, one field read — precisely because it is
 * a duplicate. Everything else about ship time (which ships exist, which one you
 * are aboard, how a row is named, what bounds the refresh) stays in the web layer
 * and arrives through SharedPreferences.
 *
 * Mirrors ios/App/Shared/ShipTimeFetcher.swift.
 */
final class ShipTimeFetcher {

    /**
     * How stale an offset must be before the widget re-asks.
     *
     * Crews shift the clock overnight, once or twice a sailing, so four hours is
     * already far finer than the data changes. The provider wakes every 30
     * minutes anyway (updatePeriodMillis), so this mostly decides how often that
     * wake-up makes a request rather than how often it happens.
     */
    private static final long STALE_AFTER_MS = 4L * 60 * 60 * 1000;

    private static final int TIMEOUT_MS = 12_000;

    private ShipTimeFetcher() {}

    /**
     * Refreshes any stored ship whose offset has gone stale and writes the
     * results back. Returns true when something changed, so the caller only
     * re-renders if there is a reason to.
     *
     * Never clears a stored offset: if the request fails, the cached value is
     * what the widget keeps showing. That is the point of storing it — a phone in
     * a port with no signal still knows when to be back aboard.
     *
     * Blocking, so call it off the main thread (see GeoTimeWidgetProvider).
     */
    static boolean refreshStaleShips(Context ctx) {
        SharedPreferences prefs =
                ctx.getSharedPreferences(WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String appKey = prefs.getString(WidgetBridgePlugin.PREFS_APP_KEY, "");
        if (appKey == null || appKey.isEmpty()) return false;

        JSONArray ships;
        try {
            ships = new JSONArray(prefs.getString(WidgetBridgePlugin.PREFS_SHIPS_KEY, "[]"));
        } catch (JSONException e) {
            return false;
        }

        long now = System.currentTimeMillis();
        boolean changed = false;

        for (int i = 0; i < ships.length(); i++) {
            JSONObject ship = ships.optJSONObject(i);
            if (ship == null || !needsRefresh(ship, now)) continue;

            Integer offset = fetchOffsetMinutes(ship.optString("key", ""), appKey);
            if (offset == null) continue;               // unreachable; keep what we had
            if (offset == ship.optInt("offsetMinutes", Integer.MIN_VALUE)
                    && ship.optLong("fetchedAt", 0) > 0) {
                // Same value; still record that we checked, so the next wake-up
                // does not immediately ask again.
                try { ship.put("fetchedAt", now); changed = true; } catch (JSONException ignored) {}
                continue;
            }
            try {
                ship.put("offsetMinutes", (int) offset);
                ship.put("fetchedAt", now);
                changed = true;
            } catch (JSONException ignored) {}
        }

        if (changed) {
            prefs.edit().putString(WidgetBridgePlugin.PREFS_SHIPS_KEY, ships.toString()).apply();
        }
        return changed;
    }

    private static boolean needsRefresh(JSONObject ship, long now) {
        long until = ship.optLong("refreshUntil", 0);
        if (until > 0 && now > until) return false;    // voyage is over
        return now - ship.optLong("fetchedAt", 0) > STALE_AFTER_MS;
    }

    /**
     * One /time request. Null on any failure, including a malformed response.
     *
     * `shipKey` is "brand/code" — the same identity the web layer stores — so the
     * brand goes into the path rather than relying on the `all` segment, which
     * works today but is not ours to depend on.
     */
    private static Integer fetchOffsetMinutes(String shipKey, String appKey) {
        String[] parts = shipKey.split("/");
        if (parts.length != 2) return null;

        HttpURLConnection conn = null;
        try {
            URL url = new URL(String.format(Locale.US,
                    "https://api.rccl.com/en/%s/mobile/v3/ships/%s/time", parts[0], parts[1]));
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("appkey", appKey);
            conn.setRequestProperty("accept", "application/json");
            conn.setRequestProperty("platform", "android");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);

            if (conn.getResponseCode() != 200) return null;

            StringBuilder body = new StringBuilder();
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[4096];
                int read;
                while ((read = in.read(buf)) != -1) body.append(new String(buf, 0, read, "UTF-8"));
            }

            JSONObject payload = new JSONObject(body.toString()).optJSONObject("payload");
            if (payload == null || !payload.has("utcTimezoneOffset")) return null;
            return (int) Math.round(payload.optDouble("utcTimezoneOffset") * 60);
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
