import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/theme.dart';
import 'package:kinoko_core/widgets.dart';

import '../data/models.dart';
import '../player/handler.dart';
import '../screens/browse.dart';
import '../screens/player.dart';
import 'cover.dart';

String fmtLong(num seconds) => seconds >= 3600 ? '${seconds ~/ 3600} u ${((seconds % 3600) / 60).round()} min' : '${(seconds / 60).round()} min';

/// Runs something that talks to the server and shows what went wrong, if anything.
Future<void> attempt(BuildContext context, Future<void> Function() action, {String? done}) async {
  try {
    await action();
    if (done != null && context.mounted) showMessage(context, done);
  } catch (e) {
    if (context.mounted) showMessage(context, e);
  }
}

Future<String?> askName(BuildContext context, String title, {String initial = ''}) {
  final ctl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctl, autofocus: true, maxLength: 80, decoration: const InputDecoration(labelText: 'Naam'), onSubmitted: (v) => Navigator.pop(ctx, v)),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('Opslaan'))],
    ),
  );
}

/// The heart. Flips at once; the server follows.
class LikeButton extends StatelessWidget {
  final int trackId;
  final double size;
  const LikeButton(this.trackId, {super.key, this.size = 22});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Likes.instance,
        builder: (context, _) {
          final on = Likes.instance.has(trackId);
          return IconButton(
            tooltip: on ? 'Niet meer leuk' : 'Vind ik leuk',
            visualDensity: VisualDensity.compact,
            icon: Icon(on ? Icons.favorite_rounded : Icons.favorite_border_rounded, color: on ? K.orchid : K.muted, size: size),
            onPressed: () => attempt(context, () => Likes.instance.toggle(trackId)),
          );
        },
      );
}

/// One row in any list of songs.
class TrackTile extends StatelessWidget {
  final Track track;
  final List<Track> all;
  final int index;
  final bool numbered;
  final VoidCallback? onRemove;
  const TrackTile(this.track, this.all, this.index, {super.key, this.numbered = false, this.onRemove});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<MediaItem?>(
      stream: audio.mediaItem,
      builder: (context, snap) {
        final playing = snap.data?.id == '${track.id}';
        return InkWell(
          onTap: () => attempt(context, () => audio.playTracks(all, index: index)),
          onLongPress: () => trackMenu(context, track, onRemove: onRemove),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
            child: Row(children: [
              if (numbered)
                SizedBox(width: 30, child: playing ? const Icon(Icons.graphic_eq_rounded, color: K.orchid, size: 20) : Text('${track.trackNo > 0 ? track.trackNo : index + 1}', textAlign: TextAlign.center, style: const TextStyle(color: K.muted)))
              else
                Cover(track.cover, size: 46, radius: 6),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: playing ? K.orchid : K.text)),
                  Text(numbered ? track.artist : '${track.artist} · ${track.album}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                ]),
              ),
              LikeButton(track.id),
              IconButton(tooltip: 'Meer', visualDensity: VisualDensity.compact, icon: const Icon(Icons.more_vert_rounded, color: K.muted), onPressed: () => trackMenu(context, track, onRemove: onRemove)),
            ]),
          ),
        );
      },
    );
  }
}

void trackMenu(BuildContext context, Track t, {VoidCallback? onRemove}) {
  final nav = Navigator.of(context);
  Widget row(IconData icon, String label, VoidCallback onTap) => ListTile(
      leading: Icon(icon, color: K.lilac),
      title: Text(label),
      onTap: () {
        Navigator.pop(context);
        onTap();
      });
  showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    builder: (_) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        ListTile(leading: Cover(t.cover, size: 48, radius: 6), title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)), subtitle: Text('${t.artist} · ${t.album}', maxLines: 1, overflow: TextOverflow.ellipsis)),
        const Divider(height: 1, color: K.line),
        row(Icons.playlist_play_rounded, 'Speel hierna', () => attempt(context, () => audio.playNext(t), done: 'Speelt hierna')),
        row(Icons.queue_music_rounded, 'Aan wachtrij toevoegen', () => attempt(context, () => audio.addToQueue([t]), done: 'Toegevoegd aan de wachtrij')),
        row(Icons.playlist_add_rounded, 'Aan playlist toevoegen', () => addToPlaylist(context, [t])),
        if (t.albumId > 0) row(Icons.album_rounded, 'Naar album', () => nav.push(MaterialPageRoute(builder: (_) => AlbumScreen(t.albumId)))),
        if (t.artistId > 0) row(Icons.person_rounded, 'Naar artiest', () => nav.push(MaterialPageRoute(builder: (_) => ArtistScreen(t.artistId)))),
        if (onRemove != null) row(Icons.remove_circle_outline_rounded, 'Uit deze playlist halen', onRemove),
      ]),
    ),
  );
}

