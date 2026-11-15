import 'package:flutter/material.dart';

import 'api.dart';
import 'theme.dart';
import 'widgets.dart';

/// "Afspelen op…": lets the server start this film or song on a Chromecast or
/// DLNA device in the house, and gives a small remote for it afterwards.
/// [body] names what to play: {'fileId': ..} or {'trackId': ..}, plus 'position'.
Future<void> showCastSheet(BuildContext context, Json body, {VoidCallback? onStarted}) {
  return showModalBottomSheet<void>(context: context, useRootNavigator: true, isScrollControlled: true, builder: (_) => _CastSheet(body, onStarted));
}

class _CastSheet extends StatefulWidget {
  final Json body;
  final VoidCallback? onStarted;
  const _CastSheet(this.body, this.onStarted);
  @override
  State<_CastSheet> createState() => _CastSheetState();
}

class _CastSheetState extends State<_CastSheet> {
  late final Future<Json> _devices = api.get('/api/cast/devices');
  Json? _playing; // {id, device, title}
  bool _paused = false, _busy = false;

  Future<void> _start(Json dev) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await api.post('/api/cast/${dev['id']}/play', widget.body);
      widget.onStarted?.call();
      if (mounted) setState(() => _playing = {'id': dev['id'], 'device': r['device'], 'title': r['title']});
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _control(String cmd) async {
    try {
      await api.post('/api/cast/${_playing!['id']}/control', {'cmd': cmd});
      if (!mounted) return;
      if (cmd == 'stop') return Navigator.pop(context);
      setState(() => _paused = cmd == 'pause');
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _playing;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
        child: p != null
            ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Speelt op ${p['device']}', style: const TextStyle(color: K.muted)),
                Text('${p['title']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                const SizedBox(height: 16),
                Row(children: [
                  KButton(_paused ? 'Verder' : 'Pauze', icon: _paused ? Icons.play_arrow_rounded : Icons.pause_rounded, primary: true, onTap: () => _control(_paused ? 'play' : 'pause')),
                  const SizedBox(width: 10),
                  KButton('Stoppen', icon: Icons.stop_rounded, onTap: () => _control('stop')),
                ]),
              ])
            : Loader<Json>(
                future: _devices,
                builder: (context, d) {
                  final list = listOf(d['devices']);
                  return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Afspelen op…', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    const Text("Chromecasts en tv's of versterkers (DLNA) in hetzelfde netwerk als de server.", style: TextStyle(color: K.muted, fontSize: 13)),
                    const SizedBox(height: 8),
                    if (list.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Text('Geen apparaten gevonden. Staat het apparaat aan?', style: TextStyle(color: K.muted))),
                    for (final dev in list)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        enabled: !_busy,
                        leading: Icon(dev['kind'] == 'chromecast' ? Icons.cast_rounded : Icons.speaker_rounded, color: K.lilac),
                        title: Text('${dev['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Text(dev['kind'] == 'chromecast' ? 'Chromecast' : 'DLNA', style: const TextStyle(color: K.muted, fontSize: 12.5)),
                        onTap: () => _start(dev),
                      ),
                  ]);
                },
              ),
      ),
    );
  }
}
