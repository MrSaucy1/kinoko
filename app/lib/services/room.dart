import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/api.dart';

class RoomMessage {
  final String from;
  final String text;
  final bool system;
  RoomMessage(this.from, this.text, {this.system = false});
}

/// Client side of Watch Together: one shared play/pause/seek state per room.
class WatchRoom extends ChangeNotifier {
  final String code;
  final String? guest;
  WatchRoom(this.code, {this.guest});

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  String? me;
  List<Json> members = [];
  final List<RoomMessage> log = [];
  bool connected = false;

  /// playing, position (seconds)
  void Function(bool playing, double position, String? by, String? action)? onState;
  void Function(Json room)? onLoad;
  void Function(String emoji)? onReaction;

  void connect() {
    final q = guest != null ? 'guest=${Uri.encodeComponent(guest!)}' : 'token=${Uri.encodeComponent(api.token)}';
    _ch = WebSocketChannel.connect(Uri.parse(api.wsUrl('/api/watch/$code/ws?$q')));
    _sub = _ch!.stream.listen(_onMessage, onDone: _closed, onError: (_) => _closed());
  }

  void _closed() {
    if (!connected) return;
    connected = false;
    log.add(RoomMessage('', 'Verbinding verbroken.', system: true));
    notifyListeners();
  }

  void _onMessage(dynamic raw) {
    final Json m;
    try {
      m = jsonDecode(raw as String) as Json;
    } catch (_) {
      return;
    }
    final state = m['state'] as Json?;
    switch (m['t']) {
      case 'hello':
        connected = true;
        me = m['you'] as String?;
        members = listOf((m['room'] as Json?)?['members']);
        log.add(RoomMessage('', 'Je kijkt nu samen. Iedereen kan pauzeren en spoelen.', system: true));
        if (state != null) onState?.call(state['playing'] == true, numOf(state['position']), null, null);
      case 'members':
        members = listOf(m['members']);
        if (m['joined'] != null) log.add(RoomMessage('', '${m['joined']} kijkt mee', system: true));
        if (m['left'] != null) log.add(RoomMessage('', '${m['left']} is weg', system: true));
      case 'state':
        if (m['byId'] != me && state != null) onState?.call(state['playing'] == true, numOf(state['position']), m['by'] as String?, m['action'] as String?);
      case 'load':
        final room = m['room'] as Json?;
        if (room != null) onLoad?.call(room);
      case 'chat':
        log.add(RoomMessage((m['from'] ?? '').toString(), (m['text'] ?? '').toString()));
      case 'react':
        onReaction?.call((m['emoji'] ?? '').toString());
    }
    notifyListeners();
  }

  void _send(Json m) {
    if (connected) _ch?.sink.add(jsonEncode(m));
  }

  void play(double position) => _send({'t': 'play', 'position': position});
  void pause(double position) => _send({'t': 'pause', 'position': position});
  void seek(double position) => _send({'t': 'seek', 'position': position});
  void load(int fileId) => _send({'t': 'load', 'fileId': fileId});
  void chat(String text) => _send({'t': 'chat', 'text': text});
  void react(String emoji) => _send({'t': 'react', 'emoji': emoji});

  @override
  void dispose() {
    connected = false;
    _sub?.cancel();
    _ch?.sink.close();
    super.dispose();
  }
}
