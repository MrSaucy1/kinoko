package nl.kinoko.kinoko

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import androidx.tvprovider.media.tv.Channel
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat

/**
 * Rows on the Android TV home screen: "Verder kijken" and "Nieuw". The Flutter
 * side passes the titles; each card opens the title in the app (kinoko://title/ID).
 */
object TvHome {
    private const val PREFS = "kinoko_tv_home"

    fun update(context: Context, data: Map<*, *>) {
        try {
            publish(context, "continue", "Verder kijken", data["continue"] as? List<*>, true)
            publish(context, "recent", "Nieuw op Kinoko", data["recent"] as? List<*>, false)
        } catch (e: Exception) {
            // No TV provider on this device (or no permission): the app works without the rows.
        }
    }

    private fun publish(context: Context, key: String, name: String, items: List<*>?, first: Boolean) {
        if (items == null) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var channelId = prefs.getLong(key, -1L)
        if (channelId < 0) {
            val channel = Channel.Builder()
                .setType(TvContractCompat.Channels.TYPE_PREVIEW)
                .setDisplayName(name)
                .setAppLinkIntentUri(Uri.parse("kinoko://home"))
                .build()
            val uri = context.contentResolver.insert(TvContractCompat.Channels.CONTENT_URI, channel.toContentValues()) ?: return
            channelId = ContentUris.parseId(uri)
            prefs.edit().putLong(key, channelId).apply()
            // An app may show one row without asking; the other one the user adds under "Kanalen aanpassen".
            if (first) TvContractCompat.requestChannelBrowsable(context, channelId)
        }
        context.contentResolver.delete(TvContractCompat.buildPreviewProgramsUriForChannel(channelId), null, null)
        for (item in items) {
            val m = item as? Map<*, *> ?: continue
            val id = m["id"]?.toString() ?: continue
            val builder = PreviewProgram.Builder()
            builder.setChannelId(channelId)
            builder.setType(TvContractCompat.PreviewPrograms.TYPE_MOVIE)
            builder.setTitle(m["title"]?.toString() ?: "")
            builder.setDescription(m["subtitle"]?.toString() ?: "")
            builder.setInternalProviderId(id)
            builder.setIntentUri(Uri.parse("kinoko://title/$id"))
            val poster = m["poster"]?.toString() ?: ""
            if (poster.isNotEmpty()) {
                builder.setPosterArtUri(Uri.parse(poster))
                builder.setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_MOVIE_POSTER)
            }
            context.contentResolver.insert(TvContractCompat.PreviewPrograms.CONTENT_URI, builder.build().toContentValues())
        }
    }
}
