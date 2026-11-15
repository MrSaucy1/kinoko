package nl.kinoko.kinoko_music

import android.content.Context
import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// audio_service needs its own activity type so the Flutter engine is shared
// with the background playback service.
class MainActivity : AudioServiceActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // The Flutter side hands over what the home-screen widget should show.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kinoko/widget").setMethodCallHandler { call, result ->
            if (call.method == "update") {
                val editor = getSharedPreferences(NowPlayingWidget.PREFS, Context.MODE_PRIVATE).edit()
                val values = call.arguments as? Map<*, *>
                if (values != null) {
                    for ((key, value) in values) editor.putString(key.toString(), value?.toString() ?: "")
                }
                editor.apply()
                NowPlayingWidget.refresh(this)
                result.success(null)
            } else {
                result.notImplemented()
            }
        }
    }
}
