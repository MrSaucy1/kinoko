import 'dart:async';

import 'package:flutter/material.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/theme.dart';
import 'package:kinoko_core/widgets.dart';

import '../data/models.dart';
import '../player/handler.dart';
import '../widgets/common.dart';
import '../widgets/cover.dart';

/// The navigator inside the shell: pages open above the tabs but below the
/// mini player and the navigation bar, so both stay in reach.
final shellNavigator = GlobalKey<NavigatorState>();

class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;
  static const _pages = [HomeScreen(), SearchScreen(), LibraryScreen()];

  void _go(int i) {
    shellNavigator.currentState?.popUntil((r) => r.isFirst);
    setState(() => _tab = i);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        final nav = shellNavigator.currentState;
        if (nav != null && nav.canPop()) {
          nav.pop();
        } else if (_tab != 0) {
          setState(() => _tab = 0);
        }
      },
      child: Scaffold(
        body: Column(children: [
          Expanded(
            child: Navigator(
              key: shellNavigator,
              onGenerateRoute: (_) => MaterialPageRoute(builder: (_) => _TabHost(tab: () => _tab, pages: _pages, listen: _tabs)),
            ),
          ),
          const MiniPlayer(),
        ]),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          backgroundColor: K.bg2,
          indicatorColor: K.violet.withValues(alpha: 0.35),
          onDestinationSelected: (i) {
            _go(i);
            _tabs.value = i;
          },
          destinations: const [
            NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home_rounded), label: 'Home'),
            NavigationDestination(icon: Icon(Icons.search_rounded), label: 'Zoeken'),
            NavigationDestination(icon: Icon(Icons.library_music_outlined), selectedIcon: Icon(Icons.library_music_rounded), label: 'Bibliotheek'),
          ],
        ),
      ),
    );
  }
}

final _tabs = ValueNotifier<int>(0);

class _TabHost extends StatelessWidget {
  final int Function() tab;
  final List<Widget> pages;
  final ValueNotifier<int> listen;
  const _TabHost({required this.tab, required this.pages, required this.listen});
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<int>(valueListenable: listen, builder: (_, i, __) => IndexedStack(index: i, children: pages));
}

Widget _sectionTitle(String text) => Padding(padding: const EdgeInsets.fromLTRB(16, 22, 16, 10), child: Text(text, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)));

Widget _shelf(List<Widget> cards) => SizedBox(
      height: 198,
      child: ListView.separated(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), itemCount: cards.length, separatorBuilder: (_, __) => const SizedBox(width: 14), itemBuilder: (_, i) => cards[i]),
    );

