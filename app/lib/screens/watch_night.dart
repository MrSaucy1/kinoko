import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import 'detail.dart';
import 'player.dart';

Future<void> openWatchNight(BuildContext context) => Navigator.push(context, PageRouteBuilder(pageBuilder: (_, __, ___) => const WatchNightScreen(), transitionsBuilder: (_, a, __, c) => FadeTransition(opacity: a, child: c), transitionDuration: const Duration(milliseconds: 400)));

Color _hex(String s) => Color(int.parse(s.replaceFirst('#', 'FF'), radix: 16));

/// Seasonal picks with a slot-machine reveal; "dobbelen" rolls three new ones.
class WatchNightScreen extends StatefulWidget {
  const WatchNightScreen({super.key});
  @override
  State<WatchNightScreen> createState() => _WatchNightScreenState();
}

class _WatchNightScreenState extends State<WatchNightScreen> with TickerProviderStateMixin {
  late final AnimationController _sky = AnimationController(vsync: this, duration: const Duration(seconds: 20))..repeat();
  late final AnimationController _roll = AnimationController(vsync: this, duration: const Duration(milliseconds: 2800));
  Json? _data;
  String? _error;
  bool _loading = true;
  int _rollNo = 0;
  final List<int> _seen = [];
  final _particles = List.generate(48, (i) => _Particle(math.Random(i)));

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  @override
  void dispose() {
    _sky.dispose();
    _roll.dispose();
    super.dispose();
  }

  /// Opens a room in which everyone votes on the three picks; the winner starts for all.
  Future<void> _voteTogether() async {
    try {
      final r = await api.post('/api/watch/vote', {'titleIds': [for (final p in listOf(_data?['picks'])) p['id']]});
      if (mounted) await openPlayer(context, PlayRequest(roomCode: r['code'].toString()));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _fetch() async {
    setState(() => _loading = true);
    try {
      final d = await api.get('/api/watchnight${_seen.isEmpty ? '' : '?exclude=${_seen.join(',')}'}');
      if (!mounted) return;
      for (final p in listOf(d['picks'])) {
        _seen.add((p['id'] as num).toInt());
      }
      while (_seen.length > 12) {
        _seen.removeAt(0);
      }
      setState(() {
        _data = d;
        _rollNo++;
        _loading = false;
        _error = null;
      });
      _roll.forward(from: 0);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = _data?['theme'] as Json?;
    final colors = strings(theme?['colors']);
    final a = colors.isNotEmpty ? _hex(colors[0]) : K.orchid, b = colors.length > 1 ? _hex(colors[1]) : K.gold;
    final picks = listOf(_data?['picks']);
    final reel = strings(_data?['reel']);
    return Scaffold(
      body: Stack(fit: StackFit.expand, children: [
        DecoratedBox(decoration: BoxDecoration(gradient: RadialGradient(center: const Alignment(0, -1.2), radius: 1.5, colors: [a.withValues(alpha: 0.4), const Color(0xFF0B0713)]))),
        AnimatedBuilder(animation: _sky, builder: (_, __) => CustomPaint(painter: _ParticlePainter(_particles, _sky.value, (theme?['particle'] ?? 'snow').toString(), a, b))),
        SafeArea(
          child: _error != null
              ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_error!, style: const TextStyle(color: K.muted)), const SizedBox(height: 16), KButton('Terug', autofocus: true, onTap: () => Navigator.pop(context))]))
              : _data == null
                  ? const Center(child: CircularProgressIndicator(color: K.orchid))
                  : LayoutBuilder(builder: (context, box) {
                      final wide = box.maxWidth > 700;
                      final cardW = math.min((box.maxWidth - 32 - 24) / 3, wide ? box.maxHeight * 0.34 : 170.0);
                      return SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                        child: ConstrainedBox(
                          constraints: BoxConstraints(minHeight: box.maxHeight - 32),
                          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                            if (!Device.isTv) Align(alignment: Alignment.centerRight, child: RoundIcon(Icons.close_rounded, tooltip: 'Sluiten', onTap: () => Navigator.pop(context))),
                            const Text('WATCH NIGHT', style: TextStyle(letterSpacing: 5, fontSize: 12, color: K.lilac)),
                            const SizedBox(height: 8),
                            ShaderMask(
                              shaderCallback: (r) => LinearGradient(colors: [Colors.white, a, b]).createShader(r),
                              child: Text(theme!['name'].toString(), textAlign: TextAlign.center, style: TextStyle(fontSize: wide ? 56 : 40, fontWeight: FontWeight.w900, letterSpacing: -1.5, color: Colors.white, height: 1)),
                            ),
                            const SizedBox(height: 8),
                            Text(theme['tagline'].toString(), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFD9CFEE), fontSize: 16)),
                            SizedBox(height: wide ? 26 : 30),
                            Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                              for (var i = 0; i < picks.length; i++)
                                Padding(
                                  padding: EdgeInsets.only(left: i == 0 ? 0 : 12),
                                  child: _Slot(key: ValueKey('$_rollNo-$i'), pick: picks[i], reel: reel, index: i, count: picks.length, roll: _roll, width: cardW, glow: a),
                                ),
                            ]),
                            SizedBox(height: wide ? 22 : 30),
                            KButton(_loading ? 'Dobbelen…' : 'Opnieuw dobbelen', icon: Icons.casino_rounded, primary: true, busy: _loading, autofocus: Device.isTv, onTap: _fetch),
                            const SizedBox(height: 10),
                            KButton('Samen stemmen', icon: Icons.how_to_vote_rounded, onTap: _loading ? null : _voteTogether),
                            const SizedBox(height: 12),
                            Text('Gekozen uit ${_data!['poolSize']} films die bij dit moment passen.', style: const TextStyle(color: K.faint, fontSize: 12.5)),
                          ]),
                        ),
                      );
                    }),
        ),
      ]),
    );
  }
}

