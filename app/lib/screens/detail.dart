import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../services/downloads.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import '../widgets/trailer.dart';
import 'browse.dart';
import 'player.dart';

Future<void> openDetail(BuildContext context, int id) => Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen(id)));

class DetailScreen extends StatefulWidget {
  final int id;
  const DetailScreen(this.id, {super.key});
  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen> {
  late Future<Json> _future = api.get('/api/titles/${widget.id}');
  int? _fileId;
  String _quality = 'original';
  int? _season;

  void _reload() => setState(() => _future = api.get('/api/titles/${widget.id}'));

  Future<void> _play(Json d, {Json? episode, double? resume}) async {
    await openPlayer(context, PlayRequest(titleId: widget.id, episodeId: (episode?['id'] as num?)?.toInt(), fileId: episode == null ? _fileId : null, quality: episode == null ? _quality : 'original', resume: resume));
    if (mounted) _reload();
  }

  Future<void> _together(int fileId) async {
    try {
      final r = await api.post('/api/watch', {'fileId': fileId});
      if (mounted) await openPlayer(context, PlayRequest(roomCode: r['code'] as String));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _download(Json d, Json version, {Json? episode}) async {
    try {
      final play = await api.post('/api/play', {'fileId': version['fileId'], 'quality': 'original'});
      await Downloads.instance.start(play: play, meta: {
        'titleId': d['id'],
        'episodeId': episode?['id'] ?? 0,
        'fileId': version['fileId'],
        'title': d['title'],
        'subtitle': episode != null ? 'S${episode['season']} · A${episode['episode']} — ${episode['name']}' : (d['year']?.toString() ?? ''),
        'poster': d['poster'],
        'resolution': version['resolution'],
        'size': version['size'],
        'server': (version['server'] as Json)['name'],
        'ext': version['container'] == 'mp4' ? 'mp4' : 'mkv',
      });
      if (mounted) showMessage(context, 'Download gestart — te vinden onder Downloads');
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _toggleList(Json d) async {
    try {
      final r = d['inList'] == true ? await api.delete('/api/mylist/${d['id']}') : await api.put('/api/mylist/${d['id']}');
      setState(() => d['inList'] = r['inList']);
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Loader<Json>(future: _future, onRetry: _reload, builder: (context, d) => _body(d)),
    );
  }

  Widget _body(Json d) {
    final size = MediaQuery.sizeOf(context);
    final pad = Device.isTv ? 48.0 : 16.0;
    final isMovie = d['kind'] == 'movie';
    final versions = listOf(d['versions']);
    _fileId ??= versions.isNotEmpty ? (versions.first['fileId'] as num).toInt() : null;
    final seasons = listOf(d['seasons']);
    final allEps = [for (final s in seasons) ...listOf(s['episodes'])];
    final nextId = (d['nextUp'] as Json?)?['episodeId'];
    final nextUp = allEps.where((e) => e['id'] == nextId).firstOrNull ?? allEps.firstOrNull;
    _season ??= (nextUp?['season'] as num?)?.toInt() ?? (seasons.isNotEmpty ? (seasons.first['season'] as num).toInt() : null);
    final progress = d['progress'] as Json?;
    final resume = progress != null && progress['watched'] != true && numOf(progress['position']) > 30 ? numOf(progress['position']) : 0.0;
    final rating = d['rating'] as num?;
    final cast = listOf(d['cast']);
    final similar = listOf(d['similar']);
    final collections = listOf(d['collections']);
    final curVersion = versions.where((v) => v['fileId'] == _fileId).firstOrNull ?? versions.firstOrNull;

    Widget section(String title, Widget child, {Widget? trailing}) => Padding(
          padding: EdgeInsets.fromLTRB(pad, 0, pad, 26),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)), const SizedBox(width: 10), if (trailing != null) trailing]),
            const SizedBox(height: 12),
            child,
          ]),
        );