/// Pick a playlist (or make one) for these tracks.
Future<void> addToPlaylist(BuildContext context, List<Track> tracks) async {
  Json d;
  try {
    d = await api.get('/api/music/playlists${tracks.length == 1 ? '?track=${tracks.first.id}' : ''}');
  } catch (e) {
    if (context.mounted) showMessage(context, e);
    return;
  }
  if (!context.mounted) return;
  final mine = listOf(d['items']).where((p) => p['canEdit'] == true).toList();
  Future<void> add(Object id, String name) => attempt(context, () async => api.post('/api/music/playlists/$id/items', {'trackIds': [for (final t in tracks) t.id]}), done: 'Toegevoegd aan $name');
  await showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    builder: (sheet) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        const Padding(padding: EdgeInsets.fromLTRB(16, 16, 16, 6), child: Text('Aan playlist toevoegen', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
        ListTile(
          leading: const Icon(Icons.add_rounded, color: K.orchid),
          title: const Text('Nieuwe playlist'),
          onTap: () async {
            Navigator.pop(sheet);
            final name = await askName(context, 'Nieuwe playlist');
            if (name == null || name.trim().isEmpty || !context.mounted) return;
            await attempt(context, () async {
              final r = await api.post('/api/music/playlists', {'name': name});
              await api.post('/api/music/playlists/${r['id']}/items', {'trackIds': [for (final t in tracks) t.id]});
            }, done: 'Playlist gemaakt');
          },
        ),
        for (final p in mine)
          ListTile(
            leading: Cover(listOf2(p['covers']).firstOrNull as String?, size: 44, radius: 6, fallback: Icons.queue_music_rounded),
            title: Text(p['name'].toString()),
            subtitle: Text(p['has'] == true ? 'Staat er al in' : '${p['count']} nummers', style: const TextStyle(color: K.muted, fontSize: 12.5)),
            onTap: () {
              Navigator.pop(sheet);
              add(p['id'] as Object, p['name'].toString());
            },
          ),
      ]),
    ),
  );
}

/// A square card for an album, playlist or (round) artist.
class MusicCard extends StatelessWidget {
  final String? cover;
  final String title, subtitle;
  final bool round;
  final IconData fallback;
  final VoidCallback onTap;
  final double width;
  const MusicCard({super.key, required this.cover, required this.title, required this.subtitle, required this.onTap, this.round = false, this.fallback = Icons.album_rounded, this.width = 140});

  @override
  Widget build(BuildContext context) => SizedBox(
        width: width,
        child: Tappable(
          radius: 12,
          onTap: onTap,
          child: Column(crossAxisAlignment: round ? CrossAxisAlignment.center : CrossAxisAlignment.start, children: [
            Cover(cover, size: width, radius: 10, round: round, fallback: fallback),
            const SizedBox(height: 8),
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
            Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12)),
          ]),
        ),
      );
}

Widget albumCard(BuildContext context, Json a, {double width = 140}) => MusicCard(
    cover: a['cover'] as String?, title: a['title'].toString(), subtitle: [a['artist'], a['year']].where((x) => x != null).join(' · '), width: width, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlbumScreen((a['id'] as num).toInt()))));
Widget artistCard(BuildContext context, Json a, {double width = 140}) => MusicCard(
    cover: a['image'] as String?, title: a['name'].toString(), subtitle: 'Artiest', round: true, fallback: Icons.person_rounded, width: width, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ArtistScreen((a['id'] as num).toInt()))));
Widget playlistCard(BuildContext context, Json p, {double width = 140}) => MusicCard(
    cover: listOf2(p['covers']).firstOrNull as String?, title: p['name'].toString(), subtitle: '${p['count']} nummers', fallback: Icons.queue_music_rounded, width: width, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PlaylistScreen((p['id'] as num).toInt()))));

/// The strip above the navigation bar: what is playing, play/pause, next.
class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});
  @override
  Widget build(BuildContext context) {
    return StreamBuilder<MediaItem?>(
      stream: audio.mediaItem,
      builder: (context, snap) {
        final t = Track.ofItem(snap.data);
        if (t == null) return const SizedBox.shrink();
        return Material(
          color: K.surface2,
          child: InkWell(
            onTap: () => openPlayer(context),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              StreamBuilder<Duration>(
                stream: audio.positionStream,
                builder: (_, pos) => LinearProgressIndicator(value: t.duration > 0 ? ((pos.data?.inMilliseconds ?? 0) / 1000 / t.duration).clamp(0.0, 1.0) : 0, minHeight: 2, color: K.orchid, backgroundColor: Colors.white10),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 7, 4, 7),
                child: Row(children: [
                  Cover(t.cover, size: 42, radius: 6),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
                      Text(t.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12)),
                    ]),
                  ),
                  LikeButton(t.id),
                  StreamBuilder<PlaybackState>(
                    stream: audio.playbackState,
                    builder: (_, s) {
                      final playing = s.data?.playing ?? false;
                      return IconButton(tooltip: playing ? 'Pauzeren' : 'Afspelen', iconSize: 30, icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded), onPressed: playing ? audio.pause : audio.play);
                    },
                  ),
                  IconButton(tooltip: 'Volgende', icon: const Icon(Icons.skip_next_rounded), onPressed: audio.skipToNext),
                ]),
              ),
            ]),
          ),
        );
      },
    );
  }
}
