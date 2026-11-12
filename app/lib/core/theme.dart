import 'package:flutter/material.dart';

/// Kinoko's palette: black with layered purples.
class K {
  static const bg = Color(0xFF07050C);
  static const bg2 = Color(0xFF0E0A17);
  static const surface = Color(0xFF151022);
  static const surface2 = Color(0xFF1D1630);
  static const surface3 = Color(0xFF2A2044);
  static const line = Color(0x33C4A7FF);
  static const text = Color(0xFFF3EEFC);
  static const muted = Color(0xFFA99CC4);
  static const faint = Color(0xFF6F6488);
  static const violet = Color(0xFF8B5CF6);
  static const orchid = Color(0xFFC084FC);
  static const lilac = Color(0xFFE4D4FF);
  static const grape = Color(0xFF6D28D9);
  static const fuchsia = Color(0xFFD946EF);
  static const gold = Color(0xFFFCD34D);
  static const bad = Color(0xFFFB7185);
  static const ok = Color(0xFF6EE7B7);

  static const gradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [grape, Color(0xFFA855F7), fuchsia],
  );

  static const ease = Cubic(0.2, 0.8, 0.2, 1);

  static ThemeData theme({required bool tv}) {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        primary: orchid,
        secondary: fuchsia,
        surface: surface,
        onPrimary: Color(0xFF150B28),
        onSurface: text,
        error: bad,
      ),
    );
    return base.copyWith(
      textTheme: base.textTheme.apply(bodyColor: text, displayColor: text, fontSizeFactor: tv ? 1.12 : 1.0),
      splashFactory: InkSparkle.splashFactory,
      appBarTheme: const AppBarTheme(backgroundColor: Colors.transparent, elevation: 0, scrolledUnderElevation: 0),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: bg2,
        hintStyle: const TextStyle(color: faint),
        labelStyle: const TextStyle(color: muted),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: line)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: orchid, width: 2)),
      ),
      bottomSheetTheme: const BottomSheetThemeData(backgroundColor: surface, surfaceTintColor: Colors.transparent),
      dialogTheme: const DialogThemeData(backgroundColor: surface, surfaceTintColor: Colors.transparent),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: surface3,
        contentTextStyle: const TextStyle(color: text),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      }),
    );
  }
}

String fmtTime(num seconds) {
  final s = seconds.isFinite ? seconds.floor().clamp(0, 359999) : 0;
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
  final mm = m.toString().padLeft(2, '0'), ss = sec.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$m:$ss';
}

String fmtRuntime(num? minutes) {
  if (minutes == null || minutes <= 0) return '';
  final m = minutes.round();
  return m >= 60 ? '${m ~/ 60}u ${m % 60}m' : '${m}m';
}

String fmtBitrate(num? bps) {
  if (bps == null || bps <= 0) return '';
  if (bps >= 1e6) return '${(bps / 1e6).toStringAsFixed(1).replaceAll('.', ',')} Mbps';
  return '${(bps / 1000).round()} kbps';
}

String fmtSize(num? bytes) {
  if (bytes == null || bytes <= 0) return '';
  if (bytes >= 1e9) return '${(bytes / 1e9).toStringAsFixed(1).replaceAll('.', ',')} GB';
  return '${(bytes / 1e6).round()} MB';
}

const qualityLabels = {'original': 'Origineel', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p'};
