import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

/// First run: a short introduction, then server address, then sign-in.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

enum _Stage { intro, server, login }

class _OnboardingScreenState extends State<OnboardingScreen> with SingleTickerProviderStateMixin {
  late _Stage _stage;
  late final AnimationController _drift = AnimationController(vsync: this, duration: const Duration(seconds: 16))..repeat(reverse: true);
  final _page = PageController();
  int _slide = 0;

  final _url = TextEditingController();
  final _name = TextEditingController();
  final _pass = TextEditingController();
  final _invite = TextEditingController();
  bool _busy = false;
  bool _withInvite = false;
  String? _error;

  static const _slides = [
    (Icons.movie_filter_rounded, 'Je eigen streamingdienst', 'Films en series van je eigen server, met posters, cast en slimme collecties — helemaal van jou.'),
    (Icons.groups_rounded, 'Kijk samen, ook op afstand', 'Nodig iemand uit met een link. Pauzeert de één, dan pauzeert het bij iedereen.'),
    (Icons.download_for_offline_rounded, 'Download en ga', 'Zet films en afleveringen op je toestel en kijk zonder internet. Intro\'s sla je met één tik over.'),
    (Icons.casino_rounded, 'Watch Night', 'Geen idee wat je wilt kijken? Laat het seizoen kiezen en dobbel voor drie films.'),
  ];

  @override
  void initState() {
    super.initState();
    _stage = !api.introSeen ? _Stage.intro : (api.hasServer ? _Stage.login : _Stage.server);
    _url.text = api.serverUrl;
  }

