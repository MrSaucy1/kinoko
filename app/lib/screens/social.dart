import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import 'detail.dart';

Future<String?> _askName(BuildContext context, String title, {String initial = ''}) {
  final ctl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctl, autofocus: true, maxLength: 60, decoration: const InputDecoration(labelText: 'Naam'), onSubmitted: (v) => Navigator.pop(ctx, v)),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('Opslaan'))],
    ),
  );
}

/// Lets the user tick the lists a title should be on.
Future<void> addToListSheet(BuildContext context, Json title) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    constraints: BoxConstraints(maxWidth: 520, maxHeight: MediaQuery.sizeOf(context).height * 0.8),
    builder: (_) => _AddToList(title),
  );
}

class _AddToList extends StatefulWidget {
  final Json title;
  const _AddToList(this.title);
  @override
  State<_AddToList> createState() => _AddToListState();
}

class _AddToListState extends State<_AddToList> {
  late Future<Json> _future = _load();
  Future<Json> _load() => api.get('/api/lists?title=${widget.title['id']}');

  Future<void> _toggle(Json l, bool on) async {
    setState(() => l['has'] = on); // shown at once; put back if the server refuses
    try {
      final path = '/api/lists/${l['id']}/items/${widget.title['id']}';
      if (on) {
        await api.put(path);
      } else {
        await api.delete(path);
      }
    } catch (e) {
      if (mounted) {
        setState(() => l['has'] = !on);
        showMessage(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Loader<Json>(
        future: _future,
        builder: (context, d) {
          final lists = listOf(d['lists']).where((l) => l['canEdit'] == true).toList();
          return ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 18, 16, 16), children: [
            const Text('Aan een lijst toevoegen', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            if (lists.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Text('Je hebt nog geen lijsten.', style: TextStyle(color: K.muted))),
            for (final l in lists)
              CheckboxListTile(
                value: l['has'] == true,
                onChanged: (v) => _toggle(l, v ?? false),
                activeColor: K.violet,
                contentPadding: EdgeInsets.zero,
                title: Text(l['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(l['mine'] == true ? '${l['count']} titels' : 'van ${l['owner']}', style: const TextStyle(color: K.muted, fontSize: 13)),
              ),
            const SizedBox(height: 8),
            KButton('Nieuwe lijst', icon: Icons.add_rounded, expand: true, onTap: () async {
              final name = await _askName(context, 'Nieuwe lijst');
              if (name == null || name.trim().isEmpty) return;
              try {
                final r = await api.post('/api/lists', {'name': name});
                await api.put('/api/lists/${r['id']}/items/${widget.title['id']}');
                if (mounted) setState(() => _future = _load());
              } catch (e) {
                if (context.mounted) showMessage(context, e);
              }
            }),
          ]);
        },
      ),
    );
  }
}

/// All lists of the user: their own and the ones shared with them.
class ListsScreen extends StatefulWidget {
  const ListsScreen({super.key});
  @override
  State<ListsScreen> createState() => _ListsScreenState();
}

class _ListsScreenState extends State<ListsScreen> {
  late Future<Json> _future = api.get('/api/lists');
  void _reload() => setState(() => _future = api.get('/api/lists'));

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Scaffold(
      appBar: AppBar(title: const Text('Lijsten', style: TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: Loader<Json>(
        future: _future,
        onRetry: _reload,
        builder: (context, d) {
          final lists = listOf(d['lists']);
          return ListView(padding: EdgeInsets.fromLTRB(pad, 8, pad, 40), children: [
            const Text('Maak lijsten en deel ze met anderen op deze server.', style: TextStyle(color: K.muted)),
            const SizedBox(height: 14),
            KButton('Nieuwe lijst', icon: Icons.add_rounded, primary: true, autofocus: Device.isTv, onTap: () async {
              final name = await _askName(context, 'Nieuwe lijst');
              if (name == null || name.trim().isEmpty) return;
              try {
                await api.post('/api/lists', {'name': name});
                _reload();
              } catch (e) {
                if (context.mounted) showMessage(context, e);
              }
            }),
            const SizedBox(height: 14),
            if (lists.isEmpty) const Text('Nog geen lijsten.', style: TextStyle(color: K.muted)),
            for (final l in lists)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Tappable(
                  radius: 14,
                  focusScale: 1.02,
                  onTap: () async {
                    await Navigator.push(context, MaterialPageRoute(builder: (_) => ListScreen((l['id'] as num).toInt())));
                    _reload();
                  },
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: K.line)),
                    child: Row(children: [
                      const Icon(Icons.playlist_play_rounded, color: K.lilac, size: 30),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(l['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700)),
                          Text('${l['count']} titels · ${l['mine'] == true ? ((l['shared'] as num) > 0 ? 'gedeeld met ${l['shared']}' : 'alleen jij') : 'van ${l['owner']}'}', style: const TextStyle(color: K.muted, fontSize: 13)),
                        ]),
                      ),
                      const Icon(Icons.chevron_right_rounded, color: K.faint),
                    ]),
                  ),
                ),
              ),
          ]);
        },
      ),
    );
  }
}

