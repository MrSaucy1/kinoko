import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import 'admin.dart';
import 'browse.dart';
import 'player.dart';
import 'watch_night.dart';

/// Asks for a room code and joins that Watch Together session.
Future<void> joinRoomDialog(BuildContext context, {String? code}) async {
  final ctl = TextEditingController(text: code ?? '');
  final entered = code ??
      await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Samen kijken'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Vul de code in die je kreeg (6 tekens).', style: TextStyle(color: K.muted)),
            const SizedBox(height: 14),
            TextField(controller: ctl, autofocus: true, textCapitalization: TextCapitalization.characters, maxLength: 6, style: const TextStyle(fontSize: 26, letterSpacing: 6, fontWeight: FontWeight.w800), onSubmitted: (v) => Navigator.pop(ctx, v)),
          ]),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('Meekijken'))],
        ),
      );
  if (entered == null || entered.trim().isEmpty || !context.mounted) return;
  final c = entered.trim().toUpperCase();
  try {
    await api.get('/api/watch/$c');
    if (context.mounted) await openPlayer(context, PlayRequest(roomCode: c));
  } catch (e) {
    if (context.mounted) showMessage(context, e);
  }
}

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final u = api.user ?? const {};
    final pad = Device.isTv ? 48.0 : 16.0;
    Widget item(IconData icon, String title, String sub, VoidCallback onTap, {bool autofocus = false}) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Tappable(
            radius: 14,
            focusScale: 1.02,
            autofocus: autofocus,
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: K.line)),
              child: Row(children: [
                Container(width: 42, height: 42, decoration: BoxDecoration(color: K.surface3, borderRadius: BorderRadius.circular(12)), child: Icon(icon, color: K.lilac)),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: const TextStyle(fontWeight: FontWeight.w700)), Text(sub, style: const TextStyle(color: K.muted, fontSize: 13))])),
                const Icon(Icons.chevron_right_rounded, color: K.faint),
              ]),
            ),
          ),
        );
    return SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: ListView(padding: EdgeInsets.fromLTRB(pad, 22, pad, 40), children: [
            Row(children: [
              Container(
                width: 64,
                height: 64,
                alignment: Alignment.center,
                decoration: BoxDecoration(gradient: K.gradient, borderRadius: BorderRadius.circular(20)),
                child: Text((u['name'] ?? '?').toString().characters.first.toUpperCase(), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900)),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text((u['name'] ?? '').toString(), style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
                  Text('${api.serverName} · ${api.serverUrl}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 13)),
                ]),
              ),
            ]),
            const SizedBox(height: 24),
            item(Icons.groups_rounded, 'Samen kijken', 'Doe mee met een code van iemand anders', () => joinRoomDialog(context), autofocus: Device.isTv),
            item(Icons.favorite_rounded, 'Mijn lijst', 'Alles wat je hebt bewaard', () => Navigator.push(context, MaterialPageRoute(builder: (_) => const _MyList()))),
            item(Icons.casino_rounded, 'Watch Night', 'Dobbel voor drie films die bij het seizoen passen', () => openWatchNight(context)),
            item(Icons.devices_rounded, 'Apparaten', 'Waar je account is ingelogd; log een apparaat uit', () => Navigator.push(context, MaterialPageRoute(builder: (_) => const _Devices()))),
            if (u['role'] == 'admin') item(Icons.admin_panel_settings_rounded, 'Beheer', 'Bibliotheken, gebruikers, live tv en instellingen van de server', () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AdminScreen()))),
            item(Icons.logout_rounded, 'Uitloggen', 'Je blijft verbonden met deze server', () => api.logout()),
            item(Icons.dns_rounded, 'Andere server', 'Uitloggen en een ander serveradres invullen', () => api.logout(forgetServer: true)),
            const SizedBox(height: 18),
            const Center(child: Logo(size: 14)),
          ]),
        ),
      ),
    );
  }
}

class _MyList extends StatefulWidget {
  const _MyList();
  @override
  State<_MyList> createState() => _MyListState();
}

class _MyListState extends State<_MyList> {
  late Future<Json> _future = api.get('/api/home');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mijn lijst', style: TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: Loader<Json>(
        future: _future,
        builder: (context, d) {
          final row = listOf(d['rows']).where((r) => r['id'] == 'mylist').firstOrNull;
          return TitleGrid(listOf(row?['items']), onChanged: () => setState(() => _future = api.get('/api/home')));
        },
      ),
    );
  }
}

/// Every place this account is signed in, with a way to sign each one out.
class _Devices extends StatefulWidget {
  const _Devices();
  @override
  State<_Devices> createState() => _DevicesState();
}

class _DevicesState extends State<_Devices> {
  late Future<Json> _future = api.get('/api/auth/sessions');
  bool _busy = false;

  static String _when(dynamic ts) {
    final d = DateTime.fromMillisecondsSinceEpoch(((ts as num?) ?? 0).toInt() * 1000);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.day}-${d.month}-${d.year} ${two(d.hour)}:${two(d.minute)}';
  }

  Future<void> _run(Future<Json> Function() action, String done) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
      if (mounted) showMessage(context, done);
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _future = api.get('/api/auth/sessions');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Scaffold(
      appBar: AppBar(title: const Text('Apparaten', style: TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: Loader<Json>(
        future: _future,
        onRetry: () => setState(() => _future = api.get('/api/auth/sessions')),
        builder: (context, d) {
          final sessions = listOf(d['sessions']);
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: ListView(padding: EdgeInsets.fromLTRB(pad, 12, pad, 40), children: [
                const Text('Hier is je account ingelogd. Herken je er een niet? Log het uit en wijzig je wachtwoord.', style: TextStyle(color: K.muted)),
                const SizedBox(height: 16),
                for (final s in sessions)
                  Container(
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: K.line)),
                    child: Row(children: [
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(children: [
                            Flexible(child: Text((s['device'] ?? '').toString().isEmpty ? 'Onbekend apparaat' : s['device'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700))),
                            if (s['current'] == true) ...[const SizedBox(width: 8), const Badge2('Dit apparaat')],
                          ]),
                          const SizedBox(height: 2),
                          Text('Laatst gebruikt ${_when(s['last_seen'])}', style: const TextStyle(color: K.muted, fontSize: 13)),
                        ]),
                      ),
                      if (s['current'] != true) ...[
                        const SizedBox(width: 10),
                        KButton('Uitloggen', onTap: _busy ? null : () => _run(() => api.delete('/api/auth/sessions/${s['id']}'), 'Apparaat uitgelogd')),
                      ],
                    ]),
                  ),
                const SizedBox(height: 8),
                KButton(
                  'Overal anders uitloggen',
                  icon: Icons.logout_rounded,
                  expand: true,
                  autofocus: Device.isTv,
                  onTap: _busy || sessions.length < 2 ? null : () => _run(() => api.post('/api/auth/sessions/revoke-others', const {}), 'Alle andere apparaten zijn uitgelogd'),
                ),
                const SizedBox(height: 14),
                Text('Een apparaat dat ${d['idleDays'] ?? 90} dagen niet is gebruikt, wordt vanzelf uitgelogd.', style: const TextStyle(color: K.faint, fontSize: 13)),
              ]),
            ),
          );
        },
      ),
    );
  }
}
