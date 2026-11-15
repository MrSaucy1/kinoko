import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../core/api.dart';

/// One downloaded (or downloading) film or episode.
class DownloadItem {
  final String id; // "<titleId>:<episodeId>"
  final Json meta; // title, subtitle, duration, markers, poster, titleId, episodeId, fileId, resolution, server
  int received;
  int total;
  String status; // queued | downloading | done | failed | paused
  String? error;

  DownloadItem({required this.id, required this.meta, this.received = 0, this.total = 0, this.status = 'queued', this.error});

  double get progress => total > 0 ? received / total : 0;
  String get fileName => '${id.replaceAll(':', '_')}.${meta['ext'] ?? 'mkv'}';

  Json toJson() => {'id': id, 'meta': meta, 'received': received, 'total': total, 'status': status == 'downloading' ? 'paused' : status, 'error': error};
  static DownloadItem fromJson(Json j) => DownloadItem(
        id: j['id'] as String,
        meta: (j['meta'] as Map).cast<String, dynamic>(),
        received: (j['received'] as num?)?.toInt() ?? 0,
        total: (j['total'] as num?)?.toInt() ?? 0,
        status: (j['status'] ?? 'paused') as String,
        error: j['error'] as String?,
      );
}

/// Downloads original files for offline viewing. Transfers resume where they
/// stopped (HTTP Range), so a dropped connection or a closed app costs nothing.
class Downloads extends ChangeNotifier {
  Downloads._();
  static final Downloads instance = Downloads._();

  final List<DownloadItem> items = [];
  late Directory _dir;
  final Map<String, http.Client> _active = {};
  DateTime _lastSave = DateTime.fromMillisecondsSinceEpoch(0);

  File get _index => File('${_dir.path}/index.json');
  File fileOf(DownloadItem d) => File('${_dir.path}/${d.fileName}');
  File posterOf(DownloadItem d) => File('${_dir.path}/${d.id.replaceAll(':', '_')}.jpg');
  DownloadItem? find(String id) => items.where((d) => d.id == id).firstOrNull;

  Future<void> load() async {
    final base = await getApplicationDocumentsDirectory();
    _dir = Directory('${base.path}/downloads');
    await _dir.create(recursive: true);
    if (await _index.exists()) {
      try {
        final list = jsonDecode(await _index.readAsString()) as List;
        items.addAll(list.map((e) => DownloadItem.fromJson((e as Map).cast<String, dynamic>())));
      } catch (_) {
        // A corrupt index only loses the list, not the app.
      }
    }
  }

  Future<void> _save() => _index.writeAsString(jsonEncode(items.map((d) => d.toJson()).toList()));

  /// Queues a download. [play] is the server's play response for the original file.
  Future<void> start({required Json meta, required Json play}) async {
    final id = '${meta['titleId']}:${meta['episodeId'] ?? 0}';
    var item = find(id);
    if (item == null) {
      item = DownloadItem(id: id, meta: {...meta, 'markers': play['markers'], 'duration': play['duration']});
      items.insert(0, item);
    }
    if (item.status == 'done' || _active.containsKey(id)) return;
    notifyListeners();
    // Artwork for the offline list.
    final poster = api.abs(meta['poster']);
    if (poster != null) {
      http.get(Uri.parse(poster)).then((r) {
        if (r.statusCode == 200) posterOf(item!).writeAsBytes(r.bodyBytes);
      }).catchError((_) {});
    }
    unawaited(_run(item, api.abs(play['download'])!));
  }

  /// Continues a paused or failed download; needs a fresh link from the server.
  Future<void> resume(DownloadItem item) async {
    if (_active.containsKey(item.id)) return;
    try {
      final play = await api.post('/api/play', {'fileId': item.meta['fileId'], 'quality': 'original', 'track': false});
      unawaited(_run(item, api.abs(play['download'])!));
    } catch (e) {
      item.status = 'failed';
      item.error = e.toString();
      notifyListeners();
    }
  }

  Future<void> _run(DownloadItem item, String url) async {
    final client = http.Client();
    _active[item.id] = client;
    item.status = 'downloading';
    item.error = null;
    notifyListeners();
    final file = fileOf(item);
    IOSink? sink;
    try {
      var offset = await file.exists() ? await file.length() : 0;
      final req = http.Request('GET', Uri.parse(url));
      if (offset > 0) req.headers['Range'] = 'bytes=$offset-';
      final res = await client.send(req);
      if (res.statusCode == 200) {
        offset = 0; // server ignored the range: start over
      } else if (res.statusCode != 206) {
        throw ApiException(res.statusCode, res.statusCode == 416 ? 'Bestand is op de server gewijzigd.' : 'Download geweigerd (${res.statusCode}).');
      }
      item.received = offset;
      item.total = offset + (res.contentLength ?? 0);
      sink = file.openWrite(mode: offset > 0 ? FileMode.append : FileMode.write);
      await for (final chunk in res.stream) {
        sink.add(chunk);
        item.received += chunk.length;
        final now = DateTime.now();
        if (now.difference(_lastSave).inMilliseconds > 500) {
          _lastSave = now;
          notifyListeners();
        }
      }
      await sink.flush();
      await sink.close();
      sink = null;
      item.status = item.total == 0 || item.received >= item.total ? 'done' : 'paused';
    } catch (e) {
      // Cancelled by pause() shows up here too; the partial file is kept for resuming.
      if (item.status == 'downloading') {
        item.status = 'failed';
        item.error = e is ApiException ? e.message : 'Verbinding verbroken.';
      }
    } finally {
      try {
        await sink?.close();
      } catch (_) {
        // The sink is already gone when the transfer was cancelled.
      }
      _active.remove(item.id)?.close();
      await _save();
      notifyListeners();
    }
  }

  void pause(DownloadItem item) {
    item.status = 'paused';
    _active.remove(item.id)?.close();
    notifyListeners();
  }

  Future<void> remove(DownloadItem item) async {
    item.status = 'paused';
    _active.remove(item.id)?.close();
    items.remove(item);
    for (final f in [fileOf(item), posterOf(item)]) {
      try {
        if (await f.exists()) await f.delete();
      } catch (_) {
        // Nothing useful to do if the file is already gone.
      }
    }
    await _save();
    notifyListeners();
  }
}
