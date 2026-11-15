package nl.kinoko.kinoko

import android.content.Context
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // The Flutter side hands over what the home-screen widget should show.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kinoko/widget").setMethodCallHandler { call, result ->
            if (call.method == "update") {
                val editor = getSharedPreferences(ContinueWidget.PREFS, Context.MODE_PRIVATE).edit()
                val values = call.arguments as? Map<*, *>
                if (values != null) {
                    for ((key, value) in values) editor.putString(key.toString(), value?.toString() ?: "")
                }
                editor.apply()
                ContinueWidget.refresh(this)
                result.success(null)
            } else {
                result.notImplemented()
            }
        }
    }
}
