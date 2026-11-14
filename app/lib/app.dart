import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';

import 'core/api.dart';
import 'core/theme.dart';
import 'screens/browse.dart';
import 'screens/downloads.dart';
import 'screens/home.dart';
import 'screens/live.dart';
import 'screens/onboarding.dart';
import 'screens/profile.dart';
import 'screens/player.dart';
import 'services/downloads.dart';
import 'services/events.dart';
import 'widgets/common.dart';

/// Shared entry point; `main.dart` (phone) and `main_tv.dart` (TV) call this.
Future<void> runKinoko({required bool tv}) async {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();
  Device.isTv = tv;
  await api.load();
  if (!tv) {
    await Downloads.instance.load();
    await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  }
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent, systemNavigationBarColor: K.bg, statusBarIconBrightness: Brightness.light));
  runApp(const KinokoApp());
}

final _navigator = GlobalKey<NavigatorState>();

class KinokoApp extends StatefulWidget {
  const KinokoApp({super.key});
  @override
  State<KinokoApp> createState() => _KinokoAppState();
}

class _KinokoAppState extends State<KinokoApp> {
  StreamSubscription<Uri>? _links;
  StreamSubscription<Json>? _events;
  final _messenger = GlobalKey<ScaffoldMessengerState>();

  /// "Paused on another device": offer to pick it up here.
  void _onEvent(Json m) {
    if (m['t'] != 'resume' || PlayerScreen.open > 0) return;
    final ctx = _navigator.currentContext;
    if (ctx == null || !api.signedIn) return;
    final where = (m['episodeId'] ?? 0) != 0 ? ' · S${m['season']} A${m['episode']}' : '';
    _messenger.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        duration: const Duration(seconds: 20),
        content: Text('Gepauzeerd op een ander apparaat: ${m['title']}$where'),
        action: SnackBarAction(
          label: 'Verder kijken',
          onPressed: () {
            final c = _navigator.currentContext;
            if (c == null) return;
            final ep = (m['episodeId'] as num?)?.toInt() ?? 0;
            openPlayer(c, PlayRequest(titleId: (m['titleId'] as num).toInt(), episodeId: ep == 0 ? null : ep, resume: (m['position'] as num?)?.toDouble()));
          },
        ),
      ));
  }

  @override
  void initState() {
    super.initState();
    api.addListener(ServerEvents.instance.sync);
    ServerEvents.instance.sync();
    _events = ServerEvents.instance.stream.listen(_onEvent);
    // kinoko://w/CODE — an invite opened from the web page or a chat message.
    try {
      _links = AppLinks().uriLinkStream.listen(_onLink, onError: (_) {});
    } catch (_) {
      // Deep links are a convenience; the app works without them.
    }
  }

  void _onLink(Uri uri) {
    final code = uri.pathSegments.isNotEmpty ? uri.pathSegments.last : '';
    final ctx = _navigator.currentContext;
    if (!RegExp(r'^[A-Za-z0-9]{6}$').hasMatch(code) || ctx == null || !api.signedIn) return;
    joinRoomDialog(ctx, code: code);
  }

  @override
  void dispose() {
    _links?.cancel();
    _events?.cancel();
    api.removeListener(ServerEvents.instance.sync);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kinoko',
      navigatorKey: _navigator,
      scaffoldMessengerKey: _messenger,
      debugShowCheckedModeBanner: false,
      theme: K.theme(tv: Device.isTv),
      // TV remotes send "select"; map it to activate everywhere.
      shortcuts: {...WidgetsApp.defaultShortcuts, const SingleActivator(LogicalKeyboardKey.select): const ActivateIntent()},
      home: ListenableBuilder(
        listenable: api,
        builder: (context, _) => AnimatedSwitcher(
          duration: const Duration(milliseconds: 450),
          child: api.signedIn ? const Shell(key: ValueKey('shell')) : const OnboardingScreen(key: ValueKey('onboarding')),
        ),
      ),
    );
  }
}

class _Tab {
  final String label;
  final IconData icon;
  final Widget Function() build;
  const _Tab(this.label, this.icon, this.build);
}

/// Bottom navigation on phones, a side rail on TV.
class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _index = 0;
  late final List<_Tab> _tabs = [
    _Tab('Home', Icons.home_rounded, () => const HomeScreen()),
    _Tab('Zoeken', Icons.search_rounded, () => const SearchScreen()),
    _Tab('Live tv', Icons.live_tv_rounded, () => const LiveScreen()),
    if (!Device.isTv) _Tab('Downloads', Icons.download_rounded, () => const DownloadsScreen()),
    _Tab('Profiel', Icons.person_rounded, () => const ProfileScreen()),
  ];
  late final List<Widget?> _built = List.filled(_tabs.length, null);

  @override
  Widget build(BuildContext context) {
    _built[_index] ??= _tabs[_index].build();
    final body = IndexedStack(index: _index, children: [for (final w in _built) w ?? const SizedBox.shrink()]);
    if (Device.isTv) {
      return Scaffold(
        body: Row(children: [
          Container(
            width: 92,
            decoration: const BoxDecoration(gradient: LinearGradient(colors: [Color(0xFF0E0A17), K.bg])),
            child: FocusTraversalGroup(
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                const Mushroom(size: 40),
                const SizedBox(height: 30),
                for (var i = 0; i < _tabs.length; i++)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: Semantics(
                      label: _tabs[i].label,
                      button: true,
                      child: Tappable(
                        radius: 16,
                        focusScale: 1.12,
                        onTap: () => setState(() => _index = i),
                        onFocus: (f) {
                          if (f && _index != i) setState(() => _index = i);
                        },
                        child: Container(
                          width: 56,
                          height: 56,
                          decoration: BoxDecoration(color: i == _index ? K.violet.withValues(alpha: 0.3) : Colors.transparent, borderRadius: BorderRadius.circular(16)),
                          child: Icon(_tabs[i].icon, color: i == _index ? K.lilac : K.faint, size: 28),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
          Expanded(child: FocusTraversalGroup(child: body)),
        ]),
      );
    }
    return Scaffold(
      extendBody: true,
      body: body,
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(color: Color(0xF00B0713), border: Border(top: BorderSide(color: K.line))),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 62,
            child: Row(children: [
              for (var i = 0; i < _tabs.length; i++)
                Expanded(
                  child: InkResponse(
                    onTap: () => setState(() => _index = i),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      AnimatedScale(scale: i == _index ? 1.15 : 1, duration: const Duration(milliseconds: 220), curve: K.ease, child: Icon(_tabs[i].icon, color: i == _index ? K.orchid : K.faint)),
                      const SizedBox(height: 3),
                      Text(_tabs[i].label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: i == _index ? K.orchid : K.faint)),
                    ]),
                  ),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}
