package nl.kinoko.kinoko_music

import com.ryanheise.audioservice.AudioServiceActivity

// audio_service needs its own activity type so the Flutter engine is shared
// with the background playback service.
class MainActivity : AudioServiceActivity()
