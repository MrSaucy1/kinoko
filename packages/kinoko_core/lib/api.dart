import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

typedef Json = Map<String, dynamic>;

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => message;
}

/// Which variant of the app is running. Set once in main().
class Device {
  static bool isTv = false;

  /// How this app names itself to the server (shown under "Apparaten"). Null: Android / Android TV.
  static String? label;
  static String get name => label ?? (isTv ? 'Android TV' : 'Android');
}

/// The signed-in session and the HTTP client for the user's Kinoko server.
class Session extends ChangeNotifier {
  Session._();
  static final Session instance = Session._();

  late SharedPreferences _prefs;
  String serverUrl = '';
  String serverName = 'Kinoko';
  String token = '';
  Json? user;

  bool get hasServer => serverUrl.isNotEmpty;
  bool get signedIn => token.isNotEmpty && user != null;
  bool get introSeen => _prefs.getBool('intro_seen') ?? false;
  SharedPreferences get prefs => _prefs;

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    serverUrl = _prefs.getString('server_url') ?? '';
    serverName = _prefs.getString('server_name') ?? 'Kinoko';
    token = _prefs.getString('token') ?? '';
    final u = _prefs.getString('user');
    if (u != null) {
      try {
        user = jsonDecode(u) as Json;
      } catch (_) {
        user = null;
      }
    }
  }

  Future<void> markIntroSeen() => _prefs.setBool('intro_seen', true);

  /// Normalises what people type ("192.168.1.5", "kinoko.example.nl/").
  static String cleanUrl(String input) {
    var u = input.trim().replaceAll(RegExp(r'/+$'), '');
    if (u.isEmpty) return u;
    if (!u.startsWith(RegExp(r'https?://'))) {
      final looksLocal = RegExp(r'^(\d{1,3}\.){3}\d{1,3}|^localhost|\.local(:|$)|^[^.]+(:\d+)?$').hasMatch(u);
      u = '${looksLocal ? 'http' : 'https'}://$u';
    }
    // A bare LAN address without a port means the default Kinoko port.
    final uri = Uri.tryParse(u);
    if (uri != null && !uri.hasPort && uri.scheme == 'http') u = '$u:8096';
    return u;
  }

  /// Checks that [url] is a Kinoko server and remembers it.
  Future<Json> connect(String url) async {
    final clean = cleanUrl(url);
    late http.Response r;
    try {
      r = await http.get(Uri.parse('$clean/api/info')).timeout(const Duration(seconds: 10));
    } catch (_) {
      throw ApiException(0, 'Kan de server niet bereiken. Controleer het adres en je verbinding.');
    }
    Json info;
    try {
      info = jsonDecode(utf8.decode(r.bodyBytes)) as Json;
    } catch (_) {
      throw ApiException(r.statusCode, 'Op dit adres draait geen Kinoko-server.');
    }
    if (info['product'] != 'kinoko') throw ApiException(r.statusCode, 'Op dit adres draait geen Kinoko-server.');
    if (info['needsSetup'] == true) {
      throw ApiException(409, 'Deze server is nog niet ingesteld. Open $clean in een browser om hem in te richten.');
    }
    serverUrl = clean;
    serverName = (info['name'] ?? 'Kinoko').toString();
    await _prefs.setString('server_url', serverUrl);
    await _prefs.setString('server_name', serverName);
    notifyListeners();
    return info;
  }

  /// Re-reads the account from the server (after a change to it, e.g. two-factor sign-in).
  Future<void> refreshUser() async {
    final r = await get('/api/auth/me');
    user = r['user'] as Json;
    await _prefs.setString('user', jsonEncode(user));
    notifyListeners();
  }

  Future<void> _saveLogin(Json r) async {
    token = r['token'] as String;
    user = r['user'] as Json;
    await _prefs.setString('token', token);
    await _prefs.setString('user', jsonEncode(user));
    notifyListeners();
  }

  /// Returns false when the account uses two-factor sign-in and [code] is still needed.
  Future<bool> login(String name, String password, {String code = ''}) async {
    final r = await post('/api/auth/login', {'name': name, 'password': password, 'device': Device.name, if (code.isNotEmpty) 'code': code});
    if (r['totpRequired'] == true) return false;
    await _saveLogin(r);
    return true;
  }

  Future<void> register(String code, String name, String password) async {
    final r = await post('/api/auth/register', {'code': code, 'name': name, 'password': password, 'device': Device.name});
    await _saveLogin(r);
  }

  Future<void> logout({bool forgetServer = false}) async {
    if (token.isNotEmpty) {
      try {
        await post('/api/auth/logout', {});
      } catch (_) {
        // Already signed out on the server, or offline: local sign-out still applies.
      }
    }
    token = '';
    user = null;
    await _prefs.remove('token');
    await _prefs.remove('user');
    if (forgetServer) {
      serverUrl = '';
      await _prefs.remove('server_url');
    }
    notifyListeners();
  }

  /// Absolute URL for a path the server returned ("/api/img/..."), or null.
  String? abs(Object? path) {
    if (path == null) return null;
    final p = path.toString();
    if (p.isEmpty) return null;
    return p.startsWith('http') ? p : '$serverUrl$p';
  }

  String wsUrl(String path) => '${serverUrl.replaceFirst('http', 'ws')}$path';

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  Future<Json> _send(Future<http.Response> Function() call) async {
    late http.Response r;
    try {
      r = await call().timeout(const Duration(seconds: 25));
    } on TimeoutException {
      throw ApiException(0, 'De server reageert niet.');
    } catch (_) {
      throw ApiException(0, 'Geen verbinding met de server.');
    }
    Json data = {};
    try {
      final decoded = jsonDecode(utf8.decode(r.bodyBytes));
      if (decoded is Map<String, dynamic>) data = decoded;
    } catch (_) {
      // Non-JSON body: handled by the status check below.
    }
    if (r.statusCode >= 400) {
      if (r.statusCode == 401 && token.isNotEmpty) {
        token = '';
        user = null;
        await _prefs.remove('token');
        notifyListeners();
      }
      throw ApiException(r.statusCode, (data['error'] ?? 'Er ging iets mis (${r.statusCode}).').toString());
    }
    return data;
  }

  Future<Json> get(String path) => _send(() => http.get(Uri.parse('$serverUrl$path'), headers: _headers));
  Future<Json> post(String path, Object body, {Map<String, String> headers = const {}}) =>
      _send(() => http.post(Uri.parse('$serverUrl$path'), headers: {..._headers, ...headers}, body: jsonEncode(body)));
  Future<Json> put(String path, [Object body = const {}]) => _send(() => http.put(Uri.parse('$serverUrl$path'), headers: _headers, body: jsonEncode(body)));
  Future<Json> delete(String path) => _send(() => http.delete(Uri.parse('$serverUrl$path'), headers: {if (token.isNotEmpty) 'Authorization': 'Bearer $token'}));
}

final api = Session.instance;

List<Json> listOf(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : const [];
List<String> strings(Object? v) => v is List ? v.map((e) => e.toString()).toList() : const [];
double numOf(Object? v) => v is num ? v.toDouble() : 0;