class _Slot extends StatelessWidget {
  final Json pick;
  final List<String> reel;
  final int index, count;
  final AnimationController roll;
  final double width;
  final Color glow;
  const _Slot({super.key, required this.pick, required this.reel, required this.index, required this.count, required this.roll, required this.width, required this.glow});

  @override
  Widget build(BuildContext context) {
    final strip = reel.where((u) => u != pick['poster']).take(8).toList();
    final h = width * 1.5;
    // Each reel stops a little after the previous one.
    final end = 0.55 + 0.45 * (index + 1) / count;
    final spin = CurvedAnimation(parent: roll, curve: Interval(0, end, curve: const Cubic(0.12, 0.72, 0.18, 1)));
    return SizedBox(
      width: width,
      child: AnimatedBuilder(
        animation: roll,
        builder: (context, _) {
          final landed = roll.value >= end;
          final sinceLand = landed ? ((roll.value - end) / 0.12).clamp(0.0, 1.0) : 0.0;
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Tappable(
              radius: 16,
              onTap: landed ? () => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => DetailScreen((pick['id'] as num).toInt()))) : null,
              child: Transform.scale(
                scale: landed ? 1 + 0.08 * (1 - Curves.easeOut.transform(sinceLand)) : 1,
                child: Container(
                  height: h,
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: landed && sinceLand < 1 ? Colors.white : K.line, width: landed && sinceLand < 1 ? 2 : 1),
                    boxShadow: [BoxShadow(color: glow.withValues(alpha: landed ? 0.55 * (1 - sinceLand) + 0.15 : 0.1), blurRadius: 40)],
                  ),
                  child: OverflowBox(
                    alignment: Alignment.topCenter,
                    maxHeight: double.infinity,
                    child: Transform.translate(
                      offset: Offset(0, -h * strip.length * spin.value),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        for (final u in strip) Opacity(opacity: 0.75, child: SizedBox(width: width, height: h, child: NetImage(u))),
                        SizedBox(width: width, height: h, child: NetImage(pick['poster'], fallbackText: pick['title'].toString())),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            AnimatedOpacity(
              opacity: landed ? 1 : 0,
              duration: const Duration(milliseconds: 400),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(pick['title'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, height: 1.2)),
                Text([pick['year'], pick['fit']].where((x) => x != null).join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12)),
              ]),
            ),
          ]);
        },
      ),
    );
  }
}

class _Particle {
  final double x, phase, speed, size, drift;
  _Particle(math.Random r)
      : x = r.nextDouble(),
        phase = r.nextDouble(),
        speed = 1 + r.nextInt(3).toDouble(),
        size = 4 + r.nextDouble() * 10,
        drift = r.nextDouble() * math.pi * 2;
}

class _ParticlePainter extends CustomPainter {
  final List<_Particle> parts;
  final double t;
  final String kind;
  final Color a, b;
  _ParticlePainter(this.parts, this.t, this.kind, this.a, this.b);

  @override
  void paint(Canvas canvas, Size size) {
    final rising = kind == 'fireflies' || kind == 'hearts';
    for (var i = 0; i < parts.length; i++) {
      final p = parts[i];
      var y = (p.phase + t * p.speed) % 1.0;
      if (rising) y = 1 - y;
      final x = p.x + math.sin(t * math.pi * 2 * p.speed + p.drift) * 0.03;
      final paint = Paint()..color = (kind == 'snow' ? Colors.white : (i.isEven ? a : b)).withValues(alpha: kind == 'fireflies' ? 0.25 + 0.6 * (0.5 + 0.5 * math.sin(t * 40 + p.drift)) : 0.5);
      canvas.save();
      canvas.translate(x * size.width, y * size.height);
      if (kind == 'snow' || kind == 'fireflies') {
        canvas.drawCircle(Offset.zero, p.size * 0.3, paint);
      } else if (kind == 'hearts') {
        final r = p.size * 0.45;
        canvas.drawPath(
          Path()
            ..moveTo(0, r)
            ..cubicTo(-r * 2, -r * 0.4, -r * 0.8, -r * 1.7, 0, -r * 0.6)
            ..cubicTo(r * 0.8, -r * 1.7, r * 2, -r * 0.4, 0, r),
          paint,
        );
      } else {
        canvas.rotate(t * math.pi * 2 * p.speed + p.drift);
        canvas.drawOval(Rect.fromCenter(center: Offset.zero, width: p.size * 1.3, height: p.size * 0.6), paint);
      }
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _ParticlePainter old) => old.t != t;
}
