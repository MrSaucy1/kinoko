import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:kinoko_core/api.dart';
import 'package:kinoko_core/events.dart';
import 'package:kinoko_core/sign_in.dart';
import 'package:kinoko_core/theme.dart';

import 'data/downloads.dart';
import 'data/models.dart';
import 'player/handler.dart';
import 'screens/browse.dart';
import 'screens/extras.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  Device.label = 'Kinoko Music';
  await api.load();
  await MusicDownloads.instance.load();
  registerExtras();
  // Wifi or mobile data decides the quality asked for, and whether downloads may run.
  bool wifi(List<ConnectivityResult> r) => r.contains(ConnectivityResult.wifi) || r.contains(ConnectivityResult.ethernet);
  try {
    Net.onWifi = wifi(await Connectivity().checkConnectivity());
    Connectivity().onConnectivityChanged.listen((r) {
      final was = Net.onWifi;
      Net.onWifi = wifi(r);
      Net.changed.value++;
      if (Net.onWifi && !was) MusicDownloads.instance.retry();
    });
  } catch (_) {
    // Unknown network: behave as on wifi.
  }
  // Kinoko Connect: this app is a player the user's other devices can see and control.
  ServerEvents.instance.player = true;
  api.addListener(ServerEvents.instance.sync);
  ServerEvents.instance.sync();
  // The handler lives in a foreground service while music plays, so playback
  // continues when the app is in the background or its screen is closed.
  audio = await AudioService.init(
    builder: KinokoAudioHandler.new,
    config: const AudioServiceConfig(
      androidNotificationChannelId: 'nl.kinoko.music.playback',
      androidNotificationChannelName: 'Afspelen',
      androidNotificationOngoing: true,
      androidStopForegroundOnPause: true,
      // Android Auto: show albums and playlists as a grid of covers, tracks as a list.
      androidBrowsableRootExtras: {
        'android.media.browse.CONTENT_STYLE_SUPPORTED': true,
        'android.media.browse.CONTENT_STYLE_BROWSABLE_HINT': 2,
        'android.media.browse.CONTENT_STYLE_PLAYABLE_HINT': 1,
        'android.media.browse.SEARCH_SUPPORTED': true,
      },
    ),
  );
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent, systemNavigationBarColor: K.bg2, statusBarIconBrightness: Brightness.light));
  runApp(const KinokoMusicApp());
}

class KinokoMusicApp extends StatelessWidget {
  const KinokoMusicApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kinoko Music',
      debugShowCheckedModeBanner: false,
      theme: K.theme(tv: false),
      home: ListenableBuilder(
        listenable: api,
        builder: (context, _) {
          if (api.signedIn) {
            audio.restore();
            MusicDownloads.instance.sync();
          }
          return AnimatedSwitcher(
            duration: const Duration(milliseconds: 400),
            child: api.signedIn ? const Shell(key: ValueKey('shell')) : const SignInScreen(key: ValueKey('signin'), subtitle: 'Music'),
          );
        },
      ),
    );
  }
}
