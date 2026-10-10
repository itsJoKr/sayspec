import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

/// Loopback stand-in for the SaySpec desktop capture server.
class _Host {
  late final HttpServer server;
  final List<Map<String, dynamic>> events = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> completions = <Map<String, dynamic>>[];

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final body =
          jsonDecode(await utf8.decoder.bind(request).join())
              as Map<String, dynamic>;
      Object response = <String, dynamic>{'ok': true};
      if (request.uri.path == '/clock') {
        response = <String, dynamic>{'hostMonotonicMs': 1000};
      } else if (request.uri.path == '/events') {
        events.addAll((body['events'] as List).cast<Map<String, dynamic>>());
        response = <String, dynamic>{'commands': <Object>[]};
      } else if (request.uri.path == '/session/complete') {
        completions.add(body);
      }
      request.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(response));
      await request.response.close();
    });
  }

  String get url => 'http://127.0.0.1:${server.port}';
}

void main() {
  testWidgets(
    'overlay starts idle, owns each test boundary and is excluded from evidence',
    (tester) async {
      // The test binding answers every HTTP request with 400; this test talks
      // to a real loopback host instead.
      final overrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = overrides);
      final recorder = SaySpecRecorder.instance;
      final host = _Host();
      await tester.runAsync(host.start);
      await tester.runAsync(
        () => recorder.initialize(
          SaySpecRecorderOptions(
            baseUrl: host.url,
            projectId: 'project_one',
            sessionId: 'session_one',
            sessionToken: 'token',
            flushInterval: const Duration(hours: 1),
            showOverlay: true,
          ),
        ),
      );
      addTearDown(() async {
        recorder.dispose();
        await host.server.close(force: true);
      });

      await tester.pumpWidget(
        MaterialApp(
          navigatorObservers: <NavigatorObserver>[recorder],
          home: Scaffold(
            body: Center(
              child: FilledButton(
                key: const ValueKey<String>('target'),
                onPressed: () {},
                child: const Text('Target'),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(recorder.state, SaySpecRecordingState.idle);
      expect(find.bySemanticsLabel('Record'), findsOneWidget);

      // Idle interaction produces no evidence.
      await tester.tap(find.byKey(const ValueKey<String>('target')));
      await tester.pump();
      expect(host.events, isEmpty);

      await tester.runAsync(recorder.start);
      await tester.pump();
      expect(recorder.state, SaySpecRecordingState.recording);
      expect(find.bySemanticsLabel('Stop recording'), findsOneWidget);

      // A tap on the overlay's own surface is not app evidence.
      await tester.tapAt(
        tester.getTopLeft(find.bySemanticsLabel('SaySpec recorder')) +
            const Offset(20, 12),
      );
      await tester.tap(find.byKey(const ValueKey<String>('target')));
      await tester.pump();

      await tester.runAsync(recorder.stop);
      await tester.pump();
      expect(recorder.state, SaySpecRecordingState.stopped);
      expect(find.bySemanticsLabel('Record'), findsOneWidget);

      final kinds = host.events.map((event) => event['kind']).toList();
      expect(kinds.first, 'lifecycle');
      expect(host.events[1]['kind'], 'navigation');
      expect((host.events[1]['payload'] as Map)['initial'], isTrue);
      final actions = host.events
          .where((event) => event['kind'] == 'action')
          .toList();
      expect(actions, hasLength(1));
      expect((actions.single['widget'] as Map)['key'], 'target');
      expect((host.events.last['payload'] as Map)['phase'], 'stopped');
      expect(host.completions, hasLength(1));

      // A second Record press in the same process is a fresh test.
      host.events.clear();
      await tester.runAsync(recorder.start);
      expect(host.events.first['seq'], 1);
      expect(host.events.first['id'], 'event_session_one_2_1');
      await tester.runAsync(recorder.stop);
      expect(host.completions, hasLength(2));
    },
  );
}
