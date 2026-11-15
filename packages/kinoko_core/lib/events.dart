import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

/// Live messages from the server for the signed-in account, e.g. "you paused
/// on another device — continue here?". Reconnects by itself; the app works
/// the same without it.
class ServerEvents {
  ServerEvents._();
  static final instance = ServerEvents._();

  /// Set before the first [sync] by an app that plays music: it then shows up as a
  /// device in Kinoko Connect and may be controlled from the user's other devices.
  bool player = false;

  /// The id the server gave this connection (to recognise ourselves in the device list).
  String? id;

  /// Sends a message to the server; dropped silently when not connected.
  void send(Json message) {
    try {
      _ch?.sink.add(jsonEncode(message));
    } catch (_) {
      // Not connected right now.
    }
  }

  final _out = StreamController<Json>.broadcast();
  Stream<Json> get stream => _out.stream;

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry, _beat;
  String _for = '';

  /// Call whenever sign-in state may have changed.
  void sync() {
    final want = api.signedIn ? '${api.serverUrl}|${api.token}' : '';
    if (want == _for) return;
    _close();
    _for = want;
    if (want.isNotEmpty) _connect();
  }

  void _connect() {
    if (_for.isEmpty) return;
    try {
      _ch = WebSocketChannel.connect(Uri.parse(api.wsUrl('/api/events/ws?token=${Uri.encodeComponent(api.token)}&device=${Uri.encodeComponent(Device.name)}${player ? '&player=1' : ''}')));
      _sub = _ch!.stream.listen((raw) {
        try {
          final m = jsonDecode(raw.toString());
          if (m is Map<String, dynamic>) {
            if (m['t'] == 'hello') id = m['id'] as String?;
            _out.add(m);
          }
        } catch (_) {
          // Not for us.
        }
      }, onDone: _lost, onError: (_) => _lost());
      _beat = Timer.periodic(const Duration(seconds: 40), (_) => _ch?.sink.add('ping'));
    } catch (_) {
      _lost();
    }
  }

  void _lost() {
    final again = _for;
    _close();
    _for = again;
    if (again.isNotEmpty) _retry = Timer(const Duration(seconds: 15), _connect);
  }

  void _close() {
    _retry?.cancel();
    _beat?.cancel();
    _sub?.cancel();
    _ch?.sink.close();
    _ch = null;
    _sub = null;
    _for = '';
  }
}
