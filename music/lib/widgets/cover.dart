import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/theme.dart';
import 'package:path_provider/path_provider.dart';

/// Album art, kept on disk after the first download so lists scroll without
/// loading the same pictures again (also on the next start, and offline).
class CoverCache {
  static Directory? _dir;
  static final _pending = <String, Future<File?>>{};

  // FNV-1a: a stable name for a URL (String.hashCode may differ between runs).
  static String _name(String url) {
    var h = 0xcbf29ce484222325;
    for (final c in url.codeUnits) {
      h = ((h ^ c) * 0x100000001b3) & 0x7fffffffffffffff;
    }
    return h.toRadixString(16);
  }

  static Future<File?> get(String url) => _pending[url] ??= _load(url);

  static Future<File?> _load(String url) async {
    try {
      _dir ??= await Directory('${(await getApplicationCacheDirectory()).path}/covers').create(recursive: true);
      final file = File('${_dir!.path}/${_name(url)}');
      if (await file.exists() && await file.length() > 0) return file;
      final r = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 20));
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
        _pending.remove(url); // try again next time it is shown
        return null;
      }
      await file.writeAsBytes(r.bodyBytes, flush: true);
      return file;
    } catch (_) {
      _pending.remove(url);
      return null;
    }
  }
}

class Cover extends StatelessWidget {
  final String? url;
  final double? size;
  final double radius;
  final bool round;
  final IconData fallback;
  const Cover(this.url, {super.key, this.size, this.radius = 8, this.round = false, this.fallback = Icons.music_note_rounded});

  @override
  Widget build(BuildContext context) {
    final abs = url == null ? null : api.abs(url);
    final empty = DecoratedBox(
      decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF3B1D6E), Color(0xFF150B28)])),
      child: Center(child: Icon(fallback, color: K.lilac, size: (size ?? 120) * 0.42)),
    );
    final child = abs == null
        ? empty
        : FutureBuilder<File?>(
            future: CoverCache.get(abs),
            builder: (_, snap) => snap.data == null
                ? empty
                : Image.file(snap.data!, fit: BoxFit.cover, gaplessPlayback: true, cacheWidth: size == null ? 600 : (size! * 3).round(), errorBuilder: (_, __, ___) => empty),
          );
    return SizedBox(
      width: size,
      height: size,
      child: AspectRatio(aspectRatio: 1, child: ClipRRect(borderRadius: BorderRadius.circular(round ? 999 : radius), child: child)),
    );
  }
}
