import 'dart:async';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../core/api.dart';
import 'common.dart';

/// Artwork that turns into a muted trailer after a moment, like Netflix.
///
/// The trailer itself is the server's `/trailer.html` page (a chrome-less
/// YouTube embed) in a WebView; it tells us when there is picture and when
/// it is over, and only in between does it cover [child].
class TrailerBackdrop extends StatefulWidget {
  /// YouTube id; null or empty shows just [child].
  final String? trailer;
  final Widget child;
  final Duration delay;

  /// Called with true once the trailer starts loading and false when it is gone again.
  final ValueChanged<bool>? onActive;

  /// Where the sound button sits; null hides it (tv: nothing to focus on).
  final Alignment? soundButton;
  const TrailerBackdrop({super.key, required this.trailer, required this.child, this.delay = const Duration(milliseconds: 2500), this.onActive, this.soundButton});

  @override
  State<TrailerBackdrop> createState() => _TrailerBackdropState();
}

class _TrailerBackdropState extends State<TrailerBackdrop> {
  static bool _sound = false; // the viewer's choice sticks while the app runs
  Timer? _wait;
  WebViewController? _web;
  bool _visible = false;
  bool _done = false;

  bool get _has => (widget.trailer ?? '').isNotEmpty && api.hasServer;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Covered by another screen (the player, a dialog) or on a hidden tab: stop.
    final front = (ModalRoute.of(context)?.isCurrent ?? true) && TickerMode.valuesOf(context).enabled;
    if (!front) {
      _stop();
    } else if (_has && !_done && _web == null && _wait == null) {
      _wait = Timer(widget.delay, _start);
    }
  }

  void _start() {
    _wait = null;
    if (!mounted || _done) return;
    final web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..addJavaScriptChannel('Kinoko', onMessageReceived: (m) => _onMessage(m.message));
    final platform = web.platform;
    if (platform is AndroidWebViewController) platform.setMediaPlaybackRequiresUserGesture(false);
    web.loadRequest(Uri.parse('${api.serverUrl}/trailer.html?v=${Uri.encodeQueryComponent(widget.trailer!)}'));
    setState(() => _web = web);
    widget.onActive?.call(true);
  }

  void _onMessage(String what) {
    if (!mounted || _web == null) return;
    if (what == 'playing') {
      if (_sound) _web!.runJavaScript("window.kinokoTrailer('unmute')");
      setState(() => _visible = true);
    } else {
      _done = true; // ended or unavailable: back to the artwork for good
      _stop();
    }
  }

  void _stop() {
    _wait?.cancel();
    _wait = null;
    if (_web == null) return;
    _web!.loadRequest(Uri.parse('about:blank'));
    _web = null;
    _visible = false;
    if (mounted) setState(() {});
    // May run while the tree is building (route covered), so report afterwards.
    WidgetsBinding.instance.addPostFrameCallback((_) => widget.onActive?.call(false));
  }

  @override
  void dispose() {
    _wait?.cancel();
    _web?.loadRequest(Uri.parse('about:blank'));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    return Stack(fit: StackFit.expand, children: [
      widget.child,
      if (web != null)
        AnimatedOpacity(
          opacity: _visible ? 1 : 0,
          duration: const Duration(milliseconds: 900),
          // Pure decoration: never takes touches or remote-control focus.
          child: IgnorePointer(child: ExcludeFocus(child: WebViewWidget(controller: web))),
        ),
      if (web != null && _visible && widget.soundButton != null)
        Align(
          alignment: widget.soundButton!,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: RoundIcon(
              _sound ? Icons.volume_up_rounded : Icons.volume_off_rounded,
              tooltip: 'Geluid van de trailer',
              onTap: () {
                setState(() => _sound = !_sound);
                web.runJavaScript("window.kinokoTrailer('${_sound ? 'unmute' : 'mute'}')");
              },
            ),
          ),
        ),
    ]);
  }
}
