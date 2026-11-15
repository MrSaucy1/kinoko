import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// Feeds the app's Android home-screen widget. The native side keeps the
/// values and redraws the widget; here we only hand them over. Without a
/// widget on the home screen, or on a platform without one, this does nothing.
class HomeWidget {
  static const _channel = MethodChannel('kinoko/widget');
  static Map<String, String> _last = const {};

  /// Values are plain strings; a picture is passed as the path of a local file.
  static Future<void> update(Map<String, String> values) async {
    if (_same(values, _last)) return;
    _last = Map.of(values);
    try {
      await _channel.invokeMethod<void>('update', values);
    } catch (_) {
      // No activity attached right now, or not Android: the widget keeps what it had.
    }
  }

  static bool _same(Map<String, String> a, Map<String, String> b) => a.length == b.length && a.entries.every((e) => b[e.key] == e.value);

  /// Downloads a picture to [file] (once) so the widget can show it; returns the path or ''.
  static Future<String> picture(String? url, File file) async {
    if (url == null || url.isEmpty) return '';
    try {
      if (await file.exists() && await file.length() > 0) return file.path;
      final r = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) return '';
      await file.writeAsBytes(r.bodyBytes, flush: true);
      return file.path;
    } catch (_) {
      return '';
    }
  }
}
