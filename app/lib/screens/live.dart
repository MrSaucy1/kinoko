import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import 'player.dart';

class LiveScreen extends StatefulWidget {
  const LiveScreen({super.key});
  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends State<LiveScreen> {
  Json? _base;
  List<Json> _channels = [];
  String _key = '';
  // Country → category → channels; null shows the list of countries.
  Json? _country;
  String? _error;
  bool _loading = true;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _init();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _init() async {
    try {
      final d = await api.get('/api/iptv');
      if (!mounted) return;
      setState(() {
        _base = d;
        _loading = false;
        _error = null;
      });
      final groups = _groups;
      if ((d['favorites'] as num? ?? 0) > 0) {
        if (groups.length == 1) _country = groups.first;
        _open('fav', 'fav=1');
      } else if (groups.isNotEmpty) {
        _pickCountry(groups.first);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  /// Channel groups per country. Older servers only send flat categories.
  List<Json> get _groups {
    final g = listOf(_base?['groups']);
    if (g.isNotEmpty) return g;
    final cats = listOf(_base?['categories']);
    if (cats.isEmpty) return const [];
    return [
      {
        'code': '',
        'name': 'Categorieën',
        'categories': [
          for (final c in cats) {...c, 'label': c['name']},
        ],
      }
    ];
  }

  void _openCategory(Json c) => _open('c:${c['name']}', 'category=${Uri.encodeQueryComponent(c['name'].toString())}');

  void _pickCountry(Json g) {
    setState(() => _country = g);
    final cats = listOf(g['categories']);
    if (cats.isNotEmpty) _openCategory(cats.first);
  }

  Future<void> _open(String key, String query) async {
    setState(() {
      _key = key;
      _loading = true;
    });
    try {
      final d = await api.get('/api/iptv?$query');
      if (mounted && _key == key) {
        setState(() {
          _channels = listOf(d['channels']);
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _toggleFav(Json c) async {
    try {
      final r = c['favorite'] == true ? await api.delete('/api/iptv/fav/${c['id']}') : await api.put('/api/iptv/fav/${c['id']}');
      setState(() => c['favorite'] = r['favorite']);
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    if (_error != null) return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_error!, style: const TextStyle(color: K.muted)), const SizedBox(height: 14), KButton('Opnieuw', onTap: _init)]));
    if (_base == null) return const Center(child: CircularProgressIndicator(color: K.orchid));
    if (_base!['enabled'] != true) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.live_tv_rounded, size: 56, color: K.faint),
            const SizedBox(height: 14),
            const Text('Live tv staat nog uit', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text('De beheerder kan een IPTV-abonnement of M3U-playlist toevoegen in het beheer van ${api.serverName}.', textAlign: TextAlign.center, style: const TextStyle(color: K.muted)),
          ]),
        ),
      );
    }
    final groups = _groups;
    final country = _country;
    final catList = [
      Pill('★ Favorieten', selected: _key == 'fav', onTap: () => _open('fav', 'fav=1')),
      if (country == null)
        for (final g in groups) Pill('${g['name']}  ›', onTap: () => _pickCountry(g))
      else ...[
        if (groups.length > 1) Pill('‹  ${country['name']}', onTap: () => setState(() => _country = null)),
        for (final c in listOf(country['categories'])) Pill('${c['label'] ?? c['name']}', selected: _key == 'c:${c['name']}', onTap: () => _openCategory(c)),
      ],
    ];
    final grid = _loading
        ? const Center(child: CircularProgressIndicator(color: K.orchid))
        : _channels.isEmpty
            ? Center(child: Text(_key == 'fav' ? 'Nog geen favorieten. Houd een zender ingedrukt om hem toe te voegen.' : 'Geen zenders gevonden.', textAlign: TextAlign.center, style: const TextStyle(color: K.muted)))
            : GridView.builder(
                padding: EdgeInsets.fromLTRB(Device.isTv ? 8 : pad, 8, pad, 40),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 300, mainAxisExtent: 70, crossAxisSpacing: 10, mainAxisSpacing: 10),
                itemCount: _channels.length,
                itemBuilder: (context, i) {
                  final c = _channels[i];
                  return Tappable(
                    radius: 12,
                    focusScale: 1.04,
                    onTap: () => openPlayer(context, PlayRequest(channel: c)),
                    onLongPress: () => _toggleFav(c),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      decoration: BoxDecoration(color: K.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: K.line)),
                      child: Row(children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: SizedBox(
                            width: 44,
                            height: 44,
                            child: c['logo'] == null
                                ? ColoredBox(color: K.bg, child: Center(child: Text(c['name'].toString().characters.first, style: const TextStyle(color: K.orchid, fontWeight: FontWeight.w800))))
                                : Image.network(c['logo'].toString(), fit: BoxFit.contain, errorBuilder: (_, __, ___) => ColoredBox(color: K.bg, child: Center(child: Text(c['name'].toString().characters.first, style: const TextStyle(color: K.orchid, fontWeight: FontWeight.w800))))),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(child: Text(c['name'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
                        if (c['favorite'] == true) const Icon(Icons.star_rounded, color: K.gold, size: 20),
                      ]),
                    ),
                  );
                },
              );
    final search = TextField(
      decoration: const InputDecoration(hintText: 'Zender zoeken', prefixIcon: Icon(Icons.search_rounded, color: K.muted), isDense: true),
      onChanged: (v) {
        _debounce?.cancel();
        _debounce = Timer(const Duration(milliseconds: 400), () {
          if (v.trim().length >= 2) _open('q:$v', 'q=${Uri.encodeQueryComponent(v.trim())}');
        });
      },
    );
    if (Device.isTv) {
      return SafeArea(
        child: Row(children: [
          SizedBox(
            width: 250,
            child: ListView(padding: const EdgeInsets.fromLTRB(40, 28, 12, 28), children: [
              for (final p in catList) Padding(padding: const EdgeInsets.only(bottom: 8), child: Align(alignment: Alignment.centerLeft, child: p)),
            ]),
          ),
          Expanded(child: Padding(padding: const EdgeInsets.only(top: 20), child: grid)),
        ]),
      );
    }
    return SafeArea(
      child: Column(children: [
        Padding(padding: EdgeInsets.fromLTRB(pad, 14, pad, 8), child: search),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: EdgeInsets.symmetric(horizontal: pad, vertical: 6),
          child: Row(children: [for (final p in catList) Padding(padding: const EdgeInsets.only(right: 8), child: p)]),
        ),
        Expanded(child: grid),
      ]),
    );
  }
}