class ListScreen extends StatefulWidget {
  final int id;
  const ListScreen(this.id, {super.key});
  @override
  State<ListScreen> createState() => _ListScreenState();
}

class _ListScreenState extends State<ListScreen> {
  late Future<Json> _future = api.get('/api/lists/${widget.id}');
  void _reload() => setState(() => _future = api.get('/api/lists/${widget.id}'));

  Future<void> _share(Json d) async {
    try {
      final dir = listOf((await api.get('/api/users/directory'))['users']);
      final picked = {for (final s in listOf(d['shares'])) (s['id'] as num).toInt(): s['edit'] == true};
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, set) => AlertDialog(
            title: Text('"${d['name']}" delen'),
            content: SizedBox(
              width: 420,
              child: dir.isEmpty
                  ? const Text('Er zijn nog geen andere gebruikers op deze server.', style: TextStyle(color: K.muted))
                  : ListView(shrinkWrap: true, children: [
                      for (final u in dir)
                        Row(children: [
                          Checkbox(value: picked.containsKey(u['id']), activeColor: K.violet, onChanged: (v) => set(() => v == true ? picked[(u['id'] as num).toInt()] = false : picked.remove(u['id']))),
                          Expanded(child: Text(u['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700))),
                          if (picked.containsKey(u['id'])) ...[
                            const Text('mag bewerken', style: TextStyle(color: K.muted, fontSize: 13)),
                            Switch(value: picked[u['id']] == true, activeThumbColor: K.orchid, onChanged: (v) => set(() => picked[(u['id'] as num).toInt()] = v)),
                          ],
                        ]),
                    ]),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Opslaan'))],
          ),
        ),
      );
      if (ok != true) return;
      await api.put('/api/lists/${widget.id}/shares', {
        'users': [for (final e in picked.entries) {'id': e.key, 'edit': e.value}]
      });
      _reload();
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Loader<Json>(
      future: _future,
      onRetry: _reload,
      builder: (context, d) {
        final mine = d['mine'] == true, canEdit = d['canEdit'] == true;
        final items = listOf(d['items']);
        return Scaffold(
          appBar: AppBar(
            title: Text(d['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w800)),
            leading: Device.isTv ? const SizedBox.shrink() : null,
            actions: [
              if (mine) IconButton(tooltip: 'Delen', icon: const Icon(Icons.group_add_rounded), onPressed: () => _share(d)),
              if (mine)
                IconButton(
                  tooltip: 'Hernoemen',
                  icon: const Icon(Icons.edit_rounded),
                  onPressed: () async {
                    final name = await _askName(context, 'Lijst hernoemen', initial: d['name'].toString());
                    if (name == null || name.trim().isEmpty) return;
                    try {
                      await api.put('/api/lists/${widget.id}', {'name': name});
                      _reload();
                    } catch (e) {
                      if (context.mounted) showMessage(context, e);
                    }
                  },
                ),
              IconButton(
                tooltip: mine ? 'Verwijderen' : 'Verlaten',
                icon: Icon(mine ? Icons.delete_outline_rounded : Icons.logout_rounded),
                onPressed: () async {
                  final ok = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: Text(mine ? 'Lijst verwijderen?' : 'Lijst verlaten?'),
                      content: Text(mine ? '"${d['name']}" verdwijnt voor iedereen.' : 'De lijst verdwijnt uit jouw overzicht.'),
                      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(mine ? 'Verwijderen' : 'Verlaten'))],
                    ),
                  );
                  if (ok != true) return;
                  try {
                    await api.delete('/api/lists/${widget.id}');
                    if (context.mounted) Navigator.pop(context);
                  } catch (e) {
                    if (context.mounted) showMessage(context, e);
                  }
                },
              ),
            ],
          ),
          body: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: EdgeInsets.fromLTRB(Device.isTv ? 48 : 16, 0, 16, 8),
              child: Text('${d['count']} titels · ${mine ? 'jouw lijst' : 'van ${d['owner']}${canEdit ? ' · je mag bewerken' : ' · alleen bekijken'}'}${canEdit ? ' · houd een titel ingedrukt om hem te verwijderen' : ''}', style: const TextStyle(color: K.muted, fontSize: 13)),
            ),
            Expanded(
              child: items.isEmpty
                  ? const Center(child: Text('Deze lijst is nog leeg.', style: TextStyle(color: K.muted)))
                  : GridView.builder(
                      padding: EdgeInsets.fromLTRB(Device.isTv ? 48 : 16, 8, Device.isTv ? 48 : 16, 40),
                      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 150, childAspectRatio: 2 / 3.6, crossAxisSpacing: 12, mainAxisSpacing: 14),
                      itemCount: items.length,
                      itemBuilder: (_, i) => GestureDetector(
                        onLongPress: !canEdit
                            ? null
                            : () async {
                                try {
                                  await api.delete('/api/lists/${widget.id}/items/${items[i]['id']}');
                                  _reload();
                                } catch (e) {
                                  if (context.mounted) showMessage(context, e);
                                }
                              },
                        child: PosterCard(items[i], onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen((items[i]['id'] as num).toInt())))),
                      ),
                    ),
            ),
          ]),
        );
      },
    );
  }
}