// ---------------------------------------------------------------------------
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<Json> _future = api.get('/api/music/home');
  Future<void> _reload() async {
    setState(() => _future = api.get('/api/music/home'));
    await _future.catchError((_) => <String, dynamic>{});
  }

  String get _greeting {
    final h = DateTime.now().hour;
    return h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: Loader<Json>(
        future: _future,
        onRetry: _reload,
        builder: (context, d) {
          final rows = listOf(d['rows']);
          return RefreshIndicator(
            color: K.orchid,
            onRefresh: _reload,
            child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 8, 0),
                child: Row(children: [
                  Expanded(child: Text(_greeting, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900))),
                  IconButton(tooltip: 'Instellingen', icon: const Icon(Icons.settings_outlined), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()))),
                ]),
              ),
              if (d['empty'] == true)
                const Padding(padding: EdgeInsets.all(40), child: Text('Er staat nog geen muziek op deze server.\nVoeg in het beheer een muziekbibliotheek toe.', textAlign: TextAlign.center, style: TextStyle(color: K.muted))),
              if (numOf(d['liked']) > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
                  child: Tappable(
                    radius: 12,
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const LikesScreen())),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: K.surface2, borderRadius: BorderRadius.circular(12)),
                      child: Row(children: [
                        Container(width: 46, height: 46, decoration: BoxDecoration(gradient: K.gradient, borderRadius: BorderRadius.circular(8)), child: const Icon(Icons.favorite_rounded)),
                        const SizedBox(width: 12),
                        Expanded(child: Text('Gelikete nummers · ${(d['liked'] as num).toInt()}', style: const TextStyle(fontWeight: FontWeight.w700))),
                        const Icon(Icons.chevron_right_rounded, color: K.faint),
                      ]),
                    ),
                  ),
                ),
              for (final r in rows) ...[
                _sectionTitle(r['title'].toString()),
                if (r['kind'] == 'tracks')
                  ...() {
                    final list = tracksOf(r['items']);
                    return [for (var i = 0; i < list.length && i < 6; i++) TrackTile(list[i], list, i)];
                  }()
                else
                  _shelf([for (final x in listOf(r['items'])) r['kind'] == 'albums' ? albumCard(context, x) : r['kind'] == 'playlists' ? playlistCard(context, x) : artistCard(context, x)]),
              ],
            ]),
          );
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _q = TextEditingController();
  Timer? _debounce;
  Json? _result;
  String? _error;
  bool _busy = false;
  int _seq = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _changed(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 280), _search);
  }

  Future<void> _search() async {
    final term = _q.text.trim();
    if (term.length < 2) return setState(() => _result = null);
    final seq = ++_seq;
    setState(() => _busy = true);
    try {
      final r = await api.get('/api/music/search?q=${Uri.encodeQueryComponent(term)}');
      if (mounted && seq == _seq) {
        setState(() {
          _result = r;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted && seq == _seq) setState(() => _error = e.toString());
    }
    if (mounted && seq == _seq) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final r = _result;
    final tracks = tracksOf(r?['tracks']);
    final nothing = r != null && tracks.isEmpty && listOf(r['artists']).isEmpty && listOf(r['albums']).isEmpty && listOf(r['playlists']).isEmpty;
    return SafeArea(
      bottom: false,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
          child: TextField(
            controller: _q,
            onChanged: _changed,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _search(),
            decoration: InputDecoration(hintText: 'Artiest, album, nummer of playlist', prefixIcon: const Icon(Icons.search_rounded), suffixIcon: _busy ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: K.orchid))) : null),
          ),
        ),
        Expanded(
          child: _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: K.muted)))
              : r == null
                  ? const Center(child: Text('Zoek in je hele muziekbibliotheek.\nEen typfout is geen probleem.', textAlign: TextAlign.center, style: TextStyle(color: K.muted)))
                  : nothing
                      ? const Center(child: Text('Niets gevonden.', style: TextStyle(color: K.muted)))
                      : ListView(padding: const EdgeInsets.only(bottom: 24), children: [
                          if (listOf(r['artists']).isNotEmpty) ...[_sectionTitle('Artiesten'), _shelf([for (final a in listOf(r['artists'])) artistCard(context, a)])],
                          if (tracks.isNotEmpty) ...[_sectionTitle('Nummers'), for (var i = 0; i < tracks.length; i++) TrackTile(tracks[i], tracks, i)],
                          if (listOf(r['albums']).isNotEmpty) ...[_sectionTitle('Albums'), _shelf([for (final a in listOf(r['albums'])) albumCard(context, a)])],
                          if (listOf(r['playlists']).isNotEmpty) ...[_sectionTitle('Playlists'), _shelf([for (final p in listOf(r['playlists'])) playlistCard(context, p)])],
                        ]),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
/// A list or grid that fetches the next page as you near its end.
class Paged extends StatefulWidget {
  final String path;
  final int pageSize;
  final bool grid;
  final Widget Function(BuildContext, Json, List<Json> all, int index) item;
  const Paged({super.key, required this.path, required this.item, this.pageSize = 60, this.grid = false});
  @override
  State<Paged> createState() => _PagedState();
}

