import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'theme.dart';

/// Anything you can press. On TV it shows a focus ring and grows slightly so
/// it is obvious from across the room where you are; on a phone it gives a
/// soft press-down.
class Tappable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final ValueChanged<bool>? onFocus;
  final bool autofocus;
  final double radius;
  final double focusScale;
  final FocusNode? focusNode;

  const Tappable({
    super.key,
    required this.child,
    required this.onTap,
    this.onLongPress,
    this.onFocus,
    this.autofocus = false,
    this.radius = 14,
    this.focusScale = 1.06,
    this.focusNode,
  });

  @override
  State<Tappable> createState() => _TappableState();
}

class _TappableState extends State<Tappable> {
  bool _focused = false;
  bool _pressed = false;

  void _setFocus(bool f) {
    if (f == _focused) return;
    setState(() => _focused = f);
    widget.onFocus?.call(f);
    if (f) {
      Scrollable.ensureVisible(context, alignment: 0.5, duration: const Duration(milliseconds: 280), curve: K.ease);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scale = _focused ? widget.focusScale : (_pressed ? 0.96 : 1.0);
    return FocusableActionDetector(
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      enabled: widget.onTap != null,
      onShowFocusHighlight: _setFocus,
      mouseCursor: SystemMouseCursors.click,
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.select): ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.gameButtonA): ActivateIntent(),
      },
      actions: {
        ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
          widget.onTap?.call();
          return null;
        }),
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        onLongPress: widget.onLongPress,
        onTapDown: (_) => setState(() => _pressed = true),
        onTapUp: (_) => setState(() => _pressed = false),
        onTapCancel: () => setState(() => _pressed = false),
        child: AnimatedScale(
          scale: scale,
          duration: const Duration(milliseconds: 180),
          curve: K.ease,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            foregroundDecoration: BoxDecoration(
              borderRadius: BorderRadius.circular(widget.radius),
              border: Border.all(color: _focused ? K.lilac : Colors.transparent, width: 3),
            ),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(widget.radius),
              boxShadow: _focused ? [BoxShadow(color: K.violet.withValues(alpha: 0.6), blurRadius: 28, spreadRadius: 1)] : const [],
            ),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

/// Primary / secondary pill button.
class KButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool primary;
  final bool light;
  final bool autofocus;
  final bool busy;
  final bool expand;

  const KButton(this.label, {super.key, this.icon, required this.onTap, this.primary = false, this.light = false, this.autofocus = false, this.busy = false, this.expand = false});

  @override
  Widget build(BuildContext context) {
    final fg = light ? const Color(0xFF150B28) : K.text;
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy)
          SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4, color: fg))
        else if (icon != null)
          Icon(icon, size: 22, color: fg),
        if (busy || icon != null) const SizedBox(width: 8),
        Flexible(child: Text(label, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: fg))),
      ],
    );
    return Opacity(
      opacity: onTap == null ? 0.5 : 1,
      child: Tappable(
        onTap: busy ? null : onTap,
        autofocus: autofocus,
        radius: 14,
        focusScale: 1.05,
        child: Container(
          height: 50,
          padding: const EdgeInsets.symmetric(horizontal: 22),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            gradient: primary ? K.gradient : null,
            color: primary ? null : (light ? K.lilac : Colors.white.withValues(alpha: 0.1)),
            border: primary || light ? null : Border.all(color: K.line),
          ),
          child: content,
        ),
      ),
    );
  }
}

class RoundIcon extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  final bool active;
  final double size;
  const RoundIcon(this.icon, {super.key, required this.onTap, required this.tooltip, this.active = false, this.size = 46});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: tooltip,
      child: Tappable(
        onTap: onTap,
        radius: size,
        focusScale: 1.12,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: active ? K.gradient : null,
            color: active ? null : Colors.white.withValues(alpha: 0.1),
            border: active ? null : Border.all(color: K.line),
          ),
          child: Icon(icon, size: size * 0.48, color: K.text),
        ),
      ),
    );
  }
}

class Pill extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  const Pill(this.label, {super.key, this.selected = false, this.onTap});

  @override
  Widget build(BuildContext context) {
    return Tappable(
      onTap: onTap,
      radius: 99,
      focusScale: 1.08,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? K.lilac : K.surface2,
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: selected ? Colors.transparent : K.line),
        ),
        child: Text(label, style: TextStyle(fontSize: 13.5, fontWeight: selected ? FontWeight.w700 : FontWeight.w500, color: selected ? const Color(0xFF1A0D33) : K.muted)),
      ),
    );
  }
}

class Badge2 extends StatelessWidget {
  final String label;
  final bool best;
  final Color? color;
  const Badge2(this.label, {super.key, this.best = false, this.color});

