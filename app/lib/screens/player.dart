import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../services/downloads.dart';
import '../services/room.dart';
import '../widgets/common.dart';

/// What to play. Exactly one of: a library title, a room, a download, a channel.
class PlayRequest {
  final int? titleId;
  final int? episodeId;
  final int? fileId;
  final String quality;
  final double? resume;
  final String? roomCode;
  final String? guest;
  final DownloadItem? offline;
  final Json? channel;

  const PlayRequest({this.titleId, this.episodeId, this.fileId, this.quality = 'original', this.resume, this.roomCode, this.guest, this.offline, this.channel});
}

Future<void> openPlayer(BuildContext context, PlayRequest req) {
  return Navigator.of(context, rootNavigator: true).push(PageRouteBuilder(
    pageBuilder: (_, __, ___) => PlayerScreen(req),
    transitionsBuilder: (_, a, __, child) => FadeTransition(opacity: a, child: child),
    transitionDuration: const Duration(milliseconds: 320),
  ));
}

class PlayerScreen extends StatefulWidget {
  final PlayRequest req;
  const PlayerScreen(this.req, {super.key});
  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> with TickerProviderStateMixin {
  late final Player _player = Player(configuration: const PlayerConfiguration(title: 'Kinoko'));
  late final VideoController _video = VideoController(_player);
  final _subs = <StreamSubscription<dynamic>>[];
  final _rootFocus = FocusNode(debugLabel: 'player-root');
  final _playFocus = FocusNode(debugLabel: 'play-button');
  final _skipFocus = FocusNode(debugLabel: 'skip-intro');
  final _nextFocus = FocusNode(debugLabel: 'next-episode');

  // What is playing
  Json? _detail;
  List<Json> _episodes = [];
  Json? _episode;
  List<Json> _versions = [];
  int? _fileId;
  late String _quality = widget.req.quality;
  int _audio = 0;
  Json? _play;
  String _title = '';
  String _subtitle = '';

  // Playback state
  Duration _pos = Duration.zero;
  Duration _dur = Duration.zero;
  bool _playing = false;
  bool _buffering = true;
  bool _ready = false;
  String? _error;
  double? _dragging;

  // Overlay state
  bool _controls = true;
  Timer? _hideTimer;
  Timer? _progressTimer;
  bool _upNext = false;
  bool _upNextDismissed = false;
  late final AnimationController _countdown = AnimationController(vsync: this, duration: const Duration(seconds: 8));
  String? _toast;
  Timer? _toastTimer;
  String? _activeSubLabel;

  // Watch Together
  WatchRoom? _room;
  bool _roomPanel = false;
  final _chat = TextEditingController();
  final _reactions = <_Reaction>[];

  bool get _isLive => widget.req.channel != null;
  bool get _isOffline => widget.req.offline != null;
  bool get _isGuest => widget.req.guest != null;
  Json get _markers => (_play?['markers'] as Json?) ?? (widget.req.offline?.meta['markers'] as Json?) ?? const {};

  @override
  void initState() {
    super.initState();
    if (!Device.isTv) {
      SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    }
    _subs.addAll([
      _player.stream.position.listen(_onPosition),
      _player.stream.duration.listen((d) => setState(() => _dur = d)),
      _player.stream.playing.listen((p) => setState(() => _playing = p)),
      _player.stream.buffering.listen((b) => setState(() => _buffering = b)),
      _player.stream.completed.listen((done) {
        if (done) _onCompleted();
      }),
      _player.stream.error.listen((e) {
        if (_isLive && !_relayTried) {
          _liveFallback();
        } else if (mounted && (!_ready || (_isLive && _pos == Duration.zero))) {
          setState(() => _error = _isLive ? 'Deze zender geeft op dit moment geen beeld.' : 'Afspelen lukt niet: $e');
        }
      }),
    ]);
    _countdown.addStatusListener((s) {
      if (s == AnimationStatus.completed && _upNext) _goNext();
    });
    _progressTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_playing) _report();
    });
    _boot();
  }

  @override
  void dispose() {
    _report();
    _hideTimer?.cancel();
    _progressTimer?.cancel();
    _toastTimer?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    final session = _play?['sessionId'];
    if (session != null && _room == null) api.delete('/api/hls/$session').catchError((_) => <String, dynamic>{});
    _room?.dispose();
    _countdown.dispose();
    _player.dispose();
    _rootFocus.dispose();
    _playFocus.dispose();
    _skipFocus.dispose();
    _nextFocus.dispose();
    _chat.dispose();
    _liveWatch?.cancel();
    if (!Device.isTv) {
      SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    }
    super.dispose();
  }

  // ---------------------------------------------------------------- loading
  Future<void> _boot() async {
    final req = widget.req;
    try {
      if (_isLive) {
        _title = (req.channel!['name'] ?? '').toString();
        await _player.open(Media(api.abs(req.channel!['url'])!));
        // No picture straight from the provider: let the server relay it.
        _liveWatch = Timer(const Duration(seconds: 10), () {
          if (_pos == Duration.zero) _liveFallback();
        });
        _loadEpg();
      } else if (_isOffline) {
        final d = req.offline!;
        _title = (d.meta['title'] ?? '').toString();
        _subtitle = (d.meta['subtitle'] ?? '').toString();
        await _player.open(Media(Downloads.instance.fileOf(d).uri.toString(), start: _resumeAt(req.resume)));
      } else if (req.roomCode != null) {
        final info = await api.get('/api/watch/${req.roomCode}');
        _fileId = (info['fileId'] as num).toInt();
        _applyRoomInfo(info);
        if (!_isGuest && info['title'] != null) {
          try {
            await _loadDetail(((info['title'] as Json)['id'] as num).toInt(), (info['episode'] as Json?)?['id'] as int?);
          } catch (_) {
            // Room info alone is enough to watch along.
          }
        }
        await _load(position: 0, autoplay: false);
        _connectRoom(req.roomCode!);
      } else {
        await _loadDetail(req.titleId!, req.episodeId);
        _fileId = req.fileId ?? (_versions.isNotEmpty ? (_versions.first['fileId'] as num).toInt() : null);
        if (_fileId == null) throw ApiException(404, 'Er is geen afspeelbare versie van deze titel.');
        var start = req.resume;
        if (start == null) {
          final p = (_episode ?? _detail)?['progress'] as Json?;
          if (p != null && p['watched'] != true) start = numOf(p['position']);
        }
        await _load(position: start ?? 0);
      }
      if (mounted) setState(() => _ready = true);
      _wake();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  /// Second attempt for a channel: the server pulls it and hands us plain HLS.
  bool _relayTried = false;
  Timer? _liveWatch;
  Future<void> _liveFallback() async {
    if (_relayTried || !mounted) return;
    _relayTried = true;
    _liveWatch?.cancel();
    try {
      final r = await api.post('/api/iptv/${widget.req.channel!['id']}/live', const {});
      if (!mounted) return;
      await _player.open(Media(api.abs(r['url'])!));
      _liveWatch = Timer(const Duration(seconds: 20), () {
        if (mounted && _pos == Duration.zero) setState(() => _error = 'Deze zender geeft op dit moment geen beeld.');
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Duration _resumeAt(double? s) => Duration(milliseconds: ((s ?? 0) * 1000).round());

  Future<void> _loadDetail(int titleId, int? episodeId) async {
    final d = await api.get('/api/titles/$titleId');
    _detail = d;
    _title = (d['title'] ?? '').toString();
    if (d['kind'] == 'show') {
      _episodes = [for (final s in listOf(d['seasons'])) ...listOf(s['episodes'])];
      final want = episodeId ?? (d['nextUp'] as Json?)?['episodeId'];
      _episode = _episodes.where((e) => e['id'] == want).firstOrNull ?? _episodes.firstOrNull;
      _versions = listOf(_episode?['versions']);
      _describeEpisode();
    } else {
      _versions = listOf(d['versions']);
      _subtitle = d['year']?.toString() ?? '';
    }
  }

  void _describeEpisode() {
    final e = _episode;
    _subtitle = e == null ? '' : 'S${e['season']} · A${e['episode']} — ${e['name']}';
  }

  void _applyRoomInfo(Json info) {
    final t = info['title'] as Json?;
    final e = info['episode'] as Json?;
    if (t != null) _title = (t['title'] ?? '').toString();
    _subtitle = e != null ? 'S${e['season']} · A${e['episode']} — ${e['name']}' : (t?['year']?.toString() ?? '');
  }

  Future<void> _load({required double position, bool autoplay = true}) async {
    setState(() {
      _buffering = true;
      _upNext = false;
      _activeSubLabel = null;
    });
    _countdown.reset();
    final old = _play?['sessionId'];
    if (old != null && _room == null) api.delete('/api/hls/$old').catchError((_) => <String, dynamic>{});
    final body = {'fileId': _fileId, 'quality': _quality, 'audio': _audio, 'caps': 'any'};
    final req = widget.req;
    final play = _room != null || req.roomCode != null
        ? await api.post('/api/watch/${req.roomCode}/play', body, headers: {if (req.guest != null) 'x-guest': req.guest!})
        : await api.post('/api/play', body);
    _play = play;
    _fileId = (play['fileId'] as num).toInt();
    await _player.open(Media(api.abs(play['url'])!, start: _resumeAt(position)), play: autoplay);
    // Keep the viewer's subtitle language across episodes.
    final want = api.prefs.getString('sub_lang') ?? '';
    if (want.isNotEmpty) {
      final match = listOf(play['subtitles']).where((s) => s['lang'] == want).firstOrNull;
      if (match != null) _setServerSub(match, remember: false);
    } else {
      await _player.setSubtitleTrack(SubtitleTrack.no());
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadEpg() async {
    try {
      final r = await api.get('/api/iptv/${widget.req.channel!['id']}/epg');
      final p = listOf(r['programs']);
      if (p.isNotEmpty && mounted) setState(() => _subtitle = 'Nu: ${p[0]['title']}${p.length > 1 ? ' · Straks: ${p[1]['title']}' : ''}');
    } catch (_) {
      // No guide for this channel.
    }
  }

  // ---------------------------------------------------------------- events
  void _onPosition(Duration p) {
    if (!mounted) return;
    final t = p.inMilliseconds / 1000, d = _dur.inMilliseconds / 1000;
    final next = _nextEpisode();
    final credits = _markers['credits'] as Json?;
    final creditsAt = credits != null ? numOf(credits['start']) : d - 20;
    if (next != null && d > 60 && t >= creditsAt && !_upNext && !_upNextDismissed && _playing) {
      _upNext = true;
      _countdown.forward(from: 0);
      if (Device.isTv) WidgetsBinding.instance.addPostFrameCallback((_) => _nextFocus.requestFocus());
    } else if (_upNext && t < creditsAt - 2) {
      _upNext = false;
      _upNextDismissed = false;
      _countdown.reset();
    }
    final wasIntro = _inIntro;
    setState(() => _pos = p);
    if (!wasIntro && _inIntro && Device.isTv) WidgetsBinding.instance.addPostFrameCallback((_) => _skipFocus.requestFocus());
  }

  bool get _inIntro {
    final intro = _markers['intro'] as Json?;
    if (intro == null) return false;
    final t = _pos.inMilliseconds / 1000;
    return t >= numOf(intro['start']) && t < numOf(intro['end']) - 1;
  }

  void _onCompleted() {
    if (_isLive) return;
    _report(finished: true);
    if (_nextEpisode() != null) {
      _goNext();
    } else if (mounted) {
      Navigator.of(context).maybePop();
    }
  }

  Json? _nextEpisode() {
    final e = _episode;
    if (e == null || _isOffline) return null;
    final i = _episodes.indexWhere((x) => x['id'] == e['id']);
    return i >= 0 && i + 1 < _episodes.length ? _episodes[i + 1] : null;
  }

  Future<void> _goNext() async {
    final next = _nextEpisode();
    if (next == null) return;
    _report(finished: true);
    _countdown.stop();
    final versions = listOf(next['versions']);
    if (versions.isEmpty) return;
    setState(() {
      _episode = next;
      _versions = versions;
      _fileId = (versions.first['fileId'] as num).toInt();
      _quality = 'original';
      _upNext = false;
      _upNextDismissed = false;
      _describeEpisode();
    });
    if (_room != null) {
      _room!.load(_fileId!); // everyone, including us, follows the room's "load"
    } else {
      try {
        await _load(position: 0);
      } catch (e) {
        if (mounted) setState(() => _error = e.toString());
      }
    }
  }

  void _report({bool finished = false}) {
    if (_isLive || _isGuest || _pos == Duration.zero) return;
    final titleId = _detail?['id'] ?? widget.req.offline?.meta['titleId'];
    if (titleId == null) return;
    final episodeId = _episode?['id'] ?? widget.req.offline?.meta['episodeId'] ?? 0;
    api.post('/api/progress', {
      'titleId': titleId,
      'episodeId': episodeId,
      'position': _pos.inMilliseconds / 1000,
      'duration': _dur.inMilliseconds / 1000,
      if (finished) 'watched': true,
    }).catchError((_) => <String, dynamic>{}); // offline viewing: nothing to sync to
  }

  // ---------------------------------------------------------------- controls
  void _wake() {
    if (!_controls) {
      setState(() => _controls = true);
      if (Device.isTv) WidgetsBinding.instance.addPostFrameCallback((_) => _playFocus.requestFocus());
    }
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(seconds: 4), () {
      if (!mounted || !_playing || _roomPanel) return;
      setState(() => _controls = false);
      _rootFocus.requestFocus();
    });
  }

  double get _seconds => _pos.inMilliseconds / 1000;

  void _togglePlay() {
    if (_playing) {
      _player.pause();
      _room?.pause(_seconds);
    } else {
      _player.play();
      _room?.play(_seconds);
    }
    _wake();
  }

  void _seekTo(double seconds) {
    final max = math.max(0.0, _dur.inMilliseconds / 1000 - 1);
    final s = seconds.clamp(0.0, max).toDouble();
    _player.seek(Duration(milliseconds: (s * 1000).round()));
    _room?.seek(s);
    _wake();
  }

  void _flash(String text) {
    _toastTimer?.cancel();
    setState(() => _toast = text);
    _toastTimer = Timer(const Duration(milliseconds: 2400), () {
      if (mounted) setState(() => _toast = null);
    });
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.mediaPlayPause || key == LogicalKeyboardKey.mediaPlay || key == LogicalKeyboardKey.mediaPause || key == LogicalKeyboardKey.space) {
      _togglePlay();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.mediaFastForward) {
      _seekTo(_seconds + 30);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.mediaRewind) {
      _seekTo(_seconds - 30);
      return KeyEventResult.handled;
    }
    // With the controls hidden the D-pad drives playback directly.
    if (!_controls && !_isLive) {
      if (key == LogicalKeyboardKey.arrowLeft) {
        _seekTo(_seconds - 10);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.arrowRight) {
        _seekTo(_seconds + 10);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.select || key == LogicalKeyboardKey.enter) {
        _togglePlay();
        return KeyEventResult.handled;
      }
    }
    _wake();
    return KeyEventResult.ignored;
  }

  // ---------------------------------------------------------------- sheets
  Future<void> _sheet(String title, List<Widget> Function(BuildContext) children) {
    _hideTimer?.cancel();
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      constraints: BoxConstraints(maxWidth: 520, maxHeight: MediaQuery.sizeOf(context).height * 0.86),
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(12, 16, 12, 16), children: [
          Padding(padding: const EdgeInsets.fromLTRB(10, 0, 10, 8), child: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
          ...children(ctx),
        ]),
      ),
    ).whenComplete(_wake);
  }

  Widget _option(BuildContext ctx, String label, {String? trailing, bool selected = false, IconData? icon, required VoidCallback onTap, bool autofocus = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Tappable(
        autofocus: autofocus,
        radius: 10,
        focusScale: 1.02,
        onTap: () {
          Navigator.pop(ctx);
          onTap();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          decoration: BoxDecoration(color: selected ? K.violet.withValues(alpha: 0.18) : Colors.transparent, borderRadius: BorderRadius.circular(10)),
          child: Row(children: [
            if (icon != null) ...[Icon(icon, size: 20, color: K.muted), const SizedBox(width: 10)],
            Expanded(child: Text(label, style: TextStyle(fontWeight: selected ? FontWeight.w700 : FontWeight.w500, color: selected ? K.orchid : K.text))),
            if (trailing != null) Text(trailing, style: const TextStyle(color: K.faint, fontSize: 13)),
            if (selected) const Padding(padding: EdgeInsets.only(left: 8), child: Icon(Icons.check_rounded, color: K.orchid, size: 20)),
          ]),
        ),
      ),
    );
  }

  Widget _heading(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 14, 12, 4),
        child: Text(text.toUpperCase(), style: const TextStyle(fontSize: 11.5, letterSpacing: 1.2, color: K.faint, fontWeight: FontWeight.w700)),
      );

  void _setServerSub(Json s, {bool remember = true}) {
    _player.setSubtitleTrack(SubtitleTrack.uri(api.abs(s['url'])!, title: s['label']?.toString(), language: s['lang']?.toString()));
    _activeSubLabel = s['label']?.toString();
    if (remember) api.prefs.setString('sub_lang', (s['lang'] ?? '').toString());
  }

  void _openSubtitles() {
    final embedded = _player.state.tracks.subtitle.where((t) => t.id != 'auto' && t.id != 'no' && !t.uri).toList();
    final current = _player.state.track.subtitle;
    final server = _isOffline ? const <Json>[] : listOf(_play?['subtitles']);
    _sheet('Ondertitels', (ctx) => [
          _option(ctx, 'Uit', selected: current.id == 'no', autofocus: true, onTap: () {
            _player.setSubtitleTrack(SubtitleTrack.no());
            _activeSubLabel = null;
            api.prefs.setString('sub_lang', '');
          }),
          if (embedded.isNotEmpty) _heading('In het bestand'),
          for (final t in embedded)
            _option(ctx, [t.title, t.language].where((x) => x != null && x.isNotEmpty).join(' · ').ifEmpty('Spoor ${t.id}'), selected: current.id == t.id && !current.uri, onTap: () {
              _player.setSubtitleTrack(t);
              _activeSubLabel = null;
              if (t.language != null) api.prefs.setString('sub_lang', t.language!.length > 2 ? t.language!.substring(0, 2) : t.language!);
            }),
          if (server.isNotEmpty) _heading('Van de server'),
          for (final s in server) _option(ctx, s['label'].toString(), selected: _activeSubLabel == s['label'], onTap: () => setState(() => _setServerSub(s))),
          if (!_isOffline && !_isLive) ...[
            _heading('Meer'),
            _option(ctx, 'Online zoeken (Nederlands & Engels)', icon: Icons.travel_explore_rounded, onTap: _searchSubtitles),
          ],
        ]);
  }

  Future<void> _searchSubtitles() async {
    _flash('Ondertitels zoeken…');
    try {
      final r = await api.get('/api/files/$_fileId/subtitles/search?langs=nl,en');
      final results = listOf(r['results']);
      if (!mounted) return;
      if (results.isEmpty) return _flash('Geen ondertitels gevonden voor deze titel');
      _sheet('Gevonden ondertitels', (ctx) => [
            for (final s in results)
              _option(ctx, s['label'].toString(), icon: Icons.download_rounded, autofocus: s == results.first, onTap: () async {
                try {
                  final d = await api.post('/api/files/$_fileId/subtitles/download', {'url': s['url'], 'lang': s['lang']});
                  final sub = d['subtitle'] as Json;
                  (_play!['subtitles'] as List).add(sub);
                  if (mounted) setState(() => _setServerSub(sub));
                  _flash('Ondertitel toegevoegd');
                } catch (e) {
                  _flash(e.toString());
                }
              }),
          ]);
    } catch (e) {
      _flash(e.toString());
    }
  }

  void _openQuality() {
    final cur = _versions.where((v) => v['fileId'] == _fileId).firstOrNull ?? _versions.firstOrNull;
    final direct = _play?['mode'] == 'direct';
    final audioTracks = direct ? _player.state.tracks.audio.where((t) => t.id != 'auto' && t.id != 'no').toList() : const <AudioTrack>[];
    _sheet('Versie en kwaliteit', (ctx) => [
          if (_versions.length > 1 && !_isGuest) ...[
            _heading('Versie'),
            for (final v in _versions)
              _option(ctx, '${v['resolution']} · ${fmtBitrate(v['bitrate'] as num?)}${v['best'] == true ? '  ★ beste' : ''}', trailing: (v['server'] as Json)['name'].toString(), selected: v['fileId'] == _fileId, onTap: () {
                _fileId = (v['fileId'] as num).toInt();
                _quality = 'original';
                if (_room != null) {
                  _room!.load(_fileId!);
                } else {
                  _reload();
                }
              }),
          ],
          if (cur != null) ...[
            _heading('Kwaliteit'),
            for (final q in strings(cur['qualities']))
              _option(ctx, qualityLabels[q] ?? q, trailing: q == 'original' ? fmtBitrate(cur['bitrate'] as num?) : 'omgezet op de server', selected: (direct ? 'original' : _play?['quality']?.toString()) == q, autofocus: q == 'original', onTap: () {
                _quality = q;
                _reload();
              }),
          ],
          if (audioTracks.length > 1) ...[
            _heading('Audio'),
            for (final t in audioTracks)
              _option(ctx, [t.title, t.language].where((x) => x != null && x.isNotEmpty).join(' · ').ifEmpty('Spoor ${t.id}'), selected: _player.state.track.audio.id == t.id, onTap: () => _player.setAudioTrack(t)),
          ] else if (!direct && cur != null && listOf(cur['audio']).length > 1) ...[
            _heading('Audio'),
            for (final a in listOf(cur['audio']))
              _option(ctx, '${(a['lang'] ?? 'und').toString().toUpperCase()} · ${(a['codec'] ?? '').toString().toUpperCase()}', selected: a['index'] == _audio, onTap: () {
                _audio = (a['index'] as num).toInt();
                _reload();
              }),
          ],
          if (cur != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 14, 12, 0),
              child: Text('Bron: ${(cur['server'] as Json)['name']}${direct ? ' · direct afgespeeld' : ' · wordt live omgezet'}', style: const TextStyle(color: K.faint, fontSize: 12.5)),
            ),
        ]);
  }

  Future<void> _reload() async {
    try {
      await _load(position: _seconds);
    } catch (e) {
      _flash(e.toString());
    }
  }

  // ---------------------------------------------------------------- watch together
  void _connectRoom(String code) {
    final room = WatchRoom(code, guest: widget.req.guest);
    room.onState = (playing, position, by, action) {
      if ((_seconds - position).abs() > 1.5) _player.seek(Duration(milliseconds: (position * 1000).round()));
      if (playing) {
        _player.play();
      } else {
        _player.pause();
      }
      if (by != null) _flash('$by ${action == 'play' ? 'speelt af' : action == 'pause' ? 'pauzeert' : 'spoelt naar ${fmtTime(position)}'}');
    };
    room.onLoad = (info) async {
      _fileId = (info['fileId'] as num).toInt();
      _quality = 'original';
      final e = info['episode'] as Json?;
      if (e != null) {
        final known = _episodes.where((x) => x['id'] == e['id']).firstOrNull;
        if (known != null) {
          _episode = known;
          _versions = listOf(known['versions']);
        }
      }
      setState(() => _applyRoomInfo(info));
      try {
        await _load(position: 0, autoplay: false);
      } catch (err) {
        _flash(err.toString());
      }
    };
    room.onReaction = (emoji) {
      final r = _Reaction(emoji, 0.15 + math.Random().nextDouble() * 0.6, AnimationController(vsync: this, duration: const Duration(milliseconds: 2600)));
      setState(() => _reactions.add(r));
      r.anim.forward().whenComplete(() {
        r.anim.dispose();
        if (mounted) setState(() => _reactions.remove(r));
      });
    };
    room.addListener(() {
      if (mounted) setState(() {});
    });
    room.connect();
    setState(() => _room = room);
  }

  Future<void> _startRoom() async {
    if (_room != null) return setState(() => _roomPanel = !_roomPanel);
    try {
      final r = await api.post('/api/watch', {'fileId': _fileId, 'position': _seconds});
      if (!mounted) return;
      final code = r['code'] as String;
      // Re-open this screen inside the room so everyone shares one state.
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => PlayerScreen(PlayRequest(roomCode: code))));
    } catch (e) {
      _flash(e.toString());
    }
  }

  void _showInvite() {
    final code = _room!.code;
    final link = '${api.serverUrl}/w/$code';
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Nodig iemand uit'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Stuur de link, of laat de ander deze code invullen in de Kinoko-app bij Profiel → Samen kijken.', style: TextStyle(color: K.muted)),
          const SizedBox(height: 16),
          Center(child: Text(code, style: const TextStyle(fontSize: 38, fontWeight: FontWeight.w800, letterSpacing: 6))),
          const SizedBox(height: 12),
          SelectableText(link, style: const TextStyle(color: K.orchid, fontSize: 13)),
        ]),
        actions: [
          TextButton(
            autofocus: true,
            onPressed: () {
              Clipboard.setData(ClipboardData(text: link));
              Navigator.pop(ctx);
              _flash('Link gekopieerd');
            },
            child: const Text('Kopieer link'),
          ),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Sluiten')),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- build
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Focus(
        focusNode: _rootFocus,
        autofocus: true,
        onKeyEvent: _onKey,
        child: Row(children: [
          Expanded(
            child: Stack(fit: StackFit.expand, children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => _controls ? setState(() => _controls = false) : _wake(),
                onDoubleTapDown: _isLive
                    ? null
                    : (d) {
                        final left = d.localPosition.dx < MediaQuery.sizeOf(context).width / 2;
                        _seekTo(_seconds + (left ? -10 : 10));
                        _flash(left ? '−10 seconden' : '+10 seconden');
                      },
                onDoubleTap: () {},
                child: Video(controller: _video, controls: NoVideoControls, fill: Colors.black),
              ),
              if (_error != null) _errorView() else ...[
                if (_buffering || !_ready) const Center(child: SizedBox(width: 54, height: 54, child: CircularProgressIndicator(strokeWidth: 4, color: K.orchid))),
                IgnorePointer(
                  ignoring: !_controls,
                  child: AnimatedOpacity(opacity: _controls ? 1 : 0, duration: const Duration(milliseconds: 300), child: _controlsView()),
                ),
                if (_inIntro && !_isLive) _skipIntro(),
                if (_upNext) _upNextCard(),
                for (final r in _reactions) _reactionView(r),
                if (_toast != null)
                  Positioned(
                    top: 24,
                    left: 0,
                    right: 0,
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                        decoration: BoxDecoration(color: K.surface.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(99), border: Border.all(color: K.line)),
                        child: Text(_toast!, style: const TextStyle(fontSize: 13.5)),
                      ),
                    ),
                  ),
              ],
            ]),
          ),
          if (_room != null && _roomPanel) _roomPanelView(),
        ]),
      ),
    );
  }

  Widget _errorView() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.error_outline_rounded, size: 48, color: K.bad),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 18),
            KButton('Terug', autofocus: true, onTap: () => Navigator.of(context).maybePop()),
          ]),
        ),
      );

  Widget _controlsView() {
    final d = math.max(1.0, _dur.inMilliseconds / 1000);
    final value = (_dragging ?? _seconds).clamp(0.0, d).toDouble();
    final intro = _markers['intro'] as Json?;
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xCC000000), Colors.transparent, Colors.transparent, Color(0xE6000000)], stops: [0, 0.25, 0.6, 1])),
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: Device.isTv ? 40 : 14, vertical: Device.isTv ? 26 : 8),
          child: Column(children: [
            Row(children: [
              RoundIcon(Icons.arrow_back_rounded, tooltip: 'Terug', onTap: () => Navigator.of(context).maybePop()),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  if (_subtitle.isNotEmpty) Text(_subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 13.5)),
                ]),
              ),
              if (_room != null) ...[
                if (!_isGuest) RoundIcon(Icons.person_add_alt_1_rounded, tooltip: 'Uitnodigen', onTap: _showInvite),
                const SizedBox(width: 8),
                RoundIcon(Icons.forum_rounded, tooltip: 'Chat', active: _roomPanel, onTap: () => setState(() => _roomPanel = !_roomPanel)),
              ] else if (!_isLive && !_isOffline)
                RoundIcon(Icons.groups_rounded, tooltip: 'Samen kijken', onTap: _startRoom),
            ]),
            const Spacer(),
            if (!_isLive) ...[
              Row(children: [
                Text(fmtTime(value), style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()], fontSize: 13)),
                Expanded(
                  child: Stack(alignment: Alignment.center, children: [
                    if (intro != null)
                      Positioned.fill(
                        child: IgnorePointer(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 24),
                            child: LayoutBuilder(builder: (_, c) {
                              final from = (numOf(intro['start']) / d).clamp(0.0, 1.0), to = (numOf(intro['end']) / d).clamp(0.0, 1.0);
                              return Stack(children: [
                                Positioned(left: c.maxWidth * from, width: math.max(3, c.maxWidth * (to - from)), top: c.maxHeight / 2 - 2, height: 4, child: const ColoredBox(color: K.gold)),
                              ]);
                            }),
                          ),
                        ),
                      ),
                    SliderTheme(
                      data: SliderTheme.of(context).copyWith(trackHeight: 4, activeTrackColor: K.orchid, inactiveTrackColor: Colors.white24, thumbColor: Colors.white, overlayColor: K.violet.withValues(alpha: 0.3)),
                      child: ExcludeFocus(
                        child: Slider(
                          value: value,
                          max: d,
                          onChangeStart: (v) => _hideTimer?.cancel(),
                          onChanged: (v) => setState(() => _dragging = v),
                          onChangeEnd: (v) {
                            setState(() => _dragging = null);
                            _seekTo(v);
                          },
                        ),
                      ),
                    ),
                  ]),
                ),
                Text(fmtTime(d), style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()], fontSize: 13, color: K.muted)),
              ]),
              const SizedBox(height: 4),
            ],
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (!_isLive) ...[
                RoundIcon(Icons.replay_10_rounded, tooltip: '10 seconden terug', onTap: () => _seekTo(_seconds - 10)),
                const SizedBox(width: 14),
              ],
              Tappable(
                focusNode: _playFocus,
                onTap: _togglePlay,
                radius: 40,
                focusScale: 1.1,
                child: Container(
                  width: 64,
                  height: 64,
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: K.lilac),
                  child: Icon(_playing ? Icons.pause_rounded : Icons.play_arrow_rounded, size: 38, color: const Color(0xFF150B28)),
                ),
              ),
              if (!_isLive) ...[
                const SizedBox(width: 14),
                RoundIcon(Icons.forward_10_rounded, tooltip: '10 seconden vooruit', onTap: () => _seekTo(_seconds + 10)),
                if (_nextEpisode() != null) ...[const SizedBox(width: 14), RoundIcon(Icons.skip_next_rounded, tooltip: 'Volgende aflevering', onTap: _goNext)],
                const SizedBox(width: 28),
                RoundIcon(Icons.subtitles_rounded, tooltip: 'Ondertitels', onTap: _openSubtitles),
                if (!_isOffline) ...[const SizedBox(width: 14), RoundIcon(Icons.tune_rounded, tooltip: 'Versie en kwaliteit', onTap: _openQuality)],
              ],
            ]),
          ]),
        ),
      ),
    );
  }

  Widget _skipIntro() {
    final intro = _markers['intro'] as Json;
    return Positioned(
      right: Device.isTv ? 48 : 20,
      bottom: Device.isTv ? 150 : 110,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: const Duration(milliseconds: 380),
        curve: K.ease,
        builder: (_, v, child) => Opacity(opacity: v, child: Transform.translate(offset: Offset(30 * (1 - v), 0), child: child)),
        child: Tappable(
          focusNode: _skipFocus,
          radius: 14,
          onTap: () {
            _seekTo(numOf(intro['end']));
            _flash('Intro overgeslagen');
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            decoration: BoxDecoration(color: K.lilac, borderRadius: BorderRadius.circular(14)),
            child: const Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.fast_forward_rounded, color: Color(0xFF150B28)),
              SizedBox(width: 8),
              Text('Intro overslaan', style: TextStyle(color: Color(0xFF150B28), fontWeight: FontWeight.w800, fontSize: 15)),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _upNextCard() {
    final next = _nextEpisode();
    if (next == null) return const SizedBox.shrink();
    return Positioned(
      right: Device.isTv ? 48 : 20,
      bottom: Device.isTv ? 150 : 100,
      width: math.min(380, MediaQuery.sizeOf(context).width - 40),
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: const Duration(milliseconds: 600),
        curve: Curves.easeOutBack,
        builder: (_, v, child) => Opacity(opacity: v.clamp(0, 1).toDouble(), child: Transform.translate(offset: Offset(0, 40 * (1 - v)), child: Transform.scale(scale: 0.9 + 0.1 * v, alignment: Alignment.bottomRight, child: child))),
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(color: K.surface.withValues(alpha: 0.96), borderRadius: BorderRadius.circular(18), border: Border.all(color: K.line), boxShadow: const [BoxShadow(color: Colors.black87, blurRadius: 40)]),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (!Device.isTv || MediaQuery.sizeOf(context).height > 500) SizedBox(height: 96, width: double.infinity, child: NetImage(next['still'], alignment: Alignment.topCenter)),
            Padding(
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Tappable(
                  focusNode: _nextFocus,
                  onTap: _goNext,
                  radius: 40,
                  focusScale: 1.12,
                  child: SizedBox(
                    width: 58,
                    height: 58,
                    child: AnimatedBuilder(
                      animation: _countdown,
                      builder: (_, __) => CustomPaint(
                        painter: _RingPainter(_countdown.value),
                        child: Center(child: Text('${(8 * (1 - _countdown.value)).ceil()}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('VOLGENDE AFLEVERING', style: TextStyle(color: K.orchid, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
                    Text('S${next['season']} · A${next['episode']} — ${next['name']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Tappable(
                      radius: 8,
                      onTap: () => setState(() {
                        _upNext = false;
                        _upNextDismissed = true;
                        _countdown.reset();
                      }),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(color: K.surface3, borderRadius: BorderRadius.circular(8)),
                        child: const Text('Aftiteling bekijken', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                      ),
                    ),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _reactionView(_Reaction r) => AnimatedBuilder(
        animation: r.anim,
        builder: (context, _) {
          final size = MediaQuery.sizeOf(context);
          return Positioned(
            left: size.width * r.x,
            bottom: 100 + size.height * 0.45 * Curves.easeOut.transform(r.anim.value),
            child: Opacity(opacity: 1 - r.anim.value, child: Transform.scale(scale: 1 + r.anim.value * 0.5, child: Text(r.emoji, style: const TextStyle(fontSize: 44)))),
          );
        },
      );

  Widget _roomPanelView() {
    final room = _room!;
    return Container(
      width: math.min(320, MediaQuery.sizeOf(context).width * 0.42),
      color: const Color(0xFF0D0916),
      child: SafeArea(
        left: false,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [const Expanded(child: Text('Samen kijken', style: TextStyle(fontWeight: FontWeight.w800))), Badge2(room.code)]),
              const SizedBox(height: 10),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final m in room.members)
                  Container(
                    width: 30,
                    height: 30,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(gradient: K.gradient, borderRadius: BorderRadius.circular(9)),
                    child: Text((m['name'] ?? '?').toString().characters.first.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
                  ),
              ]),
            ]),
          ),
          const Divider(height: 1, color: K.line),
          Expanded(
            child: ListView(reverse: true, padding: const EdgeInsets.all(14), children: [
              for (final m in room.log.reversed)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: m.system
                      ? Text(m.text, textAlign: TextAlign.center, style: const TextStyle(color: K.faint, fontSize: 12.5))
                      : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(m.from, style: const TextStyle(color: K.orchid, fontSize: 12.5, fontWeight: FontWeight.w700)), Text(m.text)]),
                ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              for (final e in const ['😂', '😱', '😍', '👏', '🔥', '😢'])
                Tappable(radius: 10, focusScale: 1.2, onTap: () => room.react(e), child: Padding(padding: const EdgeInsets.all(6), child: Text(e, style: const TextStyle(fontSize: 22)))),
            ]),
          ),
          if (!Device.isTv)
            Padding(
              padding: const EdgeInsets.all(10),
              child: TextField(
                controller: _chat,
                textInputAction: TextInputAction.send,
                decoration: const InputDecoration(hintText: 'Bericht…', isDense: true),
                onSubmitted: (v) {
                  if (v.trim().isNotEmpty) room.chat(v.trim());
                  _chat.clear();
                },
              ),
            ),
        ]),
      ),
    );
  }
}

class _Reaction {
  final String emoji;
  final double x;
  final AnimationController anim;
  _Reaction(this.emoji, this.x, this.anim);
}

class _RingPainter extends CustomPainter {
  final double t;
  _RingPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero), r = size.width / 2 - 3;
    canvas.drawCircle(c, r, Paint()..style = PaintingStyle.stroke..strokeWidth = 4..color = Colors.white24);
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: r),
      -math.pi / 2,
      2 * math.pi * t,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round
        ..shader = const SweepGradient(colors: [Color(0xFFA855F7), Color(0xFFE879F9), Color(0xFFA855F7)]).createShader(Rect.fromCircle(center: c, radius: r)),
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter old) => old.t != t;
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}
