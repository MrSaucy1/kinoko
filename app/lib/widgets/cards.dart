import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import 'common.dart';

double posterWidth(BuildContext context) {
  final w = MediaQuery.sizeOf(context).width;
  if (Device.isTv) return (w / 7.2).clamp(120.0, 210.0);
  return (w / 3.3).clamp(104.0, 170.0);
}

class PosterCard extends StatelessWidget {
  final Json item;
  final VoidCallback onTap;
  final bool autofocus;
  final double? width;
  final ValueChanged<bool>? onFocus;
  const PosterCard(this.item, {super.key, required this.onTap, this.autofocus = false, this.width, this.onFocus});

  @override
  Widget build(BuildContext context) {
    final w = width ?? posterWidth(context);
    return SizedBox(
      width: w,
      child: Tappable(
        onTap: onTap,
        autofocus: autofocus,
        onFocus: onFocus,
        radius: 12,
        focusScale: 1.08,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(aspectRatio: 2 / 3, child: NetImage(item['poster'] ?? item['backdrop'], fallbackText: item['title']?.toString())),
        ),
      ),
    );
  }
}

/// 16:9 card with a title and progress bar: "Verder kijken".
class WideCard extends StatelessWidget {
  final Json item;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool autofocus;
  const WideCard(this.item, {super.key, required this.onTap, this.onLongPress, this.autofocus = false});

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final width = Device.isTv ? (w / 4.2).clamp(220.0, 340.0) : (w * 0.66).clamp(210.0, 320.0);
    final r = item['resume'] as Json?;
    final sub = r != null && r['episodeId'] != null ? 'S${r['season']} · A${r['episode']}${(r['name'] ?? '') != '' ? ' — ${r['name']}' : ''}' : (item['year']?.toString() ?? '');
    final dur = numOf(r?['duration']), pos = numOf(r?['position']);
    return SizedBox(
      width: width,
      child: Tappable(
        onTap: onTap,
        onLongPress: onLongPress,
        autofocus: autofocus,
        radius: 12,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: 16 / 9,
            child: Stack(fit: StackFit.expand, children: [
              NetImage(item['backdrop'] ?? item['poster'], fallbackText: item['title']?.toString()),
              const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Color(0xF207050C)], stops: [0.4, 1]))),
              Positioned(
                left: 12,
                right: 12,
                bottom: dur > 0 ? 14 : 10,
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(item['title']?.toString() ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5)),
                  if (sub.isNotEmpty) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                ]),
              ),
              if (dur > 0)
                Positioned(
                  left: 10,
                  right: 10,
                  bottom: 6,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(3),
                    child: LinearProgressIndicator(value: (pos / dur).clamp(0, 1).toDouble(), minHeight: 3, backgroundColor: Colors.white24, color: K.orchid),
                  ),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}

class CollectionCard extends StatelessWidget {
  final Json item;
  final VoidCallback onTap;
  const CollectionCard(this.item, {super.key, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final width = Device.isTv ? (w / 4.2).clamp(220.0, 340.0) : (w * 0.66).clamp(210.0, 320.0);
    final posters = strings(item['posters']);
    return SizedBox(
      width: width,
      child: Tappable(
        onTap: onTap,
        radius: 12,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: 16 / 9,
            child: Stack(fit: StackFit.expand, children: [
              NetImage(item['backdrop']),
              const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: [Color(0xEE1B0F38), Color(0x663B1D6E), Colors.transparent], stops: [0, 0.55, 1]))),
              Positioned(
                right: 10,
                top: 0,
                bottom: 0,
                child: Center(
                  child: SizedBox(
                    width: 96,
                    height: 84,
                    child: Stack(children: [
                      for (var i = 0; i < posters.length && i < 3; i++)
                        Positioned(
                          left: i * 22.0,
                          child: Transform.rotate(
                            angle: (i - 1) * 0.14,
                            child: ClipRRect(borderRadius: BorderRadius.circular(6), child: SizedBox(width: 52, height: 78, child: NetImage(posters[i]))),
                          ),
                        ),
                    ]),
                  ),
                ),
              ),
              Positioned(
                left: 14,
                right: 110,
                bottom: 12,
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(item['title']?.toString() ?? '', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16.5, height: 1.15)),
                  Text('${item['count']} films', style: const TextStyle(color: K.lilac, fontSize: 12.5)),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// A titled horizontal row.
class Shelf extends StatelessWidget {
  final String title;
  final List<Widget> children;
  final VoidCallback? onMore;
  const Shelf({super.key, required this.title, required this.children, this.onMore});

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 26),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: EdgeInsets.fromLTRB(pad, 0, pad, 10),
          child: Row(children: [
            Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Device.isTv ? 21 : 18, fontWeight: FontWeight.w700, letterSpacing: -0.3))),
            if (onMore != null && !Device.isTv) GestureDetector(onTap: onMore, child: const Text('Alles ›', style: TextStyle(color: K.orchid, fontWeight: FontWeight.w600))),
          ]),
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          clipBehavior: Clip.none,
          padding: EdgeInsets.symmetric(horizontal: pad, vertical: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var i = 0; i < children.length; i++) Padding(padding: EdgeInsets.only(right: i == children.length - 1 ? 0 : 12), child: children[i]),
          ]),
        ),
      ]),
    );
  }
}
