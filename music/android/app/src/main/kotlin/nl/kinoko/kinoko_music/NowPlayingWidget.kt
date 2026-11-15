package nl.kinoko.kinoko_music

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.view.KeyEvent
import android.widget.RemoteViews

/**
 * The home-screen widget. What it shows comes from the Flutter side through
 * MainActivity, which stores the values and calls [refresh].
 */
class NowPlayingWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, build(context))
    }

    companion object {
        const val PREFS = "kinoko_widget"

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NowPlayingWidget::class.java))
            for (id in ids) manager.updateAppWidget(id, build(context))
        }

        /** A press on a widget button travels the same road as a headset button. */
        private fun mediaButton(context: Context, keyCode: Int, requestCode: Int): PendingIntent {
            val intent = Intent(Intent.ACTION_MEDIA_BUTTON)
            intent.component = ComponentName(context, "com.ryanheise.audioservice.MediaButtonReceiver")
            intent.putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
            return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        /** A small version of the picture: widgets may only carry little bitmap data. */
        private fun picture(path: String): Bitmap? {
            if (path.isEmpty()) return null
            return try {
                val bounds = BitmapFactory.Options()
                bounds.inJustDecodeBounds = true
                BitmapFactory.decodeFile(path, bounds)
                var sample = 1
                while (bounds.outWidth / sample > 320 || bounds.outHeight / sample > 320) sample *= 2
                val options = BitmapFactory.Options()
                options.inSampleSize = sample
                BitmapFactory.decodeFile(path, options)
            } catch (e: Exception) {
                null
            }
        }

        fun build(context: Context): RemoteViews {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val views = RemoteViews(context.packageName, R.layout.widget_now_playing)
            val title = prefs.getString("title", "") ?: ""
            views.setTextViewText(R.id.widget_title, if (title.isEmpty()) "Kinoko Music" else title)
            views.setTextViewText(R.id.widget_subtitle, prefs.getString("subtitle", "") ?: "")
            val cover = picture(prefs.getString("cover", "") ?: "")
            if (cover != null) views.setImageViewBitmap(R.id.widget_cover, cover) else views.setImageViewResource(R.id.widget_cover, R.mipmap.ic_launcher)
            // Tapping the widget opens the app.
            val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (open != null) {
                val pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widget_root, pending)
            }
            val playing = prefs.getString("playing", "") == "1"
            views.setImageViewResource(R.id.widget_play, if (playing) R.drawable.widget_pause else R.drawable.widget_play)
            views.setOnClickPendingIntent(R.id.widget_play, mediaButton(context, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 1))
            views.setOnClickPendingIntent(R.id.widget_next, mediaButton(context, KeyEvent.KEYCODE_MEDIA_NEXT, 2))
            return views
        }
    }
}
