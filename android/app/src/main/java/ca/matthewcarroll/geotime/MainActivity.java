package ca.matthewcarroll.geotime;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must precede super.onCreate: BridgeActivity.onCreate ends with load(),
        // which builds the bridge and freezes the plugin list.
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