  @override
  void dispose() {
    _drift.dispose();
    _page.dispose();
    _url.dispose();
    _name.dispose();
    _pass.dispose();
    _invite.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _nextSlide() {
    if (_slide < _slides.length - 1) {
      _page.nextPage(duration: const Duration(milliseconds: 450), curve: K.ease);
    } else {
      api.markIntroSeen();
      setState(() => _stage = api.hasServer ? _Stage.login : _Stage.server);
    }
  }

  Future<void> _connect() => _run(() async {
        if (_url.text.trim().isEmpty) throw ApiException(0, 'Vul het adres van je Kinoko-server in.');
        await api.connect(_url.text);
        if (mounted) setState(() => _stage = _Stage.login);
      });

  Future<void> _signIn() => _run(() async {
        if (_withInvite) {
          // Accept a pasted invite link as well as the bare code.
          final code = _invite.text.trim().split('/').last;
          await api.register(code, _name.text.trim(), _pass.text);
        } else {
          await api.login(_name.text.trim(), _pass.text);
        }
      });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(children: [
        // Slow drifting purple glow behind everything.
        AnimatedBuilder(
          animation: _drift,
          builder: (_, __) => CustomPaint(painter: _GlowPainter(_drift.value), size: Size.infinite),
        ),
        SafeArea(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 420),
            switchInCurve: K.ease,
            transitionBuilder: (child, anim) => FadeTransition(
              opacity: anim,
              child: SlideTransition(position: Tween(begin: const Offset(0.06, 0), end: Offset.zero).animate(anim), child: child),
            ),
            child: switch (_stage) {
              _Stage.intro => _intro(),
              _Stage.server => _form(key: const ValueKey('server'), children: _serverFields()),
              _Stage.login => _form(key: const ValueKey('login'), children: _loginFields()),
            },
          ),
        ),
      ]),
    );
  }

  Widget _intro() {
    return Column(key: const ValueKey('intro'), children: [
      const SizedBox(height: 26),
      const Logo(size: 22),
      Expanded(
        child: PageView.builder(
          controller: _page,
          itemCount: _slides.length,
          onPageChanged: (i) => setState(() => _slide = i),
          itemBuilder: (_, i) {
            final (icon, title, text) = _slides[i];
            return Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    TweenAnimationBuilder<double>(
                      key: ValueKey(i),
                      tween: Tween(begin: 0.6, end: 1),
                      duration: const Duration(milliseconds: 700),
                      curve: Curves.elasticOut,
                      builder: (_, v, child) => Transform.scale(scale: v, child: child),
                      child: Container(
                        width: 132,
                        height: 132,
                        decoration: BoxDecoration(
                          gradient: K.gradient,
                          borderRadius: BorderRadius.circular(38),
                          boxShadow: [BoxShadow(color: K.violet.withValues(alpha: 0.6), blurRadius: 60, spreadRadius: 4)],
                        ),
                        child: i == 0 ? const Center(child: Mushroom(size: 92)) : Icon(icon, size: 66, color: Colors.white),
                      ),
                    ),
                    const SizedBox(height: 40),
                    Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -0.6, height: 1.15)),
                    const SizedBox(height: 14),
                    Text(text, textAlign: TextAlign.center, style: const TextStyle(color: K.muted, fontSize: 16, height: 1.5)),
                  ]),
                ),
              ),
            );
          },
        ),
      ),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        for (var i = 0; i < _slides.length; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            margin: const EdgeInsets.symmetric(horizontal: 3),
            width: i == _slide ? 26 : 8,
            height: 6,
            decoration: BoxDecoration(color: i == _slide ? K.orchid : K.surface3, borderRadius: BorderRadius.circular(6)),
          ),
      ]),
      Padding(
        padding: const EdgeInsets.fromLTRB(28, 26, 28, 28),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(children: [
            KButton(_slide == _slides.length - 1 ? 'Aan de slag' : 'Volgende', primary: true, expand: true, autofocus: true, onTap: _nextSlide),
            const SizedBox(height: 10),
            if (_slide < _slides.length - 1)
              TextButton(
                onPressed: () {
                  api.markIntroSeen();
                  setState(() => _stage = api.hasServer ? _Stage.login : _Stage.server);
                },
                child: const Text('Overslaan', style: TextStyle(color: K.muted)),
              )
            else
              const SizedBox(height: 48),
          ]),
        ),
      ),
    ]);
  }

  Widget _form({required Key key, required List<Widget> children}) {
    return Center(
      key: key,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Container(
            padding: const EdgeInsets.all(26),
            decoration: BoxDecoration(color: K.surface.withValues(alpha: 0.86), borderRadius: BorderRadius.circular(24), border: Border.all(color: K.line)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              const Align(alignment: Alignment.centerLeft, child: Logo(size: 20)),
              const SizedBox(height: 22),
              ...children,
              if (_error != null) ...[
                const SizedBox(height: 14),
                Text(_error!, style: const TextStyle(color: K.bad)),
              ],
            ]),
          ),
        ),
      ),
    );
  }

  List<Widget> _serverFields() => [
        const Text('Verbind met je server', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        const Text('Vul het adres in dat je van de beheerder kreeg. Het staat ook in het beheer van de server, bij Overzicht.', style: TextStyle(color: K.muted)),
        const SizedBox(height: 20),
        TextField(
          controller: _url,
          autofocus: !Device.isTv,
          keyboardType: TextInputType.url,
          autocorrect: false,
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _connect(),
          decoration: const InputDecoration(labelText: 'Serveradres', hintText: 'kinoko.voorbeeld.nl of 192.168.1.10'),
        ),
        const SizedBox(height: 18),
        KButton('Verbinden', primary: true, expand: true, busy: _busy, onTap: _connect, autofocus: Device.isTv),
      ];

  List<Widget> _loginFields() => [
        Text(_withInvite ? 'Account aanmaken' : 'Welkom terug', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        Text(_withInvite ? 'Gebruik de uitnodiging die je kreeg voor ${api.serverName}.' : 'Log in op ${api.serverName}.', style: const TextStyle(color: K.muted)),
        const SizedBox(height: 20),
        if (_withInvite) ...[
          TextField(controller: _invite, autocorrect: false, decoration: const InputDecoration(labelText: 'Uitnodigingscode of -link')),
          const SizedBox(height: 12),
        ],
        TextField(controller: _name, autofocus: !Device.isTv, autocorrect: false, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Naam')),
        const SizedBox(height: 12),
        TextField(controller: _pass, obscureText: true, textInputAction: TextInputAction.go, onSubmitted: (_) => _signIn(), decoration: const InputDecoration(labelText: 'Wachtwoord')),
        const SizedBox(height: 18),
        KButton(_withInvite ? 'Account aanmaken' : 'Inloggen', primary: true, expand: true, busy: _busy, onTap: _signIn, autofocus: Device.isTv),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => setState(() {
            _withInvite = !_withInvite;
            _error = null;
          }),
          child: Text(_withInvite ? 'Ik heb al een account' : 'Ik heb een uitnodiging', style: const TextStyle(color: K.orchid)),
        ),
        TextButton(
          onPressed: () => setState(() {
            _stage = _Stage.server;
            _error = null;
          }),
          child: const Text('Andere server', style: TextStyle(color: K.muted)),
        ),
      ];
}

class _GlowPainter extends CustomPainter {
  final double t;
  _GlowPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = K.bg);
    void blob(Offset c, double r, Color color) {
      canvas.drawCircle(c, r, Paint()..shader = RadialGradient(colors: [color, color.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: c, radius: r)));
    }

    final m = math.max(size.width, size.height);
    blob(Offset(size.width * (0.1 + 0.15 * t), size.height * (0.05 + 0.1 * t)), m * 0.6, const Color(0x664C1D95));
    blob(Offset(size.width * (0.95 - 0.2 * t), size.height * (0.95 - 0.12 * t)), m * 0.55, const Color(0x4486198F));
  }

  @override
  bool shouldRepaint(covariant _GlowPainter old) => old.t != t;
}
