import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../core/api.dart';
import '../core/theme.dart';

/// Server management for admins: the server's own admin pages, shown inside
/// the app and signed in with the app's session.
class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});
  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  late final WebViewController _web;
  bool _signedIn = false; // the session has been handed to the page
  bool _loading = true;
  String? _error;

  // Only the admin pages belong here: the site's own navigation (and its
  // log-out button, which would end the app's session too) is hidden.
  static const _style = '.topbar,.tabbar{display:none!important}'
      '.admin{padding-top:0!important}'
      '.admin-nav{top:0!important}'
      '@media(min-width:821px){.admin-nav{height:100vh!important}}';

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(K.bg)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: _onPage,
        onWebResourceError: (e) {
          if (e.isForMainFrame ?? true) setState(() => _error = 'De server is niet bereikbaar (${e.description}).');
        },
      ));
    _load();
  }

  // A page without scripts from the same address comes first, so the session
  // can be stored before the admin pages start up.
  void _load() {
    setState(() {
      _signedIn = false;
      _loading = true;
      _error = null;
    });
    _web.loadRequest(Uri.parse('${api.serverUrl}/favicon.svg'));
  }

  Future<void> _onPage(String url) async {
    if (!mounted) return;
    if (!_signedIn) {
      _signedIn = true;
      await _web.runJavaScript('localStorage.setItem("kinoko_token", ${jsonEncode(api.token)});');
      await _web.loadRequest(Uri.parse('${api.serverUrl}/beheer'));
      return;
    }
    await _web.runJavaScript('(function(){var s=document.createElement("style");s.textContent=${jsonEncode(_style)};document.head.appendChild(s);})();');
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final nav = Navigator.of(context);
        // Back first steps back inside the admin pages, then leaves them.
        if (_error == null && await _web.canGoBack() && !((await _web.currentUrl()) ?? '').endsWith('/beheer')) {
          await _web.goBack();
        } else {
          nav.pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Beheer', style: TextStyle(fontWeight: FontWeight.w800)),
          leading: IconButton(icon: const Icon(Icons.close_rounded), tooltip: 'Sluiten', onPressed: () => Navigator.of(context).pop()),
          actions: [IconButton(icon: const Icon(Icons.refresh_rounded), tooltip: 'Opnieuw laden', onPressed: _load)],
        ),
        body: _error != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: K.muted)),
                    const SizedBox(height: 14),
                    TextButton(onPressed: _load, child: const Text('Opnieuw proberen')),
                  ]),
                ),
              )
            : Stack(children: [
                WebViewWidget(controller: _web),
                if (_loading) const ColoredBox(color: K.bg, child: Center(child: CircularProgressIndicator(color: K.orchid))),
              ]),
      ),
    );
  }
}
