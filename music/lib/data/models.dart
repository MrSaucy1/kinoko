import 'package:audio_service/audio_service.dart';
import 'package:flutter/foundation.dart';
import 'package:kinoko_core/api.dart';

/// One song, as the server describes it.
class Track {
  final int id, artistId, albumId, trackNo;
  final String title, artist, album;
  final double duration;
  final String? cover;
  final bool explicit;
  final double? gainTrack, gainAlbum;

  /// Present when the track was loaded as part of a playlist.
  final int? itemId;

  const Track({required this.id, required this.title, required this.artist, required this.artistId, required this.album, required this.albumId, this.trackNo = 0, this.duration = 0, this.cover, this.explicit = false, this.gainTrack, this.gainAlbum, this.itemId});

  factory Track.fromJson(Json j) {
    final t = Track(
      id: (j['id'] as num).toInt(),
      title: (j['title'] ?? '').toString(),
      artist: (j['artist'] ?? '').toString(),
      artistId: (j['artistId'] as num?)?.toInt() ?? 0,
      album: (j['album'] ?? '').toString(),
      albumId: (j['albumId'] as num?)?.toInt() ?? 0,
      trackNo: (j['trackNo'] as num?)?.toInt() ?? 0,
      duration: numOf(j['duration']),
      cover: j['cover'] as String?,
      explicit: j['explicit'] == true,
      gainTrack: ((j['gain'] as Json?)?['track'] as num?)?.toDouble(),
      gainAlbum: ((j['gain'] as Json?)?['album'] as num?)?.toDouble(),
      itemId: (j['itemId'] as num?)?.toInt(),
    );
    if (j.containsKey('liked')) Likes.instance.seed(t.id, j['liked'] == true);
    return t;
  }

  Json toJson() => {'id': id, 'title': title, 'artist': artist, 'artistId': artistId, 'album': album, 'albumId': albumId, 'trackNo': trackNo, 'duration': duration, 'cover': cover, 'explicit': explicit, 'gain': {'track': gainTrack, 'album': gainAlbum}};

  /// What the system (notification, lock screen, Android Auto) shows.
  MediaItem toMediaItem() => MediaItem(
        id: '$id',
        title: title,
        artist: artist,
        album: album,
        duration: duration > 0 ? Duration(milliseconds: (duration * 1000).round()) : null,
        artUri: cover == null ? null : Uri.tryParse(api.abs(cover)!),
        extras: {'track': toJson()},
      );

  static Track? ofItem(MediaItem? item) {
    final j = item?.extras?['track'];
    return j is Map ? Track.fromJson(Map<String, dynamic>.from(j)) : null;
  }
}

List<Track> tracksOf(Object? list) => [for (final j in listOf(list)) Track.fromJson(j)];

/// Which tracks the user likes. Changes show at once; the server follows, and
/// a refusal puts the heart back.
class Likes extends ChangeNotifier {
  Likes._();
  static final instance = Likes._();
  final _liked = <int>{};

  bool has(int id) => _liked.contains(id);
  void seed(int id, bool liked) {
    if (liked ? _liked.add(id) : _liked.remove(id)) Future.microtask(notifyListeners);
  }

  Future<bool> toggle(int id) async {
    final now = !_liked.contains(id);
    now ? _liked.add(id) : _liked.remove(id);
    notifyListeners();
    try {
      if (now) {
        await api.put('/api/music/likes/$id');
      } else {
        await api.delete('/api/music/likes/$id');
      }
    } catch (_) {
      now ? _liked.remove(id) : _liked.add(id);
      notifyListeners();
      rethrow;
    }
    return now;
  }
}

/// User settings of the music app.
class MusicPrefs {
  static const qualities = {'original': 'Origineel', '320': 'Hoog (320 kbps)', '160': 'Normaal (160 kbps)', '96': 'Zuinig (96 kbps)'};
  static String _s(String k, String d) => api.prefs.getString(k) ?? d;

  /// Separate choices for wifi and for mobile data.
  static String get qualityWifi => _s('music_quality', 'original');
  static set qualityWifi(String v) => api.prefs.setString('music_quality', v);
  static String get qualityMobile => _s('music_quality_mobile', '160');
  static set qualityMobile(String v) => api.prefs.setString('music_quality_mobile', v);

  /// The quality to ask for right now.
  static String get quality => Net.onWifi ? qualityWifi : qualityMobile;

  /// Seconds of crossfade between tracks; 0 = off.
  static int get crossfade => (api.prefs.getInt('music_crossfade') ?? 0).clamp(0, 12);
  static set crossfade(int v) => api.prefs.setInt('music_crossfade', v.clamp(0, 12));

  /// Volume levelling: 'track', 'album' or 'off'.
  static String get normalize => _s('music_normalize', 'track');
  static set normalize(String v) => api.prefs.setString('music_normalize', v);

  /// Keep playing similar music when the queue runs out.
  static bool get autoplay => api.prefs.getBool('music_autoplay') ?? true;
  static set autoplay(bool v) => api.prefs.setBool('music_autoplay', v);

  static String get downloadQuality => _s('music_dl_quality', '320');
  static set downloadQuality(String v) => api.prefs.setString('music_dl_quality', v);
  static bool get downloadWifiOnly => api.prefs.getBool('music_dl_wifi') ?? true;
  static set downloadWifiOnly(bool v) => api.prefs.setBool('music_dl_wifi', v);

  /// Storage limit for downloads in MB; 0 = no limit.
  static int get downloadLimitMb => api.prefs.getInt('music_dl_limit') ?? 4096;
  static set downloadLimitMb(int v) => api.prefs.setInt('music_dl_limit', v);
}

/// Whether the device is on wifi (or cable) rather than mobile data. Kept up to date in main().
class Net {
  static bool onWifi = true;
  static final changed = ValueNotifier<int>(0);
}
