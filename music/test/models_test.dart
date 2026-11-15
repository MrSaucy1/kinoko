import 'package:flutter_test/flutter_test.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_music/data/models.dart';

void main() {
  test('a track from the server becomes what the system shows, and back', () {
    api.serverUrl = 'http://kinoko.test:8096';
    final t = Track.fromJson({
      'id': 7, 'title': 'Bohemian Rhapsody', 'artist': 'Queen', 'artistId': 2, 'album': 'A Night at the Opera', 'albumId': 3, 'trackNo': 11,
      'duration': 354.5, 'cover': '/api/music/cover/album/3?v=abc', 'liked': true, 'gain': {'track': -8.2, 'album': null}, 'itemId': 99,
    });
    expect(Likes.instance.has(7), isTrue);
    expect(t.gainTrack, -8.2);
    expect(t.itemId, 99);
    final item = t.toMediaItem();
    expect(item.id, '7');
    expect(item.artist, 'Queen');
    expect(item.duration, const Duration(milliseconds: 354500));
    expect(item.artUri.toString(), 'http://kinoko.test:8096/api/music/cover/album/3?v=abc');
    final back = Track.ofItem(item)!;
    expect([back.id, back.title, back.albumId, back.trackNo], [7, 'Bohemian Rhapsody', 3, 11]);
    expect(Track.ofItem(null), isNull);
  });

  test('a track with almost nothing still parses', () {
    final t = Track.fromJson({'id': 1});
    expect([t.title, t.artist, t.duration, t.cover], ['', '', 0.0, null]);
    expect(t.toMediaItem().duration, isNull);
    expect(tracksOf(null), isEmpty);
  });
}
