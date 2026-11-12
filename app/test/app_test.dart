import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kinoko/core/api.dart';
import 'package:kinoko/core/theme.dart';
import 'package:kinoko/screens/onboarding.dart';
import 'package:kinoko/widgets/cards.dart';
import 'package:kinoko/widgets/common.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('server addresses are normalised the way people type them', () {
    expect(Session.cleanUrl('192.168.1.10'), 'http://192.168.1.10:8096');
    expect(Session.cleanUrl('192.168.1.10:9000/'), 'http://192.168.1.10:9000');
    expect(Session.cleanUrl('kinoko.voorbeeld.nl'), 'https://kinoko.voorbeeld.nl');
    expect(Session.cleanUrl('https://box.tail1234.ts.net/'), 'https://box.tail1234.ts.net');
    expect(Session.cleanUrl('http://nas.local:8096'), 'http://nas.local:8096');
  });

  test('formatting helpers', () {
    expect(fmtTime(75), '1:15');
    expect(fmtTime(3725), '1:02:05');
    expect(fmtRuntime(133), '2u 13m');
    expect(fmtBitrate(4088552), '4,1 Mbps');
    expect(fmtSize(1500000000), '1,5 GB');
  });

  testWidgets('onboarding walks from the intro to the server form', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await api.load();
    await tester.pumpWidget(MaterialApp(theme: K.theme(tv: false), home: const OnboardingScreen()));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Je eigen streamingdienst'), findsOneWidget);
    await tester.tap(find.text('Overslaan'));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Verbind met je server'), findsOneWidget);
    await tester.tap(find.text('Verbinden'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Vul het adres van je Kinoko-server in.'), findsOneWidget);
  });

  testWidgets('a poster card can be activated with the TV remote', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: PosterCard(const {'title': 'Up'}, width: 120, autofocus: true, onTap: () => taps++)))));
    await tester.pump();
    expect(find.text('Up'), findsOneWidget); // fallback title when there is no artwork
    await tester.sendKeyEvent(LogicalKeyboardKey.select);
    expect(taps, 1);
    await tester.tap(find.byType(Tappable));
    expect(taps, 2);
  });
}
