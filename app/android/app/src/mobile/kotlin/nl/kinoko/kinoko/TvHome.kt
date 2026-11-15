package nl.kinoko.kinoko

import android.content.Context

/** The phone app has no TV home screen; the TV variant has the real one. */
object TvHome {
    fun update(context: Context, data: Map<*, *>) {
        // Nothing to do on a phone.
    }
}
