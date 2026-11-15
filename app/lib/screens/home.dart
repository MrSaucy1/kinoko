import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:kinoko_core/home_widget.dart';
import 'package:path_provider/path_provider.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import '../widgets/trailer.dart';
import 'browse.dart';
import 'detail.dart';
import 'player.dart';
import 'watch_night.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _kind;
  late Future<Json> _future = _fetch();

  Future<Json> _fetch() async {
    final d = await api.get('/api/home${_kind != null ? '?kind=$_kind' : ''}');
    if (_kind == null && !Device.isTv) unawaited(_feedWidget(d));
    return d;
  }

  /// The home-screen widget shows what the "Verder kijken" row starts with.
  Future<void> _feedWidget(Json d) async {
    try {
      final row = listOf(d['rows']).where((r) => r['id'] == 'continue').firstOrNull;
      final c = listOf(row?['items']).firstOrNull;
      if (c == null) return HomeWidget.update(const {'title': '', 'subtitle': '', 'cover': ''});
      final r = c['resume'] as Json?;
      final sub = r != null && r['episodeId'] != null ? 'S${r['season']} · A${r['episode']} — verder kijken' : 'Verder kijken';
      final poster = api.abs(c['poster'] ?? c['backdrop']);
      final dir = await getApplicationCacheDirectory();
      final cover = await HomeWidget.picture(poster, File('${dir.path}/widget-${c['id']}.img'));
      await HomeWidget.update({'title': c['title'].toString(), 'subtitle': sub, 'cover': cover});
    } catch (_) {
      // The widget is a convenience; home works without it.
    }
  }
  void _reload() => setState(() => _future = _fetch());
  void _setKind(String? k) {
    _kind = k;
    _reload();
  }

  void _openItem(Json c) {
    final r = c['resume'] as Json?;
    if (c['kind'] == 'collection') {
      Navigator.push(context, MaterialPageRoute(builder: (_) => BrowseScreen.collection((c['id'] as num).toInt(), c['title'].toString())));
    } else if (r != null) {
      openPlayer(context, PlayRequest(titleId: (c['id'] as num).toInt(), episodeId: (r['episodeId'] as num?)?.toInt(), resume: numOf(r['position']))).then((_) => _reload());
    } else {
      openDetail(context, (c['id'] as num).toInt()).then((_) => _reload());
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Loader<Json>(
      future: _future,
      onRetry: _reload,
      builder: (context, data) {
        final rows = listOf(data['rows']);
        final hero = listOf(data['hero']);
        if (data['empty'] == true) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Mushroom(size: 84),
                const SizedBox(height: 18),
                const Text('Hier staat nog niets', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                Text('Voeg in het beheer van ${api.serverName} een bibliotheek toe (open ${api.serverUrl} in een browser).', textAlign: TextAlign.center, style: const TextStyle(color: K.muted)),
                const SizedBox(height: 18),
                KButton('Vernieuwen', icon: Icons.refresh_rounded, onTap: _reload, autofocus: Device.isTv),
              ]),
            ),
          );
        }
        return RefreshIndicator(
          color: K.orchid,
          onRefresh: () async => _reload(),
          child: ListView(padding: EdgeInsets.zero, children: [
            if (hero.isNotEmpty) _Hero(hero, onOpen: (t) => openDetail(context, (t['id'] as num).toInt()).then((_) => _reload()), onPlay: (t) => openPlayer(context, PlayRequest(titleId: (t['id'] as num).toInt())).then((_) => _reload())) else SizedBox(height: MediaQuery.paddingOf(context).top + 16),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: EdgeInsets.fromLTRB(pad, 14, pad, 18),
              child: Row(children: [
                Pill('Alles', selected: _kind == null, onTap: () => _setKind(null)),
                const SizedBox(width: 8),
                Pill('Films', selected: _kind == 'movie', onTap: () => _setKind('movie')),
                const SizedBox(width: 8),
                Pill('Series', selected: _kind == 'show', onTap: () => _setKind('show')),
                for (final g in strings(data['genres'])) ...[
                  const SizedBox(width: 8),
                  Pill(g, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowseScreen.genre(g, kind: _kind)))),
                ],
              ]),
            ),
            for (var i = 0; i < rows.length; i++) ...[
              Shelf(
                title: rows[i]['title'].toString(),
                onMore: rows[i]['genre'] != null ? () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowseScreen.genre(rows[i]['genre'].toString(), kind: _kind))) : null,
                children: [
                  for (final c in listOf(rows[i]['items']))
                    if (c['kind'] == 'collection')
                      CollectionCard(c, onTap: () => _openItem(c))
                    else if (rows[i]['style'] == 'wide')
                      WideCard(c, onTap: () => _openItem(c), onLongPress: () => openDetail(context, (c['id'] as num).toInt()).then((_) => _reload()))
                    else
                      PosterCard(c, onTap: () => _openItem(c)),
                ],
              ),
              if (i == 0 && _kind == null) _WatchNightTeaser(pad: pad),
            ],
            const SizedBox(height: 40),
          ]),
        );
      },
    );
  }
}

