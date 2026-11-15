import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/cast.dart';
import 'package:kinoko_core/events.dart';
import 'package:kinoko_core/theme.dart';
import 'package:kinoko_core/widgets.dart';

import '../data/downloads.dart';
import '../data/models.dart';
import '../player/handler.dart';
import '../widgets/common.dart';
import '../widgets/cover.dart';
import 'browse.dart';
import 'player.dart';

/// Hooks the features of this file into the player, the album/playlist pages and the settings.
void registerExtras() {
  playerExtras
    ..add((context, t) => TextButton.icon(onPressed: () => Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(builder: (_) => LyricsScreen(t))), icon: const Icon(Icons.lyrics_outlined, color: K.lilac), label: const Text('Tekst', style: TextStyle(color: K.lilac))))
    ..add((context, t) => TextButton.icon(onPressed: () => showDevices(context), icon: const Icon(Icons.speaker_group_outlined, color: K.lilac), label: const Text('Apparaten', style: TextStyle(color: K.lilac))));
  playerExtras.add((context, t) => IconButton(tooltip: 'Afspelen op…', icon: const Icon(Icons.cast_rounded, color: K.lilac), onPressed: () => showCastSheet(context, {'trackId': t.id, 'position': audio.position.inMilliseconds / 1000}, onStarted: audio.pause)));
  collectionExtras
    ..add((context, kind, id, tracks) => kind == 'artist' ? const SizedBox.shrink() : _DownloadButton(kind, id, tracks))
    ..add((context, kind, id, tracks) => kind == 'playlist'
        ? const SizedBox.shrink()
        : IconButton(tooltip: 'Start radio', icon: const Icon(Icons.radio_rounded), onPressed: () => attempt(context, () => kind == 'artist' ? audio.startRadio(artistId: id) : audio.startRadio(albumId: id))));
  settingsExtras.add((context, refresh) => _Settings(refresh));
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------
class LyricsScreen extends StatefulWidget {
  final Track track;
  const LyricsScreen(this.track, {super.key});
  @override
  State<LyricsScreen> createState() => _LyricsScreenState();
}

class _LyricsScreenState extends State<LyricsScreen> {
  late Future<Json> _future = api.get('/api/music/tracks/${widget.track.id}/lyrics');
  final _keys = <int, GlobalKey>{};
  StreamSubscription<Duration>? _sub;
  List<Json> _lines = [];
  int _at = -1;

  @override
  void initState() {
    super.initState();
    _sub = audio.positionStream.listen(_onPosition);
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _onPosition(Duration p) {
    if (_lines.isEmpty || audio.current?.id != widget.track.id) return;
    final s = p.inMilliseconds / 1000 + 0.2;
    var i = -1;
    for (var k = 0; k < _lines.length && numOf(_lines[k]['t']) <= s; k++) {
      i = k;
    }
    if (i == _at) return;
    setState(() => _at = i);
    // Keep the line being sung around the middle of the screen.
    final ctx = _keys[i]?.currentContext;
    if (ctx != null) Scrollable.ensureVisible(ctx, alignment: 0.4, duration: const Duration(milliseconds: 350), curve: K.ease);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.track.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800))),
      body: Loader<Json>(
        future: _future,
        onRetry: () => setState(() => _future = api.get('/api/music/tracks/${widget.track.id}/lyrics')),
        builder: (context, d) {
          _lines = listOf(d['lines']);
          final plain = (d['plain'] ?? '').toString();
          if (_lines.isEmpty && plain.isEmpty) {
            return const Center(child: Padding(padding: EdgeInsets.all(30), child: Text('Voor dit nummer is geen tekst gevonden.', textAlign: TextAlign.center, style: TextStyle(color: K.muted))));
          }
          if (_lines.isEmpty) {
            return SingleChildScrollView(padding: const EdgeInsets.fromLTRB(22, 10, 22, 40), child: Text(plain, style: const TextStyle(fontSize: 18, height: 1.6)));
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 30, 22, 240),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (var i = 0; i < _lines.length; i++)
                InkWell(
                  key: _keys[i] ??= GlobalKey(),
                  // Tap a line to jump there.
                  onTap: () => audio.seek(Duration(milliseconds: (numOf(_lines[i]['t']) * 1000).round())),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: AnimatedDefaultTextStyle(
                      duration: const Duration(milliseconds: 250),
                      style: TextStyle(fontSize: 22, height: 1.3, fontWeight: FontWeight.w800, color: i == _at ? K.text : (i < _at ? K.faint : K.muted)),
                      child: Text((_lines[i]['text'] ?? '').toString().isEmpty ? '♪' : _lines[i]['text'].toString()),
                    ),
                  ),
                ),
            ]),
          );
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Kinoko Connect
// ---------------------------------------------------------------------------
void showDevices(BuildContext context) {
  showModalBottomSheet<void>(context: context, useRootNavigator: true, isScrollControlled: true, builder: (_) => const _Devices());
}

