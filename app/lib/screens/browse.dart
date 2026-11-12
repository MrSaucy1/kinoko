import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import 'detail.dart';

/// A grid of titles: a genre, a collection or My List.
class BrowseScreen extends StatefulWidget {
  final String title;
  final String path;
  const BrowseScreen({super.key, required this.title, required this.path});

  factory BrowseScreen.genre(String genre, {String? kind}) =>
      BrowseScreen(title: genre, path: '/api/browse?genre=${Uri.encodeQueryComponent(genre)}&sort=rating${kind != null ? '&kind=$kind' : ''}');
  factory BrowseScreen.collection(int id, String name) => BrowseScreen(title: name, path: '/api/collections/$id');

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  late Future<Json> _future = api.get(widget.path);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w800)), leading: Device.isTv ? const SizedBox.shrink() : null),
      body: Loader<Json>(
        future: _future,
        onRetry: () => setState(() => _future = api.get(widget.path)),
        builder: (context, d) => TitleGrid(listOf(d['items']), onChanged: () {}),
      ),
    );
  }
}

class TitleGrid extends StatelessWidget {
  final List<Json> items;
  final VoidCallback onChanged;
  const TitleGrid(this.items, {super.key, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const Center(child: Text('Niets gevonden', style: TextStyle(color: K.muted)));
    final pad = Device.isTv ? 48.0 : 16.0;
    return GridView.builder(
      padding: EdgeInsets.fromLTRB(pad, 12, pad, 40),
      gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: Device.isTv ? 190 : 140, childAspectRatio: 2 / 3, crossAxisSpacing: 12, mainAxisSpacing: 14),
      itemCount: items.length,
      itemBuilder: (context, i) => PosterCard(items[i], width: double.infinity, autofocus: Device.isTv && i == 0, onTap: () => openDetail(context, (items[i]['id'] as num).toInt()).then((_) => onChanged())),
    );
  }
}

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _q = TextEditingController();
  Timer? _debounce;
  Future<Json>? _future;

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  void _changed(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      setState(() => _future = v.trim().isEmpty ? null : api.get('/api/browse?q=${Uri.encodeQueryComponent(v.trim())}'));
    });
  }

  @override
  Widget build(BuildContext context) {
    final pad = Device.isTv ? 48.0 : 16.0;
    return SafeArea(
      child: Column(children: [
        Padding(
          padding: EdgeInsets.fromLTRB(pad, 16, pad, 8),
          child: TextField(
            controller: _q,
            onChanged: _changed,
            textInputAction: TextInputAction.search,
            decoration: const InputDecoration(hintText: 'Titels, acteurs, genres', prefixIcon: Icon(Icons.search_rounded, color: K.muted)),
          ),
        ),
        Expanded(
          child: _future == null
              ? const Center(child: Text('Zoek in je hele bibliotheek', style: TextStyle(color: K.faint)))
              : Loader<Json>(future: _future!, builder: (context, d) => TitleGrid(listOf(d['items']), onChanged: () {})),
        ),
      ]),
    );
  }
}
