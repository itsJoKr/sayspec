import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

/// Loopback stand-in for the SaySpec desktop capture server.
class _Host {
  late final HttpServer server;
  final List<Map<String, dynamic>> events = <Map<String, dynamic>>[];

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
    'text entry is recorded before the next touch, passwords included',
    (tester) async {
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
            body: Column(
              children: <Widget>[
                const TextField(
                  key: ValueKey<String>('sign_in_email'),
                  decoration: InputDecoration(labelText: 'Email'),
                ),
                const TextField(
                  key: ValueKey<String>('sign_in_password'),
                  obscureText: true,
                  decoration: InputDecoration(labelText: 'Password'),
                ),
                const TextField(
                  key: ValueKey<String>('otp'),
                  autofillHints: <String>[AutofillHints.oneTimeCode],
                ),
                FilledButton(
                  key: const ValueKey<String>('sign_in_submit'),
                  onPressed: () {},
                  child: const Text('Sign in'),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.runAsync(recorder.start);

      await tester.enterText(
        find.byKey(const ValueKey<String>('sign_in_email')),
        'joe@joe.com',
      );
      await tester.pump();
      // Moving to the next field records the email.
      await tester.enterText(
        find.byKey(const ValueKey<String>('sign_in_password')),
        'hunter22',
      );
      await tester.pump();
      // The password field keeps focus through the button tap; the touch itself
      // must record it first.
      await tester.tap(find.byKey(const ValueKey<String>('sign_in_submit')));
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey<String>('otp')),
        '123456',
      );
      await tester.pump();
      // Stop records the field that is still focused.
      await tester.runAsync(recorder.stop);

      final actions = host.events
          .where((event) => event['kind'] == 'action')
          .map(
            (event) => <String, dynamic>{
              ...(event['payload'] as Map).cast<String, dynamic>(),
              'key': (event['widget'] as Map?)?['key'],
            },
          )
          .where(
            (action) =>
                action['action'] == 'enterText' ||
                action['key'] == 'sign_in_submit',
          )
          .toList();
      expect(
        actions.map((action) => '${action['action']} ${action['key']}'),
        <String>[
          'enterText sign_in_email',
          'enterText sign_in_password',
          'tap sign_in_submit',
          'enterText otp',
        ],
      );
      expect(actions[0]['text'], 'joe@joe.com');
      expect(actions[0].containsKey('obscured'), isFalse);
      // Recordings use test accounts, so the password is recorded as typed.
      expect(actions[1]['text'], 'hunter22');
      expect(actions[1]['obscured'], isTrue);
      expect(actions[3]['text'], '123456');

      final email = host.events.firstWhere(
        (event) => (event['payload'] as Map)['action'] == 'enterText',
      );
      final candidates = ((email['widget'] as Map)['candidates'] as List)
          .cast<Map>();
      expect(candidates.first['value'], 'sign_in_email');
      // The finder text is the label, never the typed value.
      expect(
        candidates
            .where((candidate) => candidate['kind'] == 'text')
            .single['value'],
        'Email',
      );
    },
  );

  testWidgets('a tap on an obscured field never uses its value as a finder', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'hunter22');
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextField(
            key: const ValueKey<String>('password'),
            controller: controller,
            obscureText: true,
          ),
        ),
      ),
    );
    final identity = describeWidget(tester.element(find.byType(EditableText)));
    expect(jsonEncode(identity.toJson()), isNot(contains('hunter22')));
  });
}