class _PagedState extends State<Paged> {
  final _items = <Json>[];
  final _scroll = ScrollController();
  bool _busy = false, _done = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 900) _more();
    });
    _more();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _more() async {
    if (_busy || _done) return;
    _busy = true;
    try {
      final sep = widget.path.contains('?') ? '&' : '?';
      final d = await api.get('${widget.path}${sep}limit=${widget.pageSize}&offset=${_items.length}');
      final page = listOf(d['items']);
      if (!mounted) return;
      setState(() {
        _items.addAll(page);
        _done = page.isEmpty || _items.length >= ((d['total'] as num?)?.toInt() ?? 1 << 30);
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
    _busy = false;
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      if (_error != null) return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_error!, style: const TextStyle(color: K.muted)), const SizedBox(height: 12), KButton('Opnieuw', onTap: _more)]));
      return Center(child: _done ? const Text('Nog niets te zien.', style: TextStyle(color: K.muted)) : const CircularProgressIndicator(color: K.orchid));
    }
    if (widget.grid) {
      return GridView.builder(
        controller: _scroll,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 180, mainAxisExtent: 216, crossAxisSpacing: 14, mainAxisSpacing: 14),
        itemCount: _items.length,
        itemBuilder: (c, i) => LayoutBuilder(builder: (c, box) => widget.item(c, {..._items[i], '_w': box.maxWidth}, _items, i)),
      );
    }
    return ListView.builder(controller: _scroll, padding: const EdgeInsets.only(bottom: 24), itemCount: _items.length, itemBuilder: (c, i) => widget.item(c, _items[i], _items, i));
  }
}

class LibraryScreen extends StatelessWidget {
  const LibraryScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      child: SafeArea(
        bottom: false,
        child: Column(children: [
          const Padding(padding: EdgeInsets.fromLTRB(16, 14, 16, 0), child: Align(alignment: Alignment.centerLeft, child: Text('Bibliotheek', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900)))),
          const TabBar(isScrollable: true, tabAlignment: TabAlignment.start, indicatorColor: K.orchid, labelColor: K.text, unselectedLabelColor: K.muted, dividerColor: Colors.transparent, tabs: [Tab(text: 'Playlists'), Tab(text: 'Albums'), Tab(text: 'Artiesten'), Tab(text: 'Likes')]),
          Expanded(
            child: TabBarView(children: [
              const _Playlists(),
              Paged(path: '/api/music/albums?sort=artist', grid: true, item: (c, a, _, __) => albumCard(c, a, width: numOf(a['_w']))),
              Paged(path: '/api/music/artists', grid: true, item: (c, a, _, __) => artistCard(c, a, width: numOf(a['_w']))),
              const _TrackList('/api/music/likes'),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _TrackList extends StatelessWidget {
  final String path;
  const _TrackList(this.path);
  @override
  Widget build(BuildContext context) => Paged(path: path, pageSize: 100, item: (c, t, all, i) => TrackTile(Track.fromJson(t), tracksOf(all), i));
}

class LikesScreen extends StatelessWidget {
  const LikesScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Gelikete nummers', style: TextStyle(fontWeight: FontWeight.w800))), body: const _TrackList('/api/music/likes'));
}

class _Playlists extends StatefulWidget {
  const _Playlists();
  @override
  State<_Playlists> createState() => _PlaylistsState();
}

class _PlaylistsState extends State<_Playlists> {
  late Future<Json> _future = api.get('/api/music/playlists');
  void _reload() => setState(() => _future = api.get('/api/music/playlists'));

  @override
  Widget build(BuildContext context) {
    return Loader<Json>(
      future: _future,
      onRetry: _reload,
      builder: (context, d) {
        final items = listOf(d['items']);
        return ListView(padding: const EdgeInsets.fromLTRB(0, 8, 0, 24), children: [
          ListTile(
            leading: Container(width: 52, height: 52, decoration: BoxDecoration(color: K.surface3, borderRadius: BorderRadius.circular(8)), child: const Icon(Icons.add_rounded, color: K.orchid)),
            title: const Text('Nieuwe playlist', style: TextStyle(fontWeight: FontWeight.w700)),
            onTap: () async {
              final name = await askName(context, 'Nieuwe playlist');
              if (name == null || name.trim().isEmpty || !context.mounted) return;
              await attempt(context, () async => api.post('/api/music/playlists', {'name': name}));
              _reload();
            },
          ),
          if (items.isEmpty) const Padding(padding: EdgeInsets.all(30), child: Text('Nog geen playlists.', textAlign: TextAlign.center, style: TextStyle(color: K.muted))),
          for (final p in items)
            ListTile(
              leading: Cover(listOf2(p['covers']).firstOrNull as String?, size: 52, radius: 8, fallback: Icons.queue_music_rounded),
              title: Text(p['name'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text('${p['count']} nummers${p['mine'] == true ? '' : ' · van ${p['owner']}'}', style: const TextStyle(color: K.muted, fontSize: 12.5)),
              onTap: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => PlaylistScreen((p['id'] as num).toInt())));
                _reload();
              },
            ),
        ]);
      },
    );
  }
}

// ---------------------------------------------------------------------------
Widget _header(BuildContext context, {required String? cover, required String kind, required String title, required String sub, required List<Track> tracks, bool round = false, IconData fallback = Icons.album_rounded, List<Widget> actions = const []}) {
  return Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
    child: Column(children: [
      Cover(cover, size: 210, radius: 12, round: round, fallback: fallback),
      const SizedBox(height: 14),
      Text(kind.toUpperCase(), style: const TextStyle(color: K.lilac, letterSpacing: 2, fontSize: 11.5, fontWeight: FontWeight.w700)),
      const SizedBox(height: 4),
      Text(title, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900)),
      const SizedBox(height: 4),
      Text(sub, textAlign: TextAlign.center, style: const TextStyle(color: K.muted, fontSize: 13)),
      const SizedBox(height: 14),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        KButton('Afspelen', icon: Icons.play_arrow_rounded, primary: true, onTap: tracks.isEmpty ? null : () => attempt(context, () => audio.playTracks(tracks))),
        const SizedBox(width: 10),
        KButton('Shuffle', icon: Icons.shuffle_rounded, onTap: tracks.isEmpty ? null : () => attempt(context, () => audio.playTracks(List.of(tracks)..shuffle()))),
        ...actions,
      ]),
    ]),
  );
}

class AlbumScreen extends StatefulWidget {
  final int id;
  const AlbumScreen(this.id, {super.key});
  @override
  State<AlbumScreen> createState() => _AlbumScreenState();
}

class _AlbumScreenState extends State<AlbumScreen> {
  late Future<Json> _future = api.get('/api/music/albums/${widget.id}');
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(),
      body: Loader<Json>(
        future: _future,
        onRetry: () => setState(() => _future = api.get('/api/music/albums/${widget.id}')),
        builder: (context, a) {
          final tracks = tracksOf(a['items']);
          return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            _header(context, cover: a['cover'] as String?, kind: 'Album', title: a['title'].toString(), sub: [a['artist'], a['year'], '${tracks.length} nummers', fmtLong(numOf(a['duration']))].where((x) => x != null).join(' · '), tracks: tracks, actions: [
              IconButton(tooltip: 'Aan playlist toevoegen', icon: const Icon(Icons.playlist_add_rounded), onPressed: () => addToPlaylist(context, tracks)),
              for (final extra in collectionExtras) extra(context, 'album', widget.id, tracks),
            ]),
            for (var i = 0; i < tracks.length; i++) TrackTile(tracks[i], tracks, i, numbered: true),
          ]);
        },
      ),
    );
  }
}

