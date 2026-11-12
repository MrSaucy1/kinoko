import 'package:flutter/material.dart';

import '../core/theme.dart';
import '../services/downloads.dart';
import '../widgets/common.dart';
import 'player.dart';

class DownloadsScreen extends StatelessWidget {
  const DownloadsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final dl = Downloads.instance;
    return SafeArea(
      child: ListenableBuilder(
        listenable: dl,
        builder: (context, _) {
          if (dl.items.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.download_for_offline_rounded, size: 56, color: K.faint),
                  SizedBox(height: 14),
                  Text('Nog geen downloads', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  SizedBox(height: 6),
                  Text('Tik bij een film of aflevering op het download-icoon om hem zonder internet te kunnen kijken.', textAlign: TextAlign.center, style: TextStyle(color: K.muted)),
                ]),
              ),
            );
          }
          return ListView(padding: const EdgeInsets.fromLTRB(16, 18, 16, 40), children: [
            const Text('Downloads', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
            const SizedBox(height: 14),
            for (final d in dl.items) _row(context, dl, d),
          ]);
        },
      ),
    );
  }

  Widget _row(BuildContext context, Downloads dl, DownloadItem d) {
    final done = d.status == 'done';
    final status = switch (d.status) {
      'done' => [d.meta['resolution'], fmtSize(d.total > 0 ? d.total : d.meta['size'] as num?)].where((x) => x != null && x != '').join(' · '),
      'downloading' => '${(d.progress * 100).round()}% · ${fmtSize(d.received)} van ${fmtSize(d.total)}',
      'failed' => d.error ?? 'Mislukt',
      _ => 'Gepauzeerd · ${(d.progress * 100).round()}%',
    };
    final poster = dl.posterOf(d);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Tappable(
        radius: 14,
        focusScale: 1.01,
        onTap: done ? () => openPlayer(context, PlayRequest(offline: d)) : null,
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: K.line)),
          child: Row(children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(width: 56, height: 84, child: poster.existsSync() ? Image.file(poster, fit: BoxFit.cover) : const ColoredBox(color: K.surface3, child: Icon(Icons.movie_rounded, color: K.faint))),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(d.meta['title'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                if ((d.meta['subtitle'] ?? '') != '') Text(d.meta['subtitle'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 13)),
                const SizedBox(height: 6),
                if (!done) ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: d.progress, minHeight: 4, color: K.orchid, backgroundColor: K.surface3)),
                const SizedBox(height: 4),
                Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: d.status == 'failed' ? K.bad : K.faint, fontSize: 12)),
              ]),
            ),
            if (d.status == 'downloading') IconButton(tooltip: 'Pauzeren', icon: const Icon(Icons.pause_rounded), onPressed: () => dl.pause(d)),
            if (d.status == 'paused' || d.status == 'failed' || d.status == 'queued') IconButton(tooltip: 'Hervatten', icon: const Icon(Icons.play_arrow_rounded), onPressed: () => dl.resume(d)),
            if (done) const Padding(padding: EdgeInsets.symmetric(horizontal: 8), child: Icon(Icons.play_circle_fill_rounded, color: K.orchid, size: 30)),
            IconButton(
              tooltip: 'Verwijderen',
              icon: const Icon(Icons.delete_outline_rounded, color: K.muted),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Download verwijderen?'),
                    content: Text('${d.meta['title']} wordt van dit toestel gehaald. Op de server blijft hij staan.'),
                    actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Verwijderen'))],
                  ),
                );
                if (ok == true) dl.remove(d);
              },
            ),
          ]),
        ),
      ),
    );
  }
}
