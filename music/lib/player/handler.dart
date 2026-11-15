import 'dart:async';
import 'dart:math' as math;

import 'package:audio_service/audio_service.dart';
import 'package:just_audio/just_audio.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/events.dart';
import 'package:kinoko_core/home_widget.dart';

import '../data/downloads.dart';
import '../data/models.dart';
import '../widgets/cover.dart';

/// The one audio handler of the app. Set in main() before the UI starts.
late KinokoAudioHandler audio;

/// Plays the queue with just_audio and tells the system about it through
/// audio_service: media notification, lock screen, headset and Bluetooth
/// buttons, and the browse tree and voice search of Android Auto.
class KinokoAudioHandler extends BaseAudioHandler with SeekHandler {
  final _player = AudioPlayer();
  List<Track> _tracks = [];
  Timer? _saveTimer, _tick;
  double _listened = 0;
  int? _playingId;
  bool _recovering = false;

  // Crossfade: a second player starts the next track underneath the end of this one.
  final _fader = AudioPlayer();
  final _uris = <int, Uri>{};
  Timer? _fadeTimer;
  int? _fadeTo;
  bool _radioBusy = false;
  Timer? _stateTimer;

  KinokoAudioHandler() {
    _player.playbackEventStream.listen((_) => _broadcast(), onError: (Object e, StackTrace st) => _recover());
    _player.playingStream.listen((_) => _broadcast());
    _player.shuffleModeEnabledStream.listen((_) => _broadcast());
    _player.loopModeStream.listen((_) => _broadcast());
    _player.currentIndexStream.listen(_onIndex);
    _player.processingStateStream.listen((s) {
      if (s == ProcessingState.completed) _onFinished();
    });
    // Count real listening time, so skipped tracks are not "plays".
    _tick = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (_player.playing && _player.processingState == ProcessingState.ready) _listened += 0.25;
      _maybeCrossfade();
    });
    // Kinoko Connect: tell the user's other devices what plays here, and do what they ask.
    ServerEvents.instance.stream.listen(_onRemote);
    _player.playingStream.listen((_) => _reportState());
    _stateTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_player.playing) _reportState();
    });
  }

  List<Track> get tracks => List.unmodifiable(_tracks);
  Track? get current => _player.currentIndex != null && _player.currentIndex! < _tracks.length ? _tracks[_player.currentIndex!] : null;
  Stream<Duration> get positionStream => _player.positionStream;
  Duration get position => _player.position;
  int? get currentIndex => _player.currentIndex;

  // ---------------------------------------------------------------- queue
  /// Asks the server for a playable address for every track (one request).
  Future<List<AudioSource>> _sources(List<Track> list) async {
    // Downloaded tracks play from the device; only the rest needs the server.
    final local = {for (final t in list) if (MusicDownloads.instance.pathOf(t.id) != null) t.id: Uri.file(MusicDownloads.instance.pathOf(t.id)!)};
    final remote = [for (final t in list) if (!local.containsKey(t.id)) t.id];
    var urls = <int, Uri>{};
    if (remote.isNotEmpty) {
      try {
        final r = await api.post('/api/music/play', {'trackIds': remote, 'quality': MusicPrefs.quality, 'format': 'opus'});
        urls = {for (final i in listOf(r['items'])) (i['id'] as num).toInt(): Uri.parse(api.abs(i['url'].toString())!)};
      } on ApiException catch (e) {
        // Offline with part of the list on the device: play that part.
        if (e.status != 0 || local.isEmpty) rethrow;
      }
    }
    final all = {...urls, ...local};
    // Tracks that are neither on the device nor offered by the server drop out of the queue.
    _pending = [for (final t in list) if (all.containsKey(t.id)) t];
    _uris.addAll(all);
    return [for (final t in _pending) AudioSource.uri(all[t.id]!, tag: t.toMediaItem())];
  }

  List<Track> _pending = [];

  /// Replaces the queue and starts at [index].
  Future<void> playTracks(List<Track> list, {int index = 0, Duration position = Duration.zero, bool autoplay = true}) async {
    if (list.isEmpty) return;
    _report();
    final wanted = list[index.clamp(0, list.length - 1)];
    _cancelFade();
    _uris.clear();
    final sources = await _sources(list);
    if (sources.isEmpty) throw ApiException(404, 'Deze nummers zijn niet (meer) beschikbaar.');
    _tracks = _pending;
    final at = _tracks.indexWhere((t) => t.id == wanted.id);
    queue.add([for (final t in _tracks) t.toMediaItem()]);
    await _player.setAudioSources(sources, initialIndex: at < 0 ? 0 : at, initialPosition: position);
    if (autoplay) unawaited(_player.play());
    _save();
  }

  Future<void> playNext(Track t) async {
    if (_tracks.isEmpty) return playTracks([t]);
    final at = (_player.currentIndex ?? -1) + 1;
    final s = await _sources([t]);
    if (s.isEmpty) return;
    _tracks.insert(at, t);
    await _player.insertAudioSource(at, s.first);
    _queueChanged();
  }

  Future<void> addToQueue(List<Track> list) async {
    if (_tracks.isEmpty) return playTracks(list);
    final s = await _sources(list);
    _tracks.addAll(_pending);
    await _player.addAudioSources(s);
    _queueChanged();
  }

  @override
  Future<void> removeQueueItemAt(int index) async {
    if (index < 0 || index >= _tracks.length) return;
    _tracks.removeAt(index);
    await _player.removeAudioSourceAt(index);
    _queueChanged();
  }

  Future<void> moveQueueItem(int from, int to) async {
    if (from == to || from < 0 || from >= _tracks.length) return;
    _tracks.insert(to.clamp(0, _tracks.length - 1), _tracks.removeAt(from));
    await _player.moveAudioSource(from, to.clamp(0, _tracks.length));
    _queueChanged();
  }

  void _queueChanged() {
    queue.add([for (final t in _tracks) t.toMediaItem()]);
    _broadcast();
    _save();
  }

  /// Remembers the queue on the server, so it is there again next time and on other devices.
  void _save() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(seconds: 2), () {
      if (!api.signedIn) return;
      api.put('/api/music/queue', {'trackIds': [for (final t in _tracks) t.id], 'index': _player.currentIndex ?? 0, 'position': _player.position.inMilliseconds / 1000}).catchError((_) => <String, dynamic>{});
    });
  }

  /// Brings back the queue from last time, paused.
  Future<void> restore() async {
    if (_tracks.isNotEmpty || !api.signedIn) return;
    try {
      final q = await api.get('/api/music/queue');
      final list = tracksOf(q['items']);
      if (list.isEmpty || _tracks.isNotEmpty) return;
      await playTracks(list, index: (q['index'] as num?)?.toInt() ?? 0, position: Duration(milliseconds: (numOf(q['position']) * 1000).round()), autoplay: false);
    } catch (_) {
      // No queue to restore; the app simply starts empty.
    }
  }

  // ---------------------------------------------------------------- playback
  @override
  Future<void> play() => _player.play();
  @override
  Future<void> pause() async {
    _cancelFade();
    await _player.pause();
    _save();
  }

  @override
  Future<void> seek(Duration position) {
    _cancelFade();
    return _player.seek(position);
  }
  @override
  Future<void> skipToQueueItem(int index) async {
    if (index < 0 || index >= _tracks.length) return;
    _cancelFade();
    await _player.seek(Duration.zero, index: index);
    unawaited(_player.play());
  }

  @override
  Future<void> skipToNext() {
    _cancelFade();
    return _player.seekToNext();
  }

  @override
  Future<void> skipToPrevious() async {
    _cancelFade();
    // Like every player: back first restarts the track, twice goes to the one before.
    if (_player.position > const Duration(seconds: 4) || !_player.hasPrevious) return _player.seek(Duration.zero);
    await _player.seekToPrevious();
  }

  @override
  Future<void> stop() async {
    _report();
    await _player.stop();
    return super.stop();
  }

  @override
  Future<void> setShuffleMode(AudioServiceShuffleMode shuffleMode) async {
    final on = shuffleMode != AudioServiceShuffleMode.none;
    if (on) await _player.shuffle();
    await _player.setShuffleModeEnabled(on);
  }

  @override
  Future<void> setRepeatMode(AudioServiceRepeatMode repeatMode) => _player.setLoopMode(switch (repeatMode) {
        AudioServiceRepeatMode.one => LoopMode.one,
        AudioServiceRepeatMode.all || AudioServiceRepeatMode.group => LoopMode.all,
        AudioServiceRepeatMode.none => LoopMode.off,
      });

  bool get shuffling => _player.shuffleModeEnabled;
  LoopMode get loopMode => _player.loopMode;

  void _onIndex(int? index) {
    final t = index != null && index < _tracks.length ? _tracks[index] : null;
    if (t?.id != _playingId) _report();
    _playingId = t?.id;
    mediaItem.add(t?.toMediaItem());
    if (_fadeTo != null && t != null && t.id == _fadeTo) {
      _handOver(t);
    } else {
      _cancelFade();
      _applyVolume();
    }
    _broadcast();
    _save();
    _reportState();
    if (index != null && index >= _tracks.length - 1) _continueWithRadio();
  }

  // ---------------------------------------------------------------- volume, crossfade
  /// Volume levelling from ReplayGain: every track (or album) at about the same loudness.
  /// A player cannot go above full volume, so tracks that would need a boost stay as they are.
  double _level(Track? t) {
    final mode = MusicPrefs.normalize;
    if (t == null || mode == 'off') return 1;
    final gain = mode == 'album' ? (t.gainAlbum ?? t.gainTrack) : (t.gainTrack ?? t.gainAlbum);
    if (gain == null) return 1;
    return math.pow(10, gain / 20).toDouble().clamp(0.05, 1.0);
  }

  void _applyVolume() => _player.setVolume(_level(current) * _remoteVolume);
  double _remoteVolume = 1;

  /// Called a few times a second: near the end of a track, start fading into the next.
  void _maybeCrossfade() {
    final seconds = MusicPrefs.crossfade;
    if (seconds <= 0 || _fadeTo != null || !_player.playing || _player.loopMode == LoopMode.one) return;
    final d = _player.duration, i = _player.currentIndex, n = _player.nextIndex;
    if (d == null || i == null || n == null || i >= _tracks.length || n >= _tracks.length) return;
    final left = d - _player.position;
    if (left > Duration(seconds: seconds) || left < const Duration(milliseconds: 800) || d < Duration(seconds: seconds * 3)) return;
    final a = _tracks[i], b = _tracks[n];
    // Consecutive tracks of one album belong together (live albums, classical): those stay gapless.
    if (a.albumId > 0 && a.albumId == b.albumId && b.trackNo == a.trackNo + 1) return;
    final uri = _uris[b.id];
    if (uri == null) return;
    _fadeTo = b.id;
    _startFade(a, b, uri, left);
  }

  Future<void> _startFade(Track a, Track b, Uri uri, Duration over) async {
    try {
      await _fader.setVolume(0);
      await _fader.setAudioSource(AudioSource.uri(uri));
      if (_fadeTo != b.id) return; // cancelled while loading
      unawaited(_fader.play());
    } catch (_) {
      _cancelFade();
      return;
    }
    final started = DateTime.now(), total = math.max(1, over.inMilliseconds);
    final from = _level(a) * _remoteVolume, to = _level(b) * _remoteVolume;
    _fadeTimer?.cancel();
    _fadeTimer = Timer.periodic(const Duration(milliseconds: 80), (t) {
      final k = (DateTime.now().difference(started).inMilliseconds / total).clamp(0.0, 1.0);
      _player.setVolume(from * (1 - k));
      _fader.setVolume(to * k);
      if (k >= 1) t.cancel();
    });
  }

  /// The main player has moved on to the track the fader is already playing: jump to the same spot and take over.
  Future<void> _handOver(Track t) async {
    _fadeTimer?.cancel();
    _fadeTo = null;
    try {
      await _player.setVolume(0);
      await _player.seek(_fader.position + const Duration(milliseconds: 120));
      await _player.setVolume(_level(t) * _remoteVolume);
    } catch (_) {
      _applyVolume();
    }
    await _fader.stop();
  }

  void _cancelFade() {
    if (_fadeTo == null && _fadeTimer == null) return;
    _fadeTimer?.cancel();
    _fadeTimer = null;
    _fadeTo = null;
    _fader.stop();
    _applyVolume();
  }

  // ---------------------------------------------------------------- radio
  /// Replaces the queue with music that goes with the given track, artist or album.
  Future<void> startRadio({Track? track, int? artistId, int? albumId}) async {
    final q = track != null ? 'track=${track.id}' : artistId != null ? 'artist=$artistId' : 'album=$albumId';
    final more = tracksOf((await api.get('/api/music/radio?$q&limit=40'))['items']);
    final list = [if (track != null) track, ...more];
    if (list.isEmpty) throw ApiException(404, 'Hier is geen radio voor te maken.');
    await playTracks(list);
  }

  /// The last track of the queue has started: line up similar music behind it.
  Future<void> _continueWithRadio() async {
    if (_radioBusy || !MusicPrefs.autoplay || _tracks.isEmpty || _player.loopMode != LoopMode.off || !api.signedIn) return;
    _radioBusy = true;
    try {
      final seeds = [for (final t in _tracks.reversed.take(5)) t.id].join(',');
      final r = await api.get('/api/music/radio?track=$seeds&exclude=${[for (final t in _tracks) t.id].join(',')}&limit=20');
      final more = tracksOf(r['items']);
      if (more.isNotEmpty) await addToQueue(more);
    } catch (_) {
      // No radio (offline, or nothing similar): the queue simply ends.
    }
    _radioBusy = false;
  }

  // ---------------------------------------------------------------- Kinoko Connect
  /// The home-screen widget shows what plays, with the cover from the on-disk cache.
  Future<void> _updateWidget() async {
    final t = current;
    final cover = t?.cover == null ? null : await CoverCache.get(api.abs(t!.cover)!);
    await HomeWidget.update({'title': t?.title ?? '', 'subtitle': t?.artist ?? '', 'playing': _player.playing ? '1' : '0', 'cover': cover?.path ?? ''});
  }

  void _reportState() {
    _updateWidget();
    final t = current;
    ServerEvents.instance.send({
      't': 'player',
      'state': {'trackId': t?.id, 'title': t?.title ?? '', 'artist': t?.artist ?? '', 'cover': t?.cover, 'playing': _player.playing, 'position': _player.position.inMilliseconds / 1000, 'duration': t?.duration ?? 0},
    });
  }

  Future<void> _onRemote(Json m) async {
    if (m['t'] != 'control') return;
    try {
      switch (m['cmd']) {
        case 'play':
          await play();
        case 'pause':
          await pause();
        case 'next':
          await skipToNext();
        case 'previous':
          await skipToPrevious();
        case 'seek':
          await seek(Duration(milliseconds: (numOf(m['position']) * 1000).round()));
        case 'volume':
          _remoteVolume = numOf(m['volume']).clamp(0.0, 1.0);
          _applyVolume();
        case 'load':
          await playTracks(tracksOf(m['items']), index: (m['index'] as num?)?.toInt() ?? 0, position: Duration(milliseconds: (numOf(m['position']) * 1000).round()), autoplay: m['play'] != false);
      }
    } catch (_) {
      // A command that cannot be carried out here is dropped.
    }
    _reportState();
  }

  void _onFinished() {
    _report();
    _player.pause();
    _player.seek(Duration.zero, index: 0);
  }

  /// Tells the server how long the previous track was really listened to.
  void _report() {
    final id = _playingId, seconds = _listened;
    _listened = 0;
    if (id == null || seconds < 5 || !api.signedIn) return;
    api.post('/api/music/plays', {'trackId': id, 'seconds': seconds.round()}).catchError((_) => <String, dynamic>{});
  }

  /// A stream that stops working (the day-long links ran out, the server
  /// restarted): fetch fresh links once and continue where we were.
  Future<void> _recover() async {
    if (_recovering || _tracks.isEmpty) return;
    _recovering = true;
    try {
      final index = _player.currentIndex ?? 0, position = _player.position, playing = _player.playing;
      await playTracks(List.of(_tracks), index: index, position: position, autoplay: playing);
    } catch (_) {
      // Still failing (offline): the UI shows the error state; the user can press play again.
    }
    await Future<void>.delayed(const Duration(seconds: 20));
    _recovering = false;
  }

  void _broadcast() {
    final playing = _player.playing;
    playbackState.add(playbackState.value.copyWith(
      controls: [MediaControl.skipToPrevious, if (playing) MediaControl.pause else MediaControl.play, MediaControl.skipToNext],
      systemActions: const {MediaAction.seek, MediaAction.seekForward, MediaAction.seekBackward, MediaAction.skipToQueueItem, MediaAction.playFromMediaId, MediaAction.playFromSearch, MediaAction.setShuffleMode, MediaAction.setRepeatMode},
      androidCompactActionIndices: const [0, 1, 2],
      processingState: switch (_player.processingState) {
        ProcessingState.idle => AudioProcessingState.idle,
        ProcessingState.loading => AudioProcessingState.loading,
        ProcessingState.buffering => AudioProcessingState.buffering,
        ProcessingState.ready => AudioProcessingState.ready,
        ProcessingState.completed => AudioProcessingState.completed,
      },
      playing: playing,
      updatePosition: _player.position,
      bufferedPosition: _player.bufferedPosition,
      speed: _player.speed,
      queueIndex: _player.currentIndex,
      shuffleMode: _player.shuffleModeEnabled ? AudioServiceShuffleMode.all : AudioServiceShuffleMode.none,
      repeatMode: switch (_player.loopMode) { LoopMode.one => AudioServiceRepeatMode.one, LoopMode.all => AudioServiceRepeatMode.all, LoopMode.off => AudioServiceRepeatMode.none },
    ));
  }

  /// Signing out: stop and forget everything.
  Future<void> clear() async {
    _report();
    _saveTimer?.cancel();
    _cancelFade();
    await _player.stop();
    await _player.clearAudioSources();
    _tracks = [];
    _playingId = null;
    queue.add(const []);
    mediaItem.add(null);
    _broadcast();
  }

  void disposePlayer() {
    _tick?.cancel();
    _saveTimer?.cancel();
    _stateTimer?.cancel();
    _fadeTimer?.cancel();
    _fader.dispose();
    _player.dispose();
  }

  // ---------------------------------------------------------------- Android Auto
  // The tree the car shows: Home/Recent, Playlists, Albums, Artists, Liked.
  // Ids: "home", "playlists", "albums", "artists", "likes", "album:12",
  // "artist:5", "playlist:3"; a playable track is "<context>|<trackId>" so
  // that playing it queues the rest of where it came from.
  static const _roots = [('home', 'Home'), ('playlists', 'Playlists'), ('albums', 'Albums'), ('artists', 'Artiesten'), ('likes', 'Gelikete nummers')];

  MediaItem _folder(String id, String title, {String? subtitle, String? art}) =>
      MediaItem(id: id, title: title, artist: subtitle, playable: false, artUri: art == null ? null : Uri.tryParse(api.abs(art)!));
  MediaItem _playable(String context, Track t) => t.toMediaItem().copyWith(id: '$context|${t.id}', playable: true);

  Future<List<Track>> _tracksOf(String context) async {
    final parts = context.split(':');
    switch (parts.first) {
      case 'album':
        return tracksOf((await api.get('/api/music/albums/${parts[1]}'))['items']);
      case 'playlist':
        return tracksOf((await api.get('/api/music/playlists/${parts[1]}'))['items']);
      case 'artist':
        return tracksOf((await api.get('/api/music/artists/${parts[1]}'))['topTracks']);
      case 'likes':
        return tracksOf((await api.get('/api/music/likes?limit=200'))['items']);
      case 'recent':
        return tracksOf((await api.get('/api/music/history?limit=50'))['items']);
      case 'search':
        return tracksOf((await api.get('/api/music/search?q=${Uri.encodeQueryComponent(parts.sublist(1).join(':'))}'))['tracks']);
      default:
        return const [];
    }
  }

  @override
  Future<List<MediaItem>> getChildren(String parentMediaId, [Map<String, dynamic>? options]) async {
    if (!api.signedIn) return const [];
    try {
      if (parentMediaId == AudioService.browsableRootId) return [for (final (id, title) in _roots) _folder(id, title)];
      if (parentMediaId == AudioService.recentRootId) {
        final t = current;
        return t == null ? const [] : [_playable('recent', t)];
      }
      switch (parentMediaId.split(':').first) {
        case 'home':
          final seen = <int>{};
          final recent = [for (final t in await _tracksOf('recent')) if (seen.add(t.id)) t];
          final albums = listOf((await api.get('/api/music/albums?sort=recent&limit=20'))['items']);
          return [for (final t in recent.take(15)) _playable('recent', t), for (final a in albums) _folder('album:${a['id']}', a['title'].toString(), subtitle: a['artist']?.toString(), art: a['cover'] as String?)];
        case 'playlists':
          return [for (final p in listOf((await api.get('/api/music/playlists'))['items'])) _folder('playlist:${p['id']}', p['name'].toString(), subtitle: '${p['count']} nummers', art: listOf2(p['covers']).firstOrNull as String?)];
        case 'albums':
          return [for (final a in listOf((await api.get('/api/music/albums?sort=artist&limit=200'))['items'])) _folder('album:${a['id']}', a['title'].toString(), subtitle: a['artist']?.toString(), art: a['cover'] as String?)];
        case 'artists':
          return [for (final a in listOf((await api.get('/api/music/artists?limit=200'))['items'])) _folder('artist:${a['id']}', a['name'].toString(), art: a['image'] as String?)];
        case 'artist':
          final a = await api.get('/api/music/artists/${parentMediaId.split(':')[1]}');
          return [for (final t in tracksOf(a['topTracks'])) _playable(parentMediaId, t), for (final al in listOf(a['albums'])) _folder('album:${al['id']}', al['title'].toString(), subtitle: al['year']?.toString(), art: al['cover'] as String?)];
        default:
          return [for (final t in await _tracksOf(parentMediaId)) _playable(parentMediaId, t)];
      }
    } catch (_) {
      return const [];
    }
  }

  @override
  Future<void> playFromMediaId(String mediaId, [Map<String, dynamic>? extras]) async {
    final cut = mediaId.lastIndexOf('|');
    if (cut < 0) return;
    final context = mediaId.substring(0, cut), id = int.tryParse(mediaId.substring(cut + 1));
    final list = await _tracksOf(context);
    final at = list.indexWhere((t) => t.id == id);
    if (at >= 0) await playTracks(list, index: at);
  }

  /// "Speel … af": what the voice assistant heard, as text.
  @override
  Future<void> playFromSearch(String query, [Map<String, dynamic>? extras]) async {
    final q = query.trim();
    // Nothing specific asked ("speel muziek"): carry on, or play what the user likes.
    if (q.isEmpty) {
      if (_tracks.isNotEmpty) return play();
      final liked = await _tracksOf('likes');
      return playTracks(liked.isNotEmpty ? (liked..shuffle()) : await _tracksOf('recent'));
    }
    final r = await api.get('/api/music/search?q=${Uri.encodeQueryComponent(q)}');
    final found = tracksOf(r['tracks']), albums = listOf(r['albums']), artists = listOf(r['artists']);
    // An artist or album by name plays that; otherwise the best matching songs.
    final lower = q.toLowerCase();
    if (artists.isNotEmpty && artists.first['name'].toString().toLowerCase() == lower) return playTracks(await _tracksOf('artist:${artists.first['id']}'));
    if (albums.isNotEmpty && albums.first['title'].toString().toLowerCase() == lower) return playTracks(await _tracksOf('album:${albums.first['id']}'));
    if (found.isNotEmpty) return playTracks(found);
    if (albums.isNotEmpty) return playTracks(await _tracksOf('album:${albums.first['id']}'));
    if (artists.isNotEmpty) return playTracks(await _tracksOf('artist:${artists.first['id']}'));
  }

  @override
  Future<List<MediaItem>> search(String query, [Map<String, dynamic>? extras]) async {
    if (!api.signedIn || query.trim().length < 2) return const [];
    try {
      return [for (final t in await _tracksOf('search:${query.trim()}')) _playable('search:${query.trim()}', t)];
    } catch (_) {
      return const [];
    }
  }
}

List<Object?> listOf2(Object? v) => v is List ? v : const [];
