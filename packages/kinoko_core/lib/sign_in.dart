import 'package:flutter/material.dart';

import 'api.dart';
import 'theme.dart';
import 'widgets.dart';

/// Server address, then name and password (and the two-factor code when the
/// account asks for it). Shared by the Kinoko apps that have no onboarding of
/// their own. When signing in succeeds, [Session] notifies and the app moves on.
class SignInScreen extends StatefulWidget {
  /// Shown under the logo, e.g. "Music".
  final String subtitle;
  const SignInScreen({super.key, this.subtitle = ''});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  late bool _askServer = !api.hasServer;
  final _url = TextEditingController(text: api.serverUrl);
  final _name = TextEditingController();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false, _needCode = false;
  String? _error;

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _connect() => _run(() async {
        if (_url.text.trim().isEmpty) throw ApiException(0, 'Vul het adres van je Kinoko-server in.');
        await api.connect(_url.text);
        if (mounted) setState(() => _askServer = false);
      });

  Future<void> _signIn() => _run(() async {
        final done = await api.login(_name.text.trim(), _pass.text, code: _code.text.trim());
        // Two-factor sign-in: show the code field and wait for it.
        if (!done && mounted) setState(() => _needCode = true);
      });

  @override
  Widget build(BuildContext context) {
    const gap = SizedBox(height: 12);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Center(child: Mushroom(size: 64)),
                const SizedBox(height: 14),
                const Center(child: Logo(size: 20)),
                if (widget.subtitle.isNotEmpty) Center(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(widget.subtitle.toUpperCase(), style: const TextStyle(color: K.lilac, letterSpacing: 6, fontSize: 12, fontWeight: FontWeight.w700)))),
                const SizedBox(height: 30),
                if (_askServer) ...[
                  const Text('Waar staat je server?', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 6),
                  const Text('Vul het adres in dat je ook in de browser gebruikt.', style: TextStyle(color: K.muted)),
                  const SizedBox(height: 18),
                  TextField(controller: _url, autofocus: true, autocorrect: false, keyboardType: TextInputType.url, textInputAction: TextInputAction.go, onSubmitted: (_) => _connect(), decoration: const InputDecoration(labelText: 'Serveradres', hintText: 'http://192.168.1.10:8096')),
                  const SizedBox(height: 18),
                  KButton('Verbinden', primary: true, expand: true, busy: _busy, onTap: _connect),
                ] else ...[
                  const Text('Welkom terug', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 6),
                  Text('Log in op ${api.serverName}.', style: const TextStyle(color: K.muted)),
                  const SizedBox(height: 18),
                  TextField(controller: _name, autofocus: true, autocorrect: false, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Naam')),
                  gap,
                  TextField(controller: _pass, obscureText: true, textInputAction: TextInputAction.go, onSubmitted: (_) => _signIn(), decoration: const InputDecoration(labelText: 'Wachtwoord')),
                  if (_needCode) ...[
                    gap,
                    TextField(controller: _code, autofocus: true, autocorrect: false, textInputAction: TextInputAction.go, onSubmitted: (_) => _signIn(), decoration: const InputDecoration(labelText: 'Code uit je authenticator-app', helperText: 'Of een herstelcode')),
                  ],
                  const SizedBox(height: 18),
                  KButton('Inloggen', primary: true, expand: true, busy: _busy, onTap: _signIn),
                  TextButton(
                    onPressed: () => setState(() {
                      _askServer = true;
                      _error = null;
                    }),
                    child: const Text('Andere server', style: TextStyle(color: K.muted)),
                  ),
                ],
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: K.bad))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