/// Ask for a film or series that is not in the library yet.
class RequestsScreen extends StatefulWidget {
  const RequestsScreen({super.key});
  @override
  State<RequestsScreen> createState() => _RequestsScreenState();
}

class _RequestsScreenState extends State<RequestsScreen> {
  static const _status = {'pending': 'In behandeling', 'approved': 'Goedgekeurd — komt eraan', 'declined': 'Afgewezen', 'available': 'Staat in de bibliotheek'};
  final _q = TextEditingController();
  String _kind = 'movie';
  List<Json> _results = [];
  List<Json> _mine = [];
  String? _error;
  bool _searching = false;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _loadMine();
  }

  Future<void> _loadMine() async {
    try {
      final d = await api.get('/api/requests');
      if (mounted) setState(() => _mine = listOf(d['requests']));
    } catch (_) {
      // The list is a convenience; searching still works.
    }
  }

  Future<void> _search() async {
    final term = _q.text.trim();
    if (term.length < 2) return setState(() => _results = []);
    final seq = ++_seq;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final d = await api.get('/api/requests/search?kind=$_kind&q=${Uri.encodeQueryComponent(term)}');
      if (mounted && seq == _seq) setState(() => _results = listOf(d['results']));
    } catch (e) {
      if (mounted && seq == _seq) setState(() => _error = e.toString());
    }
    if (mounted && seq == _seq) setState(() => _searching = false);
  }

  Future<void> _ask(Json r) async {
    setState(() => r['requested'] = true); // shown at once; undone if the server refuses
    try {
      await api.post('/api/requests', {'kind': r['kind'], 'title': r['title'], 'year': r['year'], 'imdbId': r['imdbId'], 'tmdbId': r['tmdbId'], 'poster': r['poster'], 'overview': r['overview']});
      if (mounted) showMessage(context, 'Aangevraagd');
      _loadMine();
    } catch (e) {
      if (mounted) {
        setState(() => r['requested'] = false);
        showMessage(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Scaffold(
      appBar: AppBar(title: const Text('Iets aanvragen', style: TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: ListView(padding: EdgeInsets.fromLTRB(pad, 4, pad, 40), children: [
        const Text('Mis je een film of serie? Vraag hem aan; de beheerder beslist.', style: TextStyle(color: K.muted)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: TextField(controller: _q, textInputAction: TextInputAction.search, onSubmitted: (_) => _search(), decoration: const InputDecoration(labelText: 'Zoek een titel'))),
          const SizedBox(width: 10),
          DropdownButton<String>(
            value: _kind,
            dropdownColor: K.surface,
            underline: const SizedBox.shrink(),
            items: const [DropdownMenuItem(value: 'movie', child: Text('Films')), DropdownMenuItem(value: 'show', child: Text('Series'))],
            onChanged: (v) {
              setState(() => _kind = v ?? 'movie');
              _search();
            },
          ),
          const SizedBox(width: 6),
          RoundIcon(Icons.search_rounded, tooltip: 'Zoeken', onTap: _search),
        ]),
        const SizedBox(height: 12),
        if (_searching) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(color: K.orchid))),
        if (_error != null) Text(_error!, style: const TextStyle(color: K.muted)),
        for (final r in _results)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: K.line)),
            child: Row(children: [
              SizedBox(width: 46, height: 69, child: ClipRRect(borderRadius: BorderRadius.circular(6), child: NetImage(r['poster'], fallbackText: r['title'].toString().characters.first))),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(r['title'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)), Text('${r['year'] ?? ''}', style: const TextStyle(color: K.muted, fontSize: 13))])),
              if (r['available'] == true) const Badge2('In de bibliotheek') else if (r['requested'] == true) const Badge2('Aangevraagd') else KButton('Aanvragen', primary: true, onTap: () => _ask(r)),
            ]),
          ),
        const SizedBox(height: 18),
        const Text('Jouw verzoeken', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        if (_mine.isEmpty) const Text('Je hebt nog niets aangevraagd.', style: TextStyle(color: K.muted)),
        for (final r in _mine)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${r['title']}${r['year'] != null ? ' (${r['year']})' : ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text('${_status[r['status']] ?? r['status']}${(r['note'] ?? '').toString().isEmpty ? '' : ' · "${r['note']}"'}', style: const TextStyle(color: K.muted, fontSize: 13)),
                ]),
              ),
              if (r['status'] == 'pending')
                TextButton(
                  onPressed: () async {
                    try {
                      await api.delete('/api/requests/${r['id']}');
                      _loadMine();
                    } catch (e) {
                      if (context.mounted) showMessage(context, e);
                    }
                  },
                  child: const Text('Intrekken', style: TextStyle(color: K.orchid)),
                ),
            ]),
          ),
      ]),
    );
  }
}