/// Extra buttons on album and playlist pages (download, radio) added by later features.
final List<Widget Function(BuildContext, String kind, int id, List<Track>)> collectionExtras = [];

class ArtistScreen extends StatefulWidget {
  final int id;
  const ArtistScreen(this.id, {super.key});
  @override
  State<ArtistScreen> createState() => _ArtistScreenState();
}

class _ArtistScreenState extends State<ArtistScreen> {
  late Future<Json> _future = api.get('/api/music/artists/${widget.id}');
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(),
      body: Loader<Json>(
        future: _future,
        onRetry: () => setState(() => _future = api.get('/api/music/artists/${widget.id}')),
        builder: (context, a) {
          final top = tracksOf(a['topTracks']);
          final bio = (a['bio'] ?? '').toString();
          return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            _header(context, cover: a['image'] as String?, kind: 'Artiest', title: a['name'].toString(), sub: bio.isEmpty ? '${listOf(a['albums']).length} albums' : bio, tracks: top, round: true, fallback: Icons.person_rounded, actions: [for (final extra in collectionExtras) extra(context, 'artist', widget.id, top)]),
            if (top.isNotEmpty) ...[_sectionTitle('Populair'), for (var i = 0; i < top.length && i < 5; i++) TrackTile(top[i], top, i)],
            _sectionTitle('Albums'),
            _shelf([for (final al in listOf(a['albums'])) albumCard(context, al)]),
          ]);
        },
      ),
    );
  }
}

