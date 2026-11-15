import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:kinoko_core/api.dart';
import 'package:path_provider/path_provider.dart';

import 'models.dart';

/// Offline music: albums, playlists and the liked tracks the user chose to
/// keep on the device. Everything needed to browse and play them without the
/// server is in one local index file next to the audio.
class MusicDownloads extends ChangeNotifier {
  MusicDownloads._();
  static final instance = MusicDownloads._();

  late Directory _dir;
  bool _ready = false;

  /// trackId -> { track: the track as JSON, size: bytes }
  final Map<int, Json> _tracks = {};

  /// { kind: album|playlist|likes, id, name, cover, trackIds: [..] }
  final List<Json> collections = [];
  bool busy = false;
  String status = '';
  int _done = 0, _todo = 0;
  bool _again = false;

  String get progress => _todo > 0 ? '$_done van $_todo' : '';
  int get bytes => _tracks.values.fold(0, (s, t) => s + ((t['size'] as num?)?.toInt() ?? 0));
  int get count => _tracks.length;
  List<Track> get allTracks => [for (final t in _tracks.values) Track.fromJson(Map<String, dynamic>.from(t['track'] as Map))];

  File _file(int id) => File('${_dir.path}/$id.audio');
  File get _index => File('${_dir.path}/index.json');

  Future<void> load() async {
    _dir = await Directory('${(await getApplicationDocumentsDirectory()).path}/music').create(recursive: true);
    try {
      if (await _index.exists()) {
        final j = jsonDecode(await _index.readAsString()) as Json;
        for (final e in ((j['tracks'] as Map?) ?? const {}).entries) {
          final id = int.tryParse(e.key.toString());
          if (id != null && _file(id).existsSync()) _tracks[id] = Map<String, dynamic>.from(e.value as Map);
        }
        collections.addAll(listOf(j['collections']));
      }
    } catch (_) {
      // A damaged index: start clean; the audio files are found again on the next sync.
    }
    _ready = true;
  }

  Future<void> _save() => _index.writeAsString(jsonEncode({
        'tracks': {for (final e in _tracks.entries) '${e.key}': e.value},
        'collections': collections,
      }));

  /// Path of the downloaded copy, or null when the track is not on the device.
  String? pathOf(int id) => _ready && _tracks.containsKey(id) ? _file(id).path : null;
  bool has(String kind, int id) => collections.any((c) => c['kind'] == kind && c['id'] == id);
  List<Track> tracksOfCollection(Json c) => [for (final id in (c['trackIds'] as List? ?? const [])) if (_tracks[id] != null) Track.fromJson(Map<String, dynamic>.from(_tracks[id]!['track'] as Map))];

  Future<void> add(String kind, int id, String name, String? cover, List<Track> tracks) async {
    if (has(kind, id)) return;
    collections.add({'kind': kind, 'id': id, 'name': name, 'cover': cover, 'trackIds': [for (final t in tracks) t.id], 'meta': {for (final t in tracks) '${t.id}': t.toJson()}});
    await _save();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> remove(String kind, int id) async {
    collections.removeWhere((c) => c['kind'] == kind && c['id'] == id);
    await _cleanup();
    await _save();
    notifyListeners();
  }

  /// Deletes audio that no kept collection refers to any more.
  Future<void> _cleanup() async {
    final wanted = {for (final c in collections) ...(c['trackIds'] as List? ?? const []).cast<int>()};
    for (final id in _tracks.keys.toList()) {
      if (wanted.contains(id)) continue;
      _tracks.remove(id);
      try {
        await _file(id).delete();
      } catch (_) {
        // Already gone.
      }
    }
  }

  /// Follows the server: a playlist that changed gets its new tracks and loses the removed ones.
  Future<void> sync() async {
    if (!_ready || !api.signedIn || collections.isEmpty) return;
    for (final c in collections) {
      try {
        final List<Track> now;
        switch (c['kind']) {
          case 'album':
            now = tracksOf((await api.get('/api/music/albums/${c['id']}'))['items']);
          case 'playlist':
            final p = await api.get('/api/music/playlists/${c['id']}');
            now = tracksOf(p['items']);
            c['name'] = p['name'];
          default:
            now = tracksOf((await api.get('/api/music/likes?limit=200'))['items']);
        }
        c['trackIds'] = [for (final t in now) t.id];
        c['meta'] = {for (final t in now) '${t.id}': t.toJson()};
      } on ApiException catch (e) {
        // Gone on the server (404): keep what is on the device; the user decides.
        if (e.status == 0) return; // offline: nothing to sync against
      } catch (_) {
        return;
      }
    }
    await _cleanup();
    await _save();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> _pump() async {
    if (busy) {
      _again = true;
      return;
    }
    final missing = <int, Json>{};
    for (final c in collections) {
      final meta = (c['meta'] as Map?) ?? const {};
      for (final id in (c['trackIds'] as List? ?? const []).cast<int>()) {
        if (!_tracks.containsKey(id) && meta['$id'] != null) missing[id] = Map<String, dynamic>.from(meta['$id'] as Map);
      }
    }
    if (missing.isEmpty) {
      status = '';
      notifyListeners();
      return;
    }
    if (MusicPrefs.downloadWifiOnly && !Net.onWifi) {
      status = 'Wacht op wifi';
      notifyListeners();
      return;
    }
    busy = true;
    _done = 0;
    _todo = missing.length;
    status = 'Bezig met downloaden';
    notifyListeners();
    try {
      final limit = MusicPrefs.downloadLimitMb * 1024 * 1024;
      // One request for all links; they stay valid for a day.
      final r = await api.post('/api/music/play', {'trackIds': missing.keys.toList(), 'quality': MusicPrefs.downloadQuality, 'format': 'opus'});
      final urls = {for (final i in listOf(r['items'])) (i['id'] as num).toInt(): i['url'].toString()};
      final client = http.Client();
      try {
        for (final e in missing.entries) {
          if (MusicPrefs.downloadWifiOnly && !Net.onWifi) {
            status = 'Wacht op wifi';
            break;
          }
          if (limit > 0 && bytes >= limit) {
            status = 'Opslaglimiet bereikt';
            break;
          }
          final url = urls[e.key];
          if (url == null) continue;
          final part = File('${_file(e.key).path}.part');
          try {
            final res = await client.send(http.Request('GET', Uri.parse(api.abs(url)!))).timeout(const Duration(seconds: 30));
            if (res.statusCode != 200) continue;
            final sink = part.openWrite();
            await res.stream.pipe(sink);
            final size = await part.length();
            if (size == 0) continue;
            await part.rename(_file(e.key).path);
            _tracks[e.key] = {'track': e.value, 'size': size};
            _done++;
            await _save();
            notifyListeners();
          } catch (_) {
            try {
              await part.delete();
            } catch (_) {
              // Nothing was written.
            }
          }
        }
      } finally {
        client.close();
      }
      if (status == 'Bezig met downloaden') status = _done < _todo ? 'Niet alles kon worden gedownload' : '';
    } catch (e) {
      status = e is ApiException && e.status == 0 ? 'Geen verbinding' : 'Downloaden is mislukt';
    }
    busy = false;
    _todo = 0;
    notifyListeners();
    if (_again) {
      _again = false;
      unawaited(_pump());
    }
  }

  /// Network came back, or a setting changed: try what is still missing.
  void retry() => unawaited(_pump());

  Future<void> clearAll() async {
    collections.clear();
    await _cleanup();
    await _save();
    notifyListeners();
  }
}
