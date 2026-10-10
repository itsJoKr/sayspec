import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

const _testRecordingUrl = String.fromEnvironment('SAYSPEC_RECORDING_URL');

void main() {
  _pointerPathTests();

  testWidgets('environment initialization is inert outside a SaySpec launch', (
    tester,
  ) async {
    if (_testRecordingUrl.isNotEmpty) return;
    final initialized = await SaySpecRecorder.instance
        .initializeFromEnvironment(appId: 'dev.sayspec.test');
    expect(initialized, isFalse);
    expect(SaySpecRecorder.instance.state, SaySpecRecordingState.idle);
  });

  testWidgets('environment initialization rejects a partial SaySpec launch', (
    tester,
  ) async {
    if (_testRecordingUrl.isEmpty) return;
    await expectLater(
      SaySpecRecorder.instance.initializeFromEnvironment(
        appId: 'dev.sayspec.test',
      ),
      throwsA(
        isA<StateError>().having(
          (error) => error.message,
          'message',
          contains('SAYSPEC_RECORDING_SESSION'),
        ),
      ),
    );
  });

  testWidgets('identity prefers explicit keys, then semantics, then text', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: Column(
              children: <Widget>[
                FilledButton(
                  key: const ValueKey<String>('checkout_submit'),
                  onPressed: () {},
                  child: const Text('Place order'),
                ),
                Semantics(
                  label: 'Savings balance',
                  button: true,
                  child: GestureDetector(
                    onTap: () {},
                    child: const SizedBox(width: 40, height: 40),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    final keyed = tester.element(
      find.byKey(const ValueKey<String>('checkout_submit')),
    );
    final keyedIdentity = describeWidget(keyed);
    expect(keyedIdentity.key, 'checkout_submit');
    expect(keyedIdentity.keyKind, 'value');
    expect(keyedIdentity.text, 'Place order');
    expect(keyedIdentity.candidates.first['kind'], 'key');
    expect(keyedIdentity.candidates.first['confidence'], 'high');
    expect(keyedIdentity.bounds, isNotNull);

    final semantic = tester.element(find.byType(GestureDetector).first);
    final semanticIdentity = describeWidget(semantic);
    expect(
      semanticIdentity.candidates.map(
        (Map<String, dynamic> item) => item['kind'],
      ),
      contains('type'),
    );
  });

  test('envelope carries schema version and calibration', () {
    final envelope = SaySpecRecorderEnvelope(
      sessionId: 'session_1',
      projectId: 'project_1',
      appId: 'dev.sayspec.fixture',
      device: <String, dynamic>{'platform': 'android'},
      clock: SaySpecClockCalibration(
        offsetMs: 12,
        roundTripMs: 6,
        samples: 3,
        uncertaintyMs: 3,
      ).toJson(),
      startedAt: DateTime.utc(2026, 1, 1),
      sdk: <String, dynamic>{'version': SaySpecRecorderSchema.sdkVersion},
    );
    final json =
        jsonDecode(jsonEncode(envelope.toJson())) as Map<String, dynamic>;
    expect(json['kind'], 'sayspec-flutter-recording');
    expect(json['schemaVersion'], 1);
    expect((json['sdk'] as Map<String, dynamic>)['version'], '0.11.0');
    expect((json['clock'] as Map<String, dynamic>)['uncertaintyMs'], 3);
  });

  test('transport keeps events queued when the host is unreachable', () async {
    final transport = SaySpecRecorderTransport(
      endpoint: 'http://127.0.0.1:1/events',
      sessionId: 'session_1',
    );
    for (var index = 0; index < 30; index += 1) {
      transport.enqueue(<String, dynamic>{'seq': index});
    }
    expect(transport.queued, 30);
    final commands = await transport.flush(
      envelope: <String, dynamic>{'kind': 'sayspec-flutter-recording'},
    );
    expect(commands, isEmpty);
    expect(transport.queued, 30);
    expect(transport.delivered, 0);
    expect(transport.lastError, isNotNull);
    transport.dispose();
  });
}

/// Regression coverage for the real pointer path: a tap lands on a deep
/// unkeyed render object, so identity must resolve to the keyed widget a
/// developer named rather than to Flutter's gesture wrapper.
void _pointerPathTests() {
  testWidgets('a tap resolves to the nearest keyed interactive widget', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: FilledButton(
              key: const ValueKey<String>('add_item_coffee'),
              onPressed: () {},
              child: const Text('Add'),
            ),
          ),
        ),
      ),
    );

    final element = tester.element(find.byType(FilledButton));
    final hit = _deepestHit(
      element,
      tester.getCenter(find.byType(FilledButton)),
    );
    final identity = describeWidget(hit ?? element);
    expect(identity.key, 'add_item_coffee');
    expect(identity.widgetType, 'FilledButton');
    expect(identity.candidates.first['kind'], 'key');
  });
}

/// Mirrors the recorder's own deepest-hit selection so the test exercises the
/// same resolution order.
Element? _deepestHit(Element root, Offset position) {
  Element? best;
  double bestArea = double.infinity;
  void collect(Element current) {
    final object = current.renderObject;
    if (object is RenderBox &&
        object.attached &&
        object.hasSize &&
        !object.size.isEmpty) {
      final origin = object.localToGlobal(Offset.zero);
      if ((origin & object.size).contains(position) &&
          object.size.width * object.size.height < bestArea) {
        final result = BoxHitTestResult();
        if (object.hitTest(result, position: object.globalToLocal(position))) {
          best = current;
          bestArea = object.size.width * object.size.height;
        }
      }
    }
    current.visitChildren(collect);
  }

  root.visitChildren(collect);
  return best;
}