class _WatchNightTeaser extends StatelessWidget {
  final double pad;
  const _WatchNightTeaser({required this.pad});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(pad, 0, pad, 28),
      child: Tappable(
        radius: 20,
        focusScale: 1.02,
        onTap: () => openWatchNight(context),
        child: Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            gradient: const RadialGradient(center: Alignment.topLeft, radius: 2.4, colors: [Color(0xFF3B1D6E), Color(0xFF170D2C)]),
            border: Border.all(color: K.line),
          ),
          child: const Row(children: [
            Icon(Icons.casino_rounded, size: 44, color: K.lilac),
            SizedBox(width: 16),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Watch Night', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                Text('Laat het seizoen kiezen en dobbel voor drie films.', style: TextStyle(color: K.muted)),
              ]),
            ),
            Icon(Icons.chevron_right_rounded, color: K.orchid, size: 30),
          ]),
        ),
      ),
    );
  }
}

/// Auto-advancing featured banner with a slow zoom on the artwork.
class _Hero extends StatefulWidget {
  final List<Json> items;
  final ValueChanged<Json> onOpen;
  final ValueChanged<Json> onPlay;
  const _Hero(this.items, {required this.onOpen, required this.onPlay});
  @override
  State<_Hero> createState() => _HeroState();
}

class _HeroState extends State<_Hero> with SingleTickerProviderStateMixin {
  int _index = 0;
  Timer? _timer;
  late final AnimationController _zoom = AnimationController(vsync: this, duration: const Duration(seconds: 9))..forward();

  @override
  void initState() {
    super.initState();
    _rotate();
  }

  void _next() {
    setState(() => _index = (_index + 1) % widget.items.length);
    _zoom.forward(from: 0);
  }

  void _rotate() {
    _timer?.cancel();
    if (widget.items.length > 1) _timer = Timer.periodic(const Duration(seconds: 9), (_) => _next());
  }

  /// A playing trailer holds the carousel; when it is over the next title follows.
  void _onTrailer(bool active) {
    if (!mounted) return;
    if (active) {
      _timer?.cancel();
    } else {
      if (widget.items.length > 1 && (ModalRoute.of(context)?.isCurrent ?? true)) _next();
      _rotate();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _zoom.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final t = widget.items[_index % widget.items.length];
    final height = Device.isTv ? size.height * 0.68 : (size.height * 0.62).clamp(380.0, 620.0);
    final pad = Device.isTv ? 48.0 : 16.0;
    final rating = t['rating'] as num?;
    final meta = [if (t['year'] != null) '${t['year']}', fmtRuntime(t['runtime'] as num?), ...strings(t['genres']).take(2)].where((s) => s.isNotEmpty).join('  ·  ');
    return SizedBox(
      height: height,
      child: Stack(fit: StackFit.expand, children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 900),
          child: AnimatedBuilder(
            key: ValueKey(t['id']),
            animation: _zoom,
            builder: (_, child) => Transform.scale(scale: 1.03 + 0.09 * _zoom.value, child: child),
            child: SizedBox.expand(child: NetImage(Device.isTv ? t['backdrop'] : (t['poster'] ?? t['backdrop']), alignment: Alignment.topCenter)),
          ),
        ),
        // Tv only: on a phone the hero is a portrait poster, a trailer would be cropped to a sliver.
        if (Device.isTv) TrailerBackdrop(key: ValueKey('trailer-${t['id']}'), trailer: t['trailer'] as String?, onActive: _onTrailer, child: const SizedBox.shrink()),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [K.bg.withValues(alpha: 0.55), Colors.transparent, K.bg.withValues(alpha: 0.75), K.bg], stops: const [0, 0.3, 0.72, 1]),
          ),
        ),
        if (Device.isTv) const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: [K.bg, Colors.transparent], stops: [0.05, 0.62]))),
        Positioned(
          left: pad,
          right: Device.isTv ? size.width * 0.45 : pad,
          bottom: 14,
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 500),
            transitionBuilder: (c, a) => FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: const Offset(0, 0.12), end: Offset.zero).animate(a), child: c)),
            child: Column(
              key: ValueKey(t['id']),
              crossAxisAlignment: Device.isTv ? CrossAxisAlignment.start : CrossAxisAlignment.center,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(t['title'].toString(), textAlign: Device.isTv ? TextAlign.start : TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Device.isTv ? 46 : 32, fontWeight: FontWeight.w900, letterSpacing: -1, height: 1.02, shadows: const [Shadow(blurRadius: 30)])),
                const SizedBox(height: 10),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  if (rating != null) ...[const Icon(Icons.star_rounded, color: K.gold, size: 18), Text(' ${rating.toStringAsFixed(1)}   ', style: const TextStyle(fontWeight: FontWeight.w700))],
                  Flexible(child: Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w600))),
                ]),
                if (Device.isTv) ...[
                  const SizedBox(height: 12),
                  Text((t['overview'] ?? '').toString(), maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xFFD9CFEE), fontSize: 16, height: 1.45)),
                ],
                const SizedBox(height: 16),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  KButton('Afspelen', icon: Icons.play_arrow_rounded, light: true, autofocus: Device.isTv, onTap: () => widget.onPlay(t)),
                  const SizedBox(width: 10),
                  KButton('Meer info', icon: Icons.info_outline_rounded, onTap: () => widget.onOpen(t)),
                ]),
              ],
            ),
          ),
        ),
      ]),
    );
  }
}
