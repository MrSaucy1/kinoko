package nl.kinoko.kinoko

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.widget.RemoteViews

/**
 * The home-screen widget. What it shows comes from the Flutter side through
 * MainActivity, which stores the values and calls [refresh].
 */
class ContinueWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, build(context))
    }

    companion object {
        const val PREFS = "kinoko_widget"

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, ContinueWidget::class.java))
            for (id in ids) manager.updateAppWidget(id, build(context))
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
            val views = RemoteViews(context.packageName, R.layout.widget_continue)
            val title = prefs.getString("title", "") ?: ""
            views.setTextViewText(R.id.widget_title, if (title.isEmpty()) "Kinoko" else title)
            views.setTextViewText(R.id.widget_subtitle, prefs.getString("subtitle", "") ?: "")
            val cover = picture(prefs.getString("cover", "") ?: "")
            if (cover != null) views.setImageViewBitmap(R.id.widget_cover, cover) else views.setImageViewResource(R.id.widget_cover, R.mipmap.ic_launcher)
            // Tapping the widget opens the app.
            val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (open != null) {
                val pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widget_root, pending)
                views.setOnClickPendingIntent(R.id.widget_play, pending)
            }
            return views
        }
    }
}
