import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart' show LoopMode;
import 'package:kinoko_core/theme.dart';

import '../data/models.dart';
import '../player/handler.dart';
import '../widgets/common.dart';
import '../widgets/cover.dart';
import 'browse.dart';

void openPlayer(BuildContext context) => Navigator.of(context, rootNavigator: true).push(PageRouteBuilder(
      pageBuilder: (_, __, ___) => const PlayerScreen(),
      transitionsBuilder: (_, a, __, child) => SlideTransition(position: Tween(begin: const Offset(0, 1), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: K.ease)), child: child),
      transitionDuration: const Duration(milliseconds: 320),
    ));

/// Full-screen player: cover, title, seek bar, transport, shuffle/repeat, queue.
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key});
  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  double? _drag;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<MediaItem?>(
      stream: audio.mediaItem,
      builder: (context, snap) {
        final t = Track.ofItem(snap.data);
        if (t == null) {
          return Scaffold(appBar: AppBar(), body: const Center(child: Text('Er speelt niets.', style: TextStyle(color: K.muted))));
        }
        return Scaffold(
          body: DecoratedBox(
            decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF3B1D6E), K.bg], stops: [0, 0.62])),
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(22, 4, 22, 14),
                child: Column(children: [
                  Row(children: [
                    IconButton(tooltip: 'Sluiten', icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 32), onPressed: () => Navigator.pop(context)),
                    Expanded(child: Text(t.album, textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 13))),
                    IconButton(tooltip: 'Meer', icon: const Icon(Icons.more_vert_rounded), onPressed: () => trackMenu(context, t)),
                  ]),
                  Expanded(child: Center(child: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Cover(t.cover, radius: 14)))),
                  Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                        GestureDetector(
                          onTap: t.artistId <= 0
                              ? null
                              : () {
                                  Navigator.pop(context);
                                  shellNavigator.currentState?.push(MaterialPageRoute(builder: (_) => ArtistScreen(t.artistId)));
                                },
                          child: Text(t.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 15)),
                        ),
                      ]),
                    ),
                    LikeButton(t.id, size: 28),
                  ]),
                  const SizedBox(height: 6),
                  StreamBuilder<Duration>(
                    stream: audio.positionStream,
                    builder: (_, pos) {
                      final total = t.duration > 0 ? t.duration : (snap.data?.duration?.inMilliseconds ?? 0) / 1000;
                      final at = _drag ?? ((pos.data?.inMilliseconds ?? 0) / 1000).clamp(0.0, total > 0 ? total : 1.0);
                      return Column(children: [
                        SliderTheme(
                          data: SliderTheme.of(context).copyWith(trackHeight: 4, activeTrackColor: K.orchid, inactiveTrackColor: Colors.white24, thumbColor: Colors.white, overlayShape: SliderComponentShape.noOverlay),
                          child: Slider(
                            value: at.toDouble().clamp(0.0, total > 0 ? total : 1.0),
                            max: total > 0 ? total : 1,
                            onChanged: (v) => setState(() => _drag = v),
                            onChangeEnd: (v) {
                              audio.seek(Duration(milliseconds: (v * 1000).round()));
                              setState(() => _drag = null);
                            },
                          ),
                        ),
                        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                          Text(fmtTime(at), style: const TextStyle(color: K.muted, fontSize: 12, fontFeatures: [FontFeature.tabularFigures()])),
                          Text(fmtTime(total), style: const TextStyle(color: K.muted, fontSize: 12, fontFeatures: [FontFeature.tabularFigures()])),
                        ]),
                      ]);
                    },
                  ),
                  StreamBuilder<PlaybackState>(
                    stream: audio.playbackState,
                    builder: (_, s) {
                      final playing = s.data?.playing ?? false;
                      final busy = s.data?.processingState == AudioProcessingState.loading || s.data?.processingState == AudioProcessingState.buffering;
                      final loop = audio.loopMode;
                      return Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                        IconButton(tooltip: 'Shuffle', icon: Icon(Icons.shuffle_rounded, color: audio.shuffling ? K.orchid : K.muted), onPressed: () => audio.setShuffleMode(audio.shuffling ? AudioServiceShuffleMode.none : AudioServiceShuffleMode.all)),
                        IconButton(tooltip: 'Vorige', iconSize: 40, icon: const Icon(Icons.skip_previous_rounded), onPressed: audio.skipToPrevious),
                        Container(
                          width: 70,
                          height: 70,
                          decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
                          child: busy && !playing
                              ? const Padding(padding: EdgeInsets.all(22), child: CircularProgressIndicator(strokeWidth: 3, color: Color(0xFF150B28)))
                              : IconButton(tooltip: playing ? 'Pauzeren' : 'Afspelen', iconSize: 40, color: const Color(0xFF150B28), icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded), onPressed: playing ? audio.pause : audio.play),
                        ),
                        IconButton(tooltip: 'Volgende', iconSize: 40, icon: const Icon(Icons.skip_next_rounded), onPressed: audio.skipToNext),
                        IconButton(
                          tooltip: 'Herhalen',
                          icon: Icon(loop == LoopMode.one ? Icons.repeat_one_rounded : Icons.repeat_rounded, color: loop == LoopMode.off ? K.muted : K.orchid),
                          onPressed: () => audio.setRepeatMode(switch (loop) { LoopMode.off => AudioServiceRepeatMode.all, LoopMode.all => AudioServiceRepeatMode.one, LoopMode.one => AudioServiceRepeatMode.none }),
                        ),
                      ]);
                    },
                  ),
                  const SizedBox(height: 4),
                  Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                    for (final extra in playerExtras) extra(context, t),
                    TextButton.icon(onPressed: () => showQueue(context), icon: const Icon(Icons.queue_music_rounded, color: K.lilac), label: const Text('Wachtrij', style: TextStyle(color: K.lilac))),
                  ]),
                ]),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Extra buttons under the transport (lyrics, radio, devices) added by later features.