/// Kinoko Wrapped: the user's year in numbers.
class WrappedScreen extends StatefulWidget {
  const WrappedScreen({super.key});
  @override
  State<WrappedScreen> createState() => _WrappedScreenState();
}

class _WrappedScreenState extends State<WrappedScreen> {
  int? _year;
  late Future<Json> _future = _load();
  Future<Json> _load() => api.get('/api/wrapped${_year == null ? '' : '?year=$_year'}');
  void _reload() => setState(() => _future = _load());

  static String _time(num sec) => sec >= 3600 ? '${(sec / 3600).toStringAsFixed(1).replaceAll('.', ',')} uur' : '${(sec / 60).round()} min';

  Widget _card(String label, List<Widget> children, {bool big = false}) => Container(
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: K.line),
          gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [K.violet.withValues(alpha: big ? 0.55 : 0.25), K.surface]),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label.toUpperCase(), style: const TextStyle(fontSize: 11.5, letterSpacing: 1.4, color: K.lilac, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          ...children,
        ]),
      );

  Widget _num(String text) => FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(text, style: const TextStyle(fontSize: 46, height: 1.05, fontWeight: FontWeight.w900)));

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return Scaffold(
      appBar: AppBar(title: const Text('Jouw jaar', style: TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: Loader<Json>(
        future: _future,
        onRetry: _reload,
        builder: (context, w) {
          final years = {(w['year'] as num).toInt(), for (final y in listOf2(w['years'])) (y as num).toInt()}.toList()..sort((a, b) => b - a);
          final months = [for (final m in listOf2(w['months'])) (m as num).toDouble()];
          final maxMonth = months.fold<double>(1, (a, b) => b > a ? b : a);
          final music = w['music'] is Map && (w['music'] as Json)['empty'] != true ? w['music'] as Json : null;
          final share = w['sharePath'] == null ? null : '${api.serverUrl}${w['sharePath']}';
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: ListView(padding: EdgeInsets.fromLTRB(pad, 4, pad, 40), children: [
                Row(children: [
                  const Expanded(child: Text('Alleen jij ziet dit, tot je het zelf deelt.', style: TextStyle(color: K.muted))),
                  if (years.length > 1)
                    DropdownButton<int>(
                      value: (w['year'] as num).toInt(),
                      dropdownColor: K.surface,
                      underline: const SizedBox.shrink(),
                      items: [for (final y in years) DropdownMenuItem(value: y, child: Text('$y'))],
                      onChanged: (y) {
                        _year = y;
                        _reload();
                      },
                    ),
                ]),
                const SizedBox(height: 12),
                if (w['empty'] == true)
                  Padding(padding: const EdgeInsets.only(top: 60), child: Text('Nog niets gekeken in ${w['year']}.\nZodra je kijkt, bouwt je jaaroverzicht zich vanzelf op.', textAlign: TextAlign.center, style: const TextStyle(color: K.muted)))
                else ...[
                  _card('${w['name']} · ${w['year']}', big: true, [
                    _num(_time(numOf(w['seconds']))),
                    Text('gekeken op ${w['days']} ${w['days'] == 1 ? 'dag' : 'dagen'} · ${w['movies']} films · ${w['shows']} series', style: const TextStyle(color: K.muted)),
                    const SizedBox(height: 12),
                    SizedBox(
                      height: 56,
                      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                        for (final m in months) Expanded(child: Container(margin: const EdgeInsets.symmetric(horizontal: 2), height: 5 + m / maxMonth * 50, decoration: BoxDecoration(gradient: K.gradient, borderRadius: BorderRadius.circular(3)))),
                      ]),
                    ),
                  ]),
                  if (listOf(w['topTitles']).isNotEmpty)
                    _card('Meest gekeken', [
                      for (final (i, t) in listOf(w['topTitles']).indexed)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Row(children: [
                            SizedBox(width: 22, child: Text('${i + 1}', style: const TextStyle(color: K.lilac, fontWeight: FontWeight.w900))),
                            SizedBox(width: 36, height: 54, child: ClipRRect(borderRadius: BorderRadius.circular(6), child: NetImage(t['poster'], fallbackText: t['title'].toString().characters.first))),
                            const SizedBox(width: 12),
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(t['title'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)), Text(_time(numOf(t['seconds'])), style: const TextStyle(color: K.muted, fontSize: 13))])),
                          ]),
                        ),
                    ]),
                  if (listOf(w['topGenres']).isNotEmpty)
                    _card('Jouw genres', [
                      for (final g in listOf(w['topGenres']))
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Row(children: [
                            SizedBox(width: 110, child: Text(g['name'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis)),
                            Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(6), child: LinearProgressIndicator(value: numOf(g['share']) / 100, minHeight: 10, color: K.orchid, backgroundColor: Colors.white10))),
                            SizedBox(width: 44, child: Text('${g['share']}%', textAlign: TextAlign.right, style: const TextStyle(color: K.muted, fontSize: 13))),
                          ]),
                        ),
                    ]),
                  if (w['longestSession'] != null) _card('Langste kijksessie', [_num(_time(numOf((w['longestSession'] as Json)['seconds']))), Text('${(w['longestSession'] as Json)['title']} · ${(w['longestSession'] as Json)['day']}', style: const TextStyle(color: K.muted))]),
                  if (w['favoriteDay'] != null) _card('Favoriete kijkdag', [_num((w['favoriteDay'] as Json)['name'].toString()), Text('${_time(numOf((w['favoriteDay'] as Json)['seconds']))} in totaal', style: const TextStyle(color: K.muted))]),
                  if (music != null) ...[
                    _card('Muziek', big: true, [_num('${(numOf(music['seconds']) / 60).round()} min'), Text('geluisterd · ${music['tracks']} nummers · ${music['artists']} artiesten', style: const TextStyle(color: K.muted))]),
                    if (listOf(music['topArtists']).isNotEmpty) _card('Meest geluisterde artiesten', [for (final (i, a) in listOf(music['topArtists']).indexed) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('${i + 1}.  ${a['name']}  ·  ${(numOf(a['seconds']) / 60).round()} min'))]),
                    if (listOf(music['topTracks']).isNotEmpty) _card('Meest gedraaide nummers', [for (final (i, t) in listOf(music['topTracks']).indexed) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('${i + 1}.  ${t['title']} — ${t['artist']}  ·  ${t['plays']}×'))]),
                  ],
                  if (share == null)
                    KButton('Deellink maken', icon: Icons.link_rounded, primary: true, expand: true, onTap: () async {
                      try {
                        await api.post('/api/wrapped/share', {'year': w['year']});
                        _reload();
                      } catch (e) {
                        if (context.mounted) showMessage(context, e);
                      }
                    })
                  else ...[
                    const Text('Iedereen met deze link kan je overzicht zien, ook zonder account.', style: TextStyle(color: K.muted)),
                    const SizedBox(height: 8),
                    SelectableText(share, style: const TextStyle(color: K.lilac)),
                    const SizedBox(height: 10),
                    Row(children: [
                      KButton('Kopiëren', icon: Icons.copy_rounded, onTap: () {
                        Clipboard.setData(ClipboardData(text: share));
                        showMessage(context, 'Link gekopieerd');
                      }),
                      const SizedBox(width: 10),
                      KButton('Stoppen met delen', onTap: () async {
                        try {
                          await api.delete('/api/wrapped/share?year=${w['year']}');
                          _reload();
                        } catch (e) {
                          if (context.mounted) showMessage(context, e);
                        }
                      }),
                    ]),
                  ],
                ],
              ]),
            ),
          );
        },
      ),
    );
  }
}

List<Object?> listOf2(Object? v) => v is List ? v : const [];
