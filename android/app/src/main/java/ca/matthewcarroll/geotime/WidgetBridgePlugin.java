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
    static final String PREFS_DEVICE_TZ_AT_WRITE_KEY = "deviceTimezoneAtWrite";

    @Override
    public void load() {
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
        Context ctx = getContext();
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
           .edit()
           .putString(PREFS_KEY, timezones.toString()) // JSArray extends JSONArray => JSON text
           .putString(PREFS_LOCAL_TZ_KEY, call.getString("localTimezone")) // may be null -> cleared
           .putString(PREFS_LOCAL_PLACE_KEY, call.getString("localPlaceName"))
           // Stamp the OS zone this write happened under, so the widget can tell
           // when the stored GPS zone has since been overtaken by travel.
           .putString(PREFS_DEVICE_TZ_AT_WRITE_KEY, TimeZone.getDefault().getID())
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