    return ListView(padding: EdgeInsets.zero, children: [
      SizedBox(
        height: Device.isTv ? size.height * 0.6 : (size.width * 0.72).clamp(260.0, 420.0),
        child: Stack(fit: StackFit.expand, children: [
          TrailerBackdrop(
            trailer: d['trailer'] as String?,
            delay: const Duration(milliseconds: 1500),
            soundButton: Device.isTv ? null : Alignment.topRight,
            child: NetImage(d['backdrop'] ?? d['poster'], alignment: Alignment.topCenter),
          ),
          DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [K.bg.withValues(alpha: 0.4), Colors.transparent, K.bg], stops: const [0, 0.35, 1]))),
          if (!Device.isTv) Positioned(top: MediaQuery.paddingOf(context).top + 8, left: 10, child: RoundIcon(Icons.arrow_back_rounded, tooltip: 'Terug', onTap: () => Navigator.pop(context))),
          Positioned(
            left: pad,
            right: pad,
            bottom: 6,
            child: Text(d['title'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Device.isTv ? 44 : 30, fontWeight: FontWeight.w900, letterSpacing: -0.8, height: 1.05, shadows: const [Shadow(blurRadius: 24)])),
          ),
        ]),
      ),
      Padding(
        padding: EdgeInsets.fromLTRB(pad, 10, pad, 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (rating != null) Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.star_rounded, color: K.gold, size: 18), Text(' ${rating.toStringAsFixed(1)}', style: const TextStyle(fontWeight: FontWeight.w700))]),
            if (d['year'] != null) Text('${d['year']}', style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w600)),
            if (isMovie && d['runtime'] != null) Text(fmtRuntime(d['runtime'] as num?), style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w600)),
            if (!isMovie) Text('${seasons.length} seizoen${seasons.length == 1 ? '' : 'en'}', style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w600)),
            if (curVersion != null && isMovie) Badge2(curVersion['resolution'].toString()),
            for (final g in strings(d['genres']).take(3)) Badge2(g, color: K.muted),
          ]),
          const SizedBox(height: 16),
          if (resume > 0 && numOf(progress!['duration']) > 0) ...[
            ClipRRect(borderRadius: BorderRadius.circular(3), child: SizedBox(width: 220, child: LinearProgressIndicator(value: (resume / numOf(progress['duration'])).clamp(0, 1).toDouble(), minHeight: 4, color: K.orchid, backgroundColor: Colors.white24))),
            const SizedBox(height: 12),
          ],
          Wrap(spacing: 10, runSpacing: 10, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (isMovie && versions.isNotEmpty) KButton(resume > 0 ? 'Verder · ${fmtTime(resume)}' : 'Afspelen', icon: Icons.play_arrow_rounded, light: true, autofocus: Device.isTv, onTap: () => _play(d, resume: resume)),
            if (isMovie && resume > 0) KButton('Vanaf begin', onTap: () => _play(d, resume: 0)),
            if (!isMovie && nextUp != null) KButton('${numOf((nextUp['progress'] as Json?)?['position']) > 0 ? 'Verder' : 'Afspelen'} · S${nextUp['season']} A${nextUp['episode']}', icon: Icons.play_arrow_rounded, light: true, autofocus: Device.isTv, onTap: () => _play(d, episode: nextUp)),
            RoundIcon(d['inList'] == true ? Icons.check_rounded : Icons.add_rounded, tooltip: 'Mijn lijst', active: d['inList'] == true, onTap: () => _toggleList(d)),
            if (_fileId != null || nextUp != null)
              RoundIcon(Icons.groups_rounded, tooltip: 'Samen kijken', onTap: () => _together(isMovie ? _fileId! : (listOf(nextUp!['versions']).first['fileId'] as num).toInt())),
            if (isMovie && curVersion != null && !Device.isTv) RoundIcon(Icons.download_rounded, tooltip: 'Downloaden', onTap: () => _download(d, curVersion)),
          ]),
          const SizedBox(height: 16),
          if ((d['tagline'] ?? '') != '') Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(d['tagline'].toString(), style: const TextStyle(color: K.lilac, fontStyle: FontStyle.italic))),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Text((d['overview'] ?? '') == '' ? 'Geen beschrijving beschikbaar.' : d['overview'].toString(), style: const TextStyle(color: Color(0xFFD9CFEE), fontSize: 15, height: 1.5)),
          ),
          if (strings(d['directors']).isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Text('${isMovie ? 'Regie' : 'Bedenkers'}: ${strings(d['directors']).join(', ')}', style: const TextStyle(color: K.muted, fontSize: 13.5))),
          if (collections.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                for (final c in collections) Pill('◆ ${c['name']}', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowseScreen.collection((c['id'] as num).toInt(), c['name'].toString())))),
              ]),
            ),
        ]),
      ),
      if (isMovie && versions.isNotEmpty)
        section(
          'Versies',
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final v in versions)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Tappable(
                  radius: 12,
                  focusScale: 1.02,
                  onTap: () => setState(() {
                    _fileId = (v['fileId'] as num).toInt();
                    _quality = 'original';
                  }),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: v['fileId'] == _fileId ? K.orchid : K.line, width: v['fileId'] == _fileId ? 2 : 1)),
                    child: Row(children: [
                      Text(v['resolution'].toString(), style: const TextStyle(fontWeight: FontWeight.w800)),
                      if (v['hdr'] == true) const Padding(padding: EdgeInsets.only(left: 8), child: Badge2('HDR')),
                      const SizedBox(width: 10),
                      Expanded(child: Text([fmtBitrate(v['bitrate'] as num?), v['vcodec'].toString().toUpperCase(), fmtSize(v['size'] as num?)].where((s) => s.isNotEmpty).join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 13))),
                      if (v['best'] == true) const Padding(padding: EdgeInsets.only(right: 8), child: Badge2('Beste', best: true)),
                      Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: (v['server'] as Json)['local'] == true ? K.ok : K.orchid)),
                      const SizedBox(width: 6),
                      Text((v['server'] as Json)['name'].toString(), style: const TextStyle(color: K.muted, fontSize: 13)),
                    ]),
                  ),
                ),
              ),
            if (curVersion != null)
              Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                const Text('Kwaliteit', style: TextStyle(color: K.muted, fontSize: 13)),
                for (final q in strings(curVersion['qualities'])) Pill(qualityLabels[q] ?? q, selected: _quality == q, onTap: () => setState(() => _quality = q)),
              ]),
          ]),
          trailing: versions.length > 1 ? Badge2('${versions.length} beschikbaar') : null,
        ),
      if (!isMovie && seasons.isNotEmpty)
        section(
          'Afleveringen',
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (seasons.length > 1)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final s in seasons) Pill('Seizoen ${s['season']}', selected: s['season'] == _season, onTap: () => setState(() => _season = (s['season'] as num).toInt())),
                ]),
              ),
            for (final e in listOf(seasons.where((s) => s['season'] == _season).firstOrNull?['episodes'])) _episodeRow(d, e, e['id'] == nextUp?['id']),
          ]),
        ),
      if (cast.isNotEmpty)
        section(
          'Cast',
          SizedBox(
            height: 132,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: cast.length.clamp(0, 16),
              separatorBuilder: (_, __) => const SizedBox(width: 14),
              itemBuilder: (_, i) => SizedBox(
                width: 84,
                child: Column(children: [
                  ClipOval(child: SizedBox(width: 72, height: 72, child: NetImage(cast[i]['photo'], fallbackText: cast[i]['name'].toString().characters.first))),
                  const SizedBox(height: 6),
                  Text(cast[i]['name'].toString(), maxLines: 2, textAlign: TextAlign.center, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ),
        ),
      if (similar.isNotEmpty)
        Shelf(title: 'Meer zoals dit', children: [
          for (final c in similar) PosterCard(c, onTap: () => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => DetailScreen((c['id'] as num).toInt())))),
        ]),
      const SizedBox(height: 30),
    ]);
  }

  Widget _episodeRow(Json d, Json e, bool isNext) {
    final p = e['progress'] as Json?;
    final versions = listOf(e['versions']);
    final frac = p == null ? 0.0 : (p['watched'] == true ? 1.0 : (numOf(p['duration']) > 0 ? numOf(p['position']) / numOf(p['duration']) : 0.0));
    final servers = versions.map((v) => (v['server'] as Json)['name'].toString()).toSet().join(' + ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Tappable(
        radius: 12,
        focusScale: 1.02,
        onTap: () => _play(d, episode: e, resume: p != null && p['watched'] != true ? numOf(p['position']) : 0),
        child: Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: isNext ? K.violet.withValues(alpha: 0.12) : K.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: K.line)),
          child: Row(children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                width: Device.isTv ? 190 : 124,
                child: AspectRatio(
                  aspectRatio: 16 / 9,
                  child: Stack(fit: StackFit.expand, children: [
                    NetImage(e['still']),
                    if (frac > 0) Align(alignment: Alignment.bottomCenter, child: LinearProgressIndicator(value: frac.clamp(0, 1).toDouble(), minHeight: 3, color: K.orchid, backgroundColor: Colors.white24)),
                  ]),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${e['episode']}. ${e['name']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                if ((e['overview'] ?? '') != '') Text(e['overview'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                const SizedBox(height: 4),
                Text([if (versions.isNotEmpty) versions.first['resolution'], if (numOf(e['duration']) > 0) '${(numOf(e['duration']) / 60).round()} min', servers].join(' · '), style: const TextStyle(color: K.faint, fontSize: 12)),
              ]),
            ),
            if (!Device.isTv && versions.isNotEmpty) IconButton(tooltip: 'Downloaden', icon: const Icon(Icons.download_rounded, color: K.muted), onPressed: () => _download(d, versions.first, episode: e)),
          ]),
        ),
      ),
    );
  }
}
