package ca.matthewcarroll.geotime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.TimeZone;

// Mirrors the web timezone list + GPS-derived local timezone into SharedPreferences
// for the home-screen widget, and reports the device OS timezone. Contract matches
// the iOS WidgetBridgePlugin.
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    static final String PREFS_NAME = "GeoTimeWidget";
    static final String PREFS_KEY = "worldClocks";
    static final String PREFS_LOCAL_TZ_KEY = "localTimezone";
    static final String PREFS_LOCAL_PLACE_KEY = "localPlaceName";
    static final String PREFS_ABOARD_SHIP_KEY = "aboardShipKey";
    static final String PREFS_LABELS_KEY = "worldClockLabels";
    static final String PREFS_SHIPS_KEY = "shipClocks";
    /**
     * The Royal Caribbean app key, mirrored here so the widget can refresh on
     * its own. An AppWidgetProvider cannot read the Capacitor config, and the
     * SharedPreferences file is already the channel for everything else the
     * widget needs.
     */
    static final String PREFS_APP_KEY = "rcclAppKey";

    @Override
    public void load() {
        // Mirror the key for the widget. Read from ShipTime's own config section
        // rather than duplicating the lookup — see capacitor.config.ts.
        String appKey = getBridge().getConfig()
                .getPluginConfiguration("ShipTime").getString("appKey", "");
        getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putString(PREFS_APP_KEY, appKey == null ? "" : appKey).apply();

        // Surface OS timezone changes to the web layer (mirrors iOS).
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject data = new JSObject();
                data.put("id", TimeZone.getDefault().getID());
                notifyListeners("deviceTimezoneChanged", data);
            }
        };
        getContext().registerReceiver(receiver, new IntentFilter(Intent.ACTION_TIMEZONE_CHANGED));
    }

    @PluginMethod
    public void setTimezones(PluginCall call) {
        JSArray timezones = call.getArray("timezones");
        if (timezones == null) {
            call.reject("timezones must be a string array");
            return;
        }
        JSArray labels = call.getArray("labels");
        // Ships cross as {key, name, offsetMinutes, fetchedAt} — never as a
        // timezone id. The provider builds a fixed-offset "GMT±HH:MM" zone from
        // the minutes, which is correct for a vessel: a crew-set clock has no
        // DST rules for a tzdb entry to describe.
        JSArray ships = call.getArray("ships");
        Context ctx = getContext();
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
           .edit()
           .putString(PREFS_KEY, timezones.toString()) // JSArray extends JSONArray => JSON text
           .putString(PREFS_LABELS_KEY, labels == null ? "[]" : labels.toString())
           .putString(PREFS_SHIPS_KEY, ships == null ? "[]" : ships.toString())
           .putString(PREFS_LOCAL_TZ_KEY, call.getString("localTimezone")) // may be null -> cleared
           .putString(PREFS_LOCAL_PLACE_KEY, call.getString("localPlaceName"))
           // Stored now so the provider has it the day its rules are ported;
           // GeoTimeWidgetProvider still measures everything from the ground.
           .putString(PREFS_ABOARD_SHIP_KEY, call.getString("aboardShipKey"))
           .apply();
        GeoTimeWidgetProvider.refreshAll(ctx);
        call.resolve();
    }

    @PluginMethod
    public void getDeviceTimezone(PluginCall call) {
        JSObject result = new JSObject();
        result.put("id", TimeZone.getDefault().getID());
        call.resolve(result);
    }
}