class PlaylistScreen extends StatefulWidget {
  final int id;
  const PlaylistScreen(this.id, {super.key});
  @override
  State<PlaylistScreen> createState() => _PlaylistScreenState();
}

class _PlaylistScreenState extends State<PlaylistScreen> {
  Json? _p;
  List<Track> _tracks = [];
  String? _error;
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await api.get('/api/music/playlists/${widget.id}');
      if (mounted) {
        setState(() {
          _p = p;
          _tracks = tracksOf(p['items']);
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  /// Shown at once; the server follows, and a refusal reloads the real list.
  Future<void> _remove(Track t) async {
    setState(() => _tracks = [for (final x in _tracks) if (x.itemId != t.itemId) x]);
    try {
      await api.delete('/api/music/playlists/${widget.id}/items/${t.itemId}');
    } catch (e) {
      if (mounted) showMessage(context, e);
      _load();
    }
  }

  Future<void> _move(int from, int to) async {
    setState(() => _tracks.insert(to, _tracks.removeAt(from)));
    try {
      await api.put('/api/music/playlists/${widget.id}/order', {'itemIds': [for (final t in _tracks) t.itemId]});
    } catch (e) {
      if (mounted) showMessage(context, e);
      _load();
    }
  }

  Future<void> _share() async {
    final p = _p!;
    try {
      final dir = listOf((await api.get('/api/users/directory'))['users']);
      final picked = {for (final s in listOf(p['shares'])) (s['id'] as num).toInt(): s['edit'] == true};
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, set) => AlertDialog(
            title: const Text('Playlist delen'),
            content: SizedBox(
              width: 420,
              child: dir.isEmpty
                  ? const Text('Er zijn nog geen andere gebruikers op deze server.', style: TextStyle(color: K.muted))
                  : ListView(shrinkWrap: true, children: [
                      for (final u in dir)
                        Row(children: [
                          Checkbox(value: picked.containsKey(u['id']), activeColor: K.violet, onChanged: (v) => set(() => v == true ? picked[(u['id'] as num).toInt()] = false : picked.remove(u['id']))),
                          Expanded(child: Text(u['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700))),
                          if (picked.containsKey(u['id'])) ...[const Text('bewerken', style: TextStyle(color: K.muted, fontSize: 13)), Switch(value: picked[u['id']] == true, activeThumbColor: K.orchid, onChanged: (v) => set(() => picked[(u['id'] as num).toInt()] = v))],
                        ]),
                    ]),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuleren')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Opslaan'))],
          ),
        ),
      );
      if (ok != true) return;
      await api.put('/api/music/playlists/${widget.id}/shares', {
        'users': [for (final e in picked.entries) {'id': e.key, 'edit': e.value}]
      });
      _load();
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    if (p == null) {
      return Scaffold(appBar: AppBar(), body: Center(child: _error != null ? Text(_error!, style: const TextStyle(color: K.muted)) : const CircularProgressIndicator(color: K.orchid)));
    }
    final mine = p['mine'] == true, canEdit = p['canEdit'] == true;
    final header = _header(context,
        cover: listOf2(p['covers']).firstOrNull as String?,
        kind: mine ? 'Playlist' : 'Playlist van ${p['owner']}',
        title: p['name'].toString(),
        sub: '${_tracks.length} nummers · ${fmtLong(_tracks.fold<double>(0, (s, t) => s + t.duration))}',
        tracks: _tracks,
        fallback: Icons.queue_music_rounded,
        actions: [for (final extra in collectionExtras) extra(context, 'playlist', widget.id, _tracks)]);
    return Scaffold(
      appBar: AppBar(actions: [
        if (canEdit && _tracks.length > 1) IconButton(tooltip: _editing ? 'Klaar' : 'Volgorde aanpassen', icon: Icon(_editing ? Icons.check_rounded : Icons.swap_vert_rounded), onPressed: () => setState(() => _editing = !_editing)),
        if (mine) IconButton(tooltip: 'Delen', icon: const Icon(Icons.group_add_rounded), onPressed: _share),
        PopupMenuButton<String>(
          color: K.surface2,
          onSelected: (v) async {
            if (v == 'rename') {
              final name = await askName(context, 'Playlist hernoemen', initial: p['name'].toString());
              if (name == null || name.trim().isEmpty || !context.mounted) return;
              await attempt(context, () async => api.put('/api/music/playlists/${widget.id}', {'name': name}));
              _load();
            } else {
              await attempt(context, () async => api.delete('/api/music/playlists/${widget.id}'));
              if (context.mounted) Navigator.pop(context);
            }
          },
          itemBuilder: (_) => [if (mine) const PopupMenuItem(value: 'rename', child: Text('Hernoemen')), PopupMenuItem(value: 'delete', child: Text(mine ? 'Verwijderen' : 'Verlaten'))],
        ),
      ]),
      body: _editing
          ? ReorderableListView.builder(
              padding: const EdgeInsets.only(bottom: 24),
              header: const Padding(padding: EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('Sleep aan de greep om de volgorde te veranderen; veeg om te verwijderen.', style: TextStyle(color: K.muted, fontSize: 13))),
              itemCount: _tracks.length,
              onReorderItem: _move,
              itemBuilder: (context, i) {
                final t = _tracks[i];
                return Dismissible(
                  key: ValueKey('pl-${t.itemId}'),
                  direction: DismissDirection.endToStart,
                  background: Container(color: K.bad.withValues(alpha: 0.25), alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: const Icon(Icons.delete_outline_rounded)),
                  onDismissed: (_) => _remove(t),
                  child: ListTile(
                    leading: Cover(t.cover, size: 44, radius: 6),
                    title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text(t.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: K.muted, fontSize: 12.5)),
                    trailing: ReorderableDragStartListener(index: i, child: const Padding(padding: EdgeInsets.all(8), child: Icon(Icons.drag_handle_rounded, color: K.muted))),
                  ),
                );
              },
            )
          : ListView(padding: const EdgeInsets.only(bottom: 24), children: [
              header,
              if (_tracks.isEmpty) const Padding(padding: EdgeInsets.all(30), child: Text('Deze playlist is nog leeg.\nHoud een nummer ingedrukt en kies "Aan playlist toevoegen".', textAlign: TextAlign.center, style: TextStyle(color: K.muted))),
              for (var i = 0; i < _tracks.length; i++) TrackTile(_tracks[i], _tracks, i, onRemove: canEdit ? () => _remove(_tracks[i]) : null),
            ]),
    );
  }
}

// ---------------------------------------------------------------------------
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  Widget build(BuildContext context) {
    final u = api.user ?? const {};
    return Scaffold(
      appBar: AppBar(title: const Text('Instellingen', style: TextStyle(fontWeight: FontWeight.w800))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 30), children: [
        ListTile(contentPadding: EdgeInsets.zero, leading: const CircleAvatar(backgroundColor: K.violet, child: Icon(Icons.person_rounded, color: Colors.white)), title: Text((u['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700)), subtitle: Text('${api.serverName} · ${api.serverUrl}', maxLines: 1, overflow: TextOverflow.ellipsis)),
        const SizedBox(height: 14),
        const Text('Geluidskwaliteit', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        const Text('Lager dan origineel wordt op de server omgezet naar Opus. Geldt vanaf het volgende nummer dat je start.', style: TextStyle(color: K.muted, fontSize: 13)),
        RadioGroup<String>(
          groupValue: MusicPrefs.quality,
          onChanged: (v) => setState(() => MusicPrefs.quality = v ?? 'original'),
          child: Column(children: [for (final e in MusicPrefs.qualities.entries) RadioListTile<String>(value: e.key, title: Text(e.value), contentPadding: EdgeInsets.zero, activeColor: K.orchid)]),
        ),
        for (final section in settingsExtras) section(context, () => setState(() {})),
        const SizedBox(height: 18),
        KButton('Uitloggen', icon: Icons.logout_rounded, expand: true, onTap: () async {
          await audio.clear();
          await api.logout();
        }),
        const SizedBox(height: 10),
        KButton('Andere server', icon: Icons.dns_rounded, expand: true, onTap: () async {
          await audio.clear();
          await api.logout(forgetServer: true);
        }),
      ]),
    );
  }
}

/// Extra sections on the settings page added by later features.
final List<Widget Function(BuildContext, VoidCallback refresh)> settingsExtras = [];