class _Devices extends StatefulWidget {
  const _Devices();
  @override
  State<_Devices> createState() => _DevicesState();
}

class _DevicesState extends State<_Devices> {
  List<Json> _list = [];
  String? _error;
  bool _loading = true;
  StreamSubscription<Json>? _sub;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _load();
    // The server says when a device appears, disappears or changes what it plays.
    _sub = ServerEvents.instance.stream.where((m) => m['t'] == 'devices').listen((_) {
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 400), _load);
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await api.get('/api/music/devices');
      if (mounted) {
        setState(() {
          _list = listOf(d['devices']);
          _error = null;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _send(Json d, Json body) => attempt(context, () async => api.post('/api/music/devices/${d['id']}/command', body));

  /// Moves what plays here to the other device and pauses here.
  Future<void> _moveTo(Json d) async {
    final tracks = audio.tracks;
    if (tracks.isEmpty) return showMessage(context, 'Er speelt hier niets om over te zetten.');
    await _send(d, {'cmd': 'load', 'trackIds': [for (final t in tracks) t.id], 'index': audio.currentIndex ?? 0, 'position': audio.position.inMilliseconds / 1000, 'play': true});
    await audio.pause();
  }

  @override
  Widget build(BuildContext context) {
    final me = ServerEvents.instance.id;
    return SafeArea(
      child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(0, 16, 0, 16), children: [
        const Padding(padding: EdgeInsets.fromLTRB(18, 0, 18, 4), child: Text('Apparaten', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
        const Padding(padding: EdgeInsets.fromLTRB(18, 0, 18, 8), child: Text('Waar Kinoko Music of de web-speler open staat. Zet het afspelen over, of bedien het van hieraf.', style: TextStyle(color: K.muted, fontSize: 13))),
        if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(color: K.orchid))),
        if (_error != null) Padding(padding: const EdgeInsets.all(18), child: Text(_error!, style: const TextStyle(color: K.muted))),
        if (!_loading && _error == null && _list.where((d) => d['id'] != me).isEmpty) const Padding(padding: EdgeInsets.all(18), child: Text('Geen andere apparaten gevonden. Open Kinoko Music of de muziekpagina in de browser op een ander apparaat.', style: TextStyle(color: K.muted))),
        for (final d in _list)
          if (d['id'] == me)
            ListTile(leading: const Icon(Icons.smartphone_rounded, color: K.orchid), title: Text('${d['name']} (dit apparaat)', style: const TextStyle(fontWeight: FontWeight.w700)))
          else
            () {
              final s = d['state'] as Json?;
              final playing = s?['playing'] == true;
              return ListTile(
                leading: Icon((d['name'] ?? '').toString() == 'Web' ? Icons.computer_rounded : Icons.speaker_rounded, color: K.lilac),
                title: Text((d['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(s == null || (s['title'] ?? '').toString().isEmpty ? 'Speelt niets' : '${playing ? 'Speelt' : 'Gepauzeerd'}: ${s['title']} · ${s['artist']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (s != null && s['trackId'] != null) ...[
                    IconButton(tooltip: playing ? 'Pauzeren' : 'Afspelen', icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded), onPressed: () => _send(d, {'cmd': playing ? 'pause' : 'play'})),
                    IconButton(tooltip: 'Volgende', icon: const Icon(Icons.skip_next_rounded), onPressed: () => _send(d, {'cmd': 'next'})),
                  ],
                  IconButton(tooltip: 'Hier afspelen', icon: const Icon(Icons.cast_rounded, color: K.orchid), onPressed: () => _moveTo(d)),
                ]),
              );
            }(),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Offline downloads
// ---------------------------------------------------------------------------
class _DownloadButton extends StatelessWidget {
  final String kind;
  final int id;
  final List<Track> tracks;
  const _DownloadButton(this.kind, this.id, this.tracks);

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: MusicDownloads.instance,
        builder: (context, _) {
          final dl = MusicDownloads.instance, on = dl.has(kind, id);
          final complete = on && tracks.every((t) => dl.pathOf(t.id) != null);
          return IconButton(
            tooltip: on ? 'Download verwijderen' : 'Downloaden',
            icon: Icon(complete ? Icons.download_done_rounded : on ? Icons.downloading_rounded : Icons.download_rounded, color: on ? K.orchid : null),
            onPressed: tracks.isEmpty
                ? null
                : () async {
                    if (on) {
                      await dl.remove(kind, id);
                      if (context.mounted) showMessage(context, 'Download verwijderd');
                    } else {
                      final first = tracks.first;
                      await dl.add(kind, id, kind == 'album' ? first.album : 'Playlist', first.cover, tracks);
                      if (context.mounted) showMessage(context, MusicPrefs.downloadWifiOnly && !Net.onWifi ? 'Wordt gedownload zodra je op wifi zit' : 'Download gestart');
                      unawaited(dl.sync()); // picks up the real name of a playlist
                    }
                  },
          );
        },
      );
}

String _mb(int bytes) => bytes >= 1 << 30 ? '${(bytes / (1 << 30)).toStringAsFixed(1).replaceAll('.', ',')} GB' : '${(bytes / (1 << 20)).round()} MB';

/// Everything on the device. Works without the server.
class DownloadsTab extends StatelessWidget {
  const DownloadsTab({super.key});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: MusicDownloads.instance,
        builder: (context, _) {
          final dl = MusicDownloads.instance, all = dl.allTracks;
          final likes = dl.has('likes', 0);
          return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text('${dl.count} nummers · ${_mb(dl.bytes)}${dl.status.isEmpty ? '' : ' · ${dl.status}${dl.progress.isEmpty ? '' : ' (${dl.progress})'}'}', style: const TextStyle(color: K.muted, fontSize: 13)),
            ),
            SwitchListTile(
              value: likes,
              activeThumbColor: K.orchid,
              title: const Text('Gelikete nummers downloaden', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: const Text('Blijft vanzelf gelijk met wat je liket', style: TextStyle(color: K.muted, fontSize: 12.5)),
              onChanged: (v) async {
                if (!v) return dl.remove('likes', 0);
                await attempt(context, () async {
                  final tracks = tracksOf((await api.get('/api/music/likes?limit=200'))['items']);
                  await dl.add('likes', 0, 'Gelikete nummers', tracks.firstOrNull?.cover, tracks);
                });
              },
            ),
            if (all.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                child: Row(children: [
                  KButton('Alles afspelen', icon: Icons.play_arrow_rounded, primary: true, onTap: () => attempt(context, () => audio.playTracks(all))),
                  const SizedBox(width: 10),
                  KButton('Shuffle', icon: Icons.shuffle_rounded, onTap: () => attempt(context, () => audio.playTracks(List.of(all)..shuffle()))),
                ]),
              ),
            if (dl.collections.isEmpty) const Padding(padding: EdgeInsets.all(30), child: Text('Nog niets gedownload.\nOpen een album of playlist en tik op het download-icoon.', textAlign: TextAlign.center, style: TextStyle(color: K.muted))),
            for (final c in dl.collections)
              ListTile(
                leading: Cover(c['cover'] as String?, size: 52, radius: 8, fallback: c['kind'] == 'likes' ? Icons.favorite_rounded : c['kind'] == 'playlist' ? Icons.queue_music_rounded : Icons.album_rounded),
                title: Text((c['name'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('${dl.tracksOfCollection(c).length} van ${(c['trackIds'] as List? ?? const []).length} nummers op dit apparaat', style: const TextStyle(color: K.muted, fontSize: 12.5)),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => _OfflineCollection(c))),
                trailing: IconButton(tooltip: 'Download verwijderen', icon: const Icon(Icons.delete_outline_rounded, color: K.muted), onPressed: () => dl.remove(c['kind'].toString(), (c['id'] as num).toInt())),
              ),
          ]);
        },
      );
}

class _OfflineCollection extends StatelessWidget {
  final Json collection;
  const _OfflineCollection(this.collection);
  @override
  Widget build(BuildContext context) {
    final tracks = MusicDownloads.instance.tracksOfCollection(collection);
    return Scaffold(
      appBar: AppBar(title: Text((collection['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w800))),
      body: tracks.isEmpty
          ? const Center(child: Text('Nog niets hiervan staat op dit apparaat.', style: TextStyle(color: K.muted)))
          : ListView(padding: const EdgeInsets.only(bottom: 24), children: [for (var i = 0; i < tracks.length; i++) TrackTile(tracks[i], tracks, i)]),
    );
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
class _Settings extends StatefulWidget {
  final VoidCallback refresh;
  const _Settings(this.refresh);
  @override
  State<_Settings> createState() => _SettingsState();
}

class _SettingsState extends State<_Settings> {
  Json? _scrobble;
  final _lb = TextEditingController();
  String? _lastfmToken, _lastfmUrl;

  @override
  void initState() {
    super.initState();
    _loadScrobble();
  }

  Future<void> _loadScrobble() async {
    try {
      final s = await api.get('/api/music/scrobble');
      if (mounted) setState(() => _scrobble = s);
    } catch (_) {
      // Offline: the section simply stays hidden.
    }
  }

  Widget _title(String t, [String? sub]) => Padding(
        padding: const EdgeInsets.only(top: 22, bottom: 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(t, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)), if (sub != null) Text(sub, style: const TextStyle(color: K.muted, fontSize: 13))]),
      );

  Widget _quality(String label, String value, ValueChanged<String> set) => Row(children: [
        Expanded(child: Text(label)),
        DropdownButton<String>(
          value: value,
          dropdownColor: K.surface2,
          underline: const SizedBox.shrink(),
          items: [for (final e in MusicPrefs.qualities.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: (v) => setState(() => set(v ?? value)),
        ),
      ]);

  @override
  Widget build(BuildContext context) {
    final dl = MusicDownloads.instance, s = _scrobble;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _title('Geluidskwaliteit', 'Lager dan origineel wordt op de server omgezet naar Opus. Geldt vanaf het volgende nummer dat je start.'),
      _quality('Via wifi', MusicPrefs.qualityWifi, (v) => MusicPrefs.qualityWifi = v),
      _quality('Via mobiel netwerk', MusicPrefs.qualityMobile, (v) => MusicPrefs.qualityMobile = v),
      _title('Afspelen'),
      Row(children: [
        const Expanded(child: Text('Volume gelijktrekken')),
        DropdownButton<String>(
          value: MusicPrefs.normalize,
          dropdownColor: K.surface2,
          underline: const SizedBox.shrink(),
          items: const [DropdownMenuItem(value: 'track', child: Text('Per nummer')), DropdownMenuItem(value: 'album', child: Text('Per album')), DropdownMenuItem(value: 'off', child: Text('Uit'))],
          onChanged: (v) => setState(() => MusicPrefs.normalize = v ?? 'track'),
        ),
      ]),
      Row(children: [
        Expanded(child: Text(MusicPrefs.crossfade == 0 ? 'Overvloeien: uit' : 'Overvloeien: ${MusicPrefs.crossfade} s')),
        SizedBox(width: 190, child: Slider(value: MusicPrefs.crossfade.toDouble(), max: 12, divisions: 12, activeColor: K.orchid, onChanged: (v) => setState(() => MusicPrefs.crossfade = v.round()))),
      ]),
      const Text('Opeenvolgende nummers van één album blijven naadloos, zonder overvloeien.', style: TextStyle(color: K.muted, fontSize: 12.5)),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: MusicPrefs.autoplay, activeThumbColor: K.orchid, title: const Text('Doorspelen als de wachtrij op is'), subtitle: const Text('Met vergelijkbare muziek uit je bibliotheek', style: TextStyle(color: K.muted, fontSize: 12.5)), onChanged: (v) => setState(() => MusicPrefs.autoplay = v)),
      _title('Downloads', '${dl.count} nummers · ${_mb(dl.bytes)} op dit apparaat'),
      _quality('Kwaliteit van downloads', MusicPrefs.downloadQuality, (v) => MusicPrefs.downloadQuality = v),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: MusicPrefs.downloadWifiOnly,
        activeThumbColor: K.orchid,
        title: const Text('Alleen via wifi downloaden'),
        onChanged: (v) {
          setState(() => MusicPrefs.downloadWifiOnly = v);
          dl.retry();
        },
      ),
      Row(children: [
        const Expanded(child: Text('Opslaglimiet')),
        DropdownButton<int>(
          value: const [1024, 4096, 16384, 65536, 0].contains(MusicPrefs.downloadLimitMb) ? MusicPrefs.downloadLimitMb : 4096,
          dropdownColor: K.surface2,
          underline: const SizedBox.shrink(),
          items: const [DropdownMenuItem(value: 1024, child: Text('1 GB')), DropdownMenuItem(value: 4096, child: Text('4 GB')), DropdownMenuItem(value: 16384, child: Text('16 GB')), DropdownMenuItem(value: 65536, child: Text('64 GB')), DropdownMenuItem(value: 0, child: Text('Geen limiet'))],
          onChanged: (v) {
            setState(() => MusicPrefs.downloadLimitMb = v ?? 4096);
            dl.retry();
          },
        ),
      ]),
      if (dl.count > 0)
        TextButton(
          onPressed: () async {
            await dl.clearAll();
            if (mounted) setState(() {});
          },
          child: const Text('Alle downloads verwijderen', style: TextStyle(color: K.bad)),
        ),
      if (s != null) ...[
        _title('Scrobbelen', 'Laat wat je luistert bijhouden bij ListenBrainz of Last.fm. Staat uit tot je het zelf koppelt.'),
        if (s['listenbrainz'] == true)
          Row(children: [
            const Expanded(child: Text('ListenBrainz is gekoppeld')),
            TextButton(onPressed: () => attempt(context, () async => api.put('/api/music/scrobble/listenbrainz', {'token': ''})).then((_) => _loadScrobble()), child: const Text('Ontkoppelen', style: TextStyle(color: K.orchid))),
          ])
        else ...[
          TextField(controller: _lb, autocorrect: false, decoration: const InputDecoration(labelText: 'ListenBrainz-token', helperText: 'Te vinden op listenbrainz.org → Settings')),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(onPressed: () => attempt(context, () async => api.put('/api/music/scrobble/listenbrainz', {'token': _lb.text.trim()}), done: 'ListenBrainz gekoppeld').then((_) => _loadScrobble()), child: const Text('Koppelen', style: TextStyle(color: K.orchid))),
          ),
        ],
        if (s['lastfm'] == true)
          Row(children: [
            Expanded(child: Text('Last.fm is gekoppeld${(s['lastfmName'] ?? '').toString().isEmpty ? '' : ' als ${s['lastfmName']}'}')),
            TextButton(onPressed: () => attempt(context, () async => api.delete('/api/music/scrobble/lastfm')).then((_) => _loadScrobble()), child: const Text('Ontkoppelen', style: TextStyle(color: K.orchid))),
          ])
        else if (s['lastfmAvailable'] == true) ...[
          if (_lastfmUrl == null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => attempt(context, () async {
                  final r = await api.post('/api/music/scrobble/lastfm/start', const {});
                  setState(() {
                    _lastfmToken = r['token'].toString();
                    _lastfmUrl = r['url'].toString();
                  });
                }),
                child: const Text('Last.fm koppelen', style: TextStyle(color: K.orchid)),
              ),
            )
          else ...[
            const Text('Open deze link in je browser, geef Kinoko toestemming en kom hier terug:', style: TextStyle(color: K.muted, fontSize: 13)),
            SelectableText(_lastfmUrl!, style: const TextStyle(color: K.lilac, fontSize: 13)),
            Row(children: [
              TextButton(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _lastfmUrl!));
                  showMessage(context, 'Link gekopieerd');
                },
                child: const Text('Link kopiëren', style: TextStyle(color: K.orchid)),
              ),
              TextButton(
                onPressed: () => attempt(context, () async {
                  await api.post('/api/music/scrobble/lastfm/finish', {'token': _lastfmToken});
                  setState(() => _lastfmUrl = null);
                }, done: 'Last.fm gekoppeld').then((_) => _loadScrobble()),
                child: const Text('Ik heb toestemming gegeven', style: TextStyle(color: K.orchid)),
              ),
            ]),
          ],
        ],
      ],
    ]);
  }
}