  @override
  Widget build(BuildContext context) {
    final c = color ?? K.lilac;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        gradient: best ? K.gradient : null,
        color: best ? null : c.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(6),
        border: best ? null : Border.all(color: c.withValues(alpha: 0.35)),
      ),
      child: Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: best ? Colors.white : c)),
    );
  }
}

/// Network artwork with a quiet placeholder and a fade-in.
class NetImage extends StatelessWidget {
  final String? path;
  final BoxFit fit;
  final String? fallbackText;
  final Alignment alignment;
  const NetImage(this.path, {super.key, this.fit = BoxFit.cover, this.fallbackText, this.alignment = Alignment.center});

  @override
  Widget build(BuildContext context) {
    final url = api.abs(path);
    final placeholder = Container(
      decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF241A3D), Color(0xFF130D22)])),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(10),
      child: fallbackText == null ? null : Text(fallbackText!, textAlign: TextAlign.center, maxLines: 4, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w700)),
    );
    if (url == null) return placeholder;
    return Image.network(
      url,
      fit: fit,
      alignment: alignment,
      gaplessPlayback: true,
      errorBuilder: (_, __, ___) => placeholder,
      frameBuilder: (_, child, frame, sync) {
        if (sync) return child;
        return Stack(fit: StackFit.passthrough, children: [
          Positioned.fill(child: placeholder),
          AnimatedOpacity(opacity: frame == null ? 0 : 1, duration: const Duration(milliseconds: 350), child: child),
        ]);
      },
    );
  }
}

class Logo extends StatelessWidget {
  final double size;
  const Logo({super.key, this.size = 22});

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Mushroom(size: size * 1.4),
      SizedBox(width: size * 0.45),
      ShaderMask(
        shaderCallback: (r) => const LinearGradient(colors: [K.text, Color(0xFFC9A8FF), Color(0xFFE879F9)]).createShader(r),
        child: Text('KINOKO', style: TextStyle(fontSize: size, fontWeight: FontWeight.w800, letterSpacing: size * 0.16, color: Colors.white)),
      ),
    ]);
  }
}

/// The Kinoko mark (kinoko = mushroom), drawn so it needs no image asset.
class Mushroom extends StatelessWidget {
  final double size;
  const Mushroom({super.key, this.size = 32});
  @override
  Widget build(BuildContext context) => SizedBox(width: size, height: size, child: CustomPaint(painter: _MushroomPainter()));
}

class _MushroomPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 64;
    canvas.scale(s);
    final cap = Path()
      ..moveTo(32, 11)
      ..cubicTo(19, 11, 10, 19.5, 10, 29)
      ..cubicTo(10, 32.2, 12.2, 34, 15.5, 34)
      ..lineTo(48.5, 34)
      ..cubicTo(51.8, 34, 54, 32.2, 54, 29)
      ..cubicTo(54, 19.5, 45, 11, 32, 11)
      ..close();
    canvas.drawPath(cap, Paint()..shader = const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFD8B4FE), Color(0xFFA855F7), Color(0xFF6D28D9)]).createShader(const Rect.fromLTWH(10, 11, 44, 23)));
    final stem = Path()
      ..moveTo(26, 34)
      ..lineTo(38, 34)
      ..lineTo(40.2, 48.5)
      ..cubicTo(40.7, 51.5, 38.5, 54, 35.5, 54)
      ..lineTo(28.5, 54)
      ..cubicTo(25.5, 54, 23.3, 51.5, 23.8, 48.5)
      ..close();
    canvas.drawPath(stem, Paint()..color = const Color(0xFFEFE6FF));
    final spot = Paint()..color = const Color(0xE6F5EDFF);
    canvas.drawCircle(const Offset(23, 23), 3.2, spot);
    canvas.drawCircle(const Offset(35, 18.5), 2.3, spot);
    canvas.drawCircle(const Offset(43, 26), 2.7, spot);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

void showMessage(BuildContext context, Object message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message.toString())));
}

/// Loading / error wrapper used by every screen that fetches something.
class Loader<T> extends StatelessWidget {
  final Future<T> future;
  final Widget Function(BuildContext, T) builder;
  final VoidCallback? onRetry;
  const Loader({super.key, required this.future, required this.builder, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: future,
      builder: (context, snap) {
        if (snap.hasError) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.cloud_off_rounded, size: 46, color: K.faint),
                const SizedBox(height: 12),
                Text(snap.error.toString(), textAlign: TextAlign.center, style: const TextStyle(color: K.muted)),
                if (onRetry != null) ...[const SizedBox(height: 18), KButton('Opnieuw proberen', icon: Icons.refresh_rounded, onTap: onRetry, autofocus: Device.isTv)],
              ]),
            ),
          );
        }
        if (!snap.hasData) return const Center(child: CircularProgressIndicator(color: K.orchid));
        return builder(context, snap.data as T);
      },
    );
  }
}