final List<Widget Function(BuildContext, Track)> playerExtras = [];

/// The queue: tap to jump, drag to reorder, swipe to remove.
void showQueue(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      maxChildSize: 0.95,
      builder: (context, scroll) => StreamBuilder<List<MediaItem>>(
        stream: audio.queue,
        builder: (context, _) => StreamBuilder<PlaybackState>(
          stream: audio.playbackState,
          builder: (context, __) {
            final tracks = audio.tracks, cur = audio.currentIndex ?? -1;
            return Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 16, 8, 6),
                child: Row(children: [
                  const Expanded(child: Text('Wachtrij', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
                  Text('${tracks.length} nummers', style: const TextStyle(color: K.muted, fontSize: 13)),
                  const SizedBox(width: 10),
                ]),
              ),
              Expanded(
                child: ReorderableListView.builder(
                  scrollController: scroll,
                  itemCount: tracks.length,
                  onReorderItem: (from, to) => audio.moveQueueItem(from, to),
                  itemBuilder: (context, i) {
                    final t = tracks[i];
                    return Dismissible(
                      key: ValueKey('q-$i-${t.id}'),
                      direction: i == cur ? DismissDirection.none : DismissDirection.endToStart,
                      background: Container(color: K.bad.withValues(alpha: 0.25), alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: const Icon(Icons.delete_outline_rounded)),
                      onDismissed: (_) => audio.removeQueueItemAt(i),
                      child: ListTile(
                        dense: true,
                        leading: Cover(t.cover, size: 42, radius: 6),
                        title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: i == cur ? K.orchid : K.text)),
                        subtitle: Text(t.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                        trailing: ReorderableDragStartListener(index: i, child: const Padding(padding: EdgeInsets.all(8), child: Icon(Icons.drag_handle_rounded, color: K.muted))),
                        onTap: () => audio.skipToQueueItem(i),
                      ),
                    );
                  },
                ),
              ),
            ]);
          },
        ),
      ),
    ),
  );
}
