# SaySpec Flutter Recorder

Instrument a Flutter app so the SaySpec desktop app can turn a narrated walkthrough on Android or iOS into reusable Patrol tests.

> **Platform status:** Recording works on Android emulators and phones and on iOS simulators. This package records only when a SaySpec capture session supplies a local endpoint and session credentials.

## Features

- Records taps, drags, text entry, route changes, lifecycle events, and explicit markers.
- Resolves widget keys, semantics, visible text, and bounds into ranked Patrol finder candidates.
- Captures bounded screenshots from an app-provided `RepaintBoundary`.
- Uses monotonic event timestamps and measured host clock calibration.
- Keeps failed event batches queued instead of silently losing evidence.
- Sends evidence only to the authenticated capture endpoint provided by the SaySpec desktop app.

## Install

```sh
flutter pub add sayspec_flutter_recorder
```

The SaySpec desktop app can preview and apply this integration to a selected Flutter project. To integrate it manually, initialize the recorder before `runApp`, expose a screenshot boundary, and register the recorder as a navigator observer:

```dart
import 'package:flutter/material.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

final recordingSurfaceKey = GlobalKey();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await SaySpecRecorder.instance.initializeFromEnvironment(
    appId: 'com.example.my_app',
    screenshotBoundaryKey: recordingSurfaceKey,
  );

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorObservers: <NavigatorObserver>[SaySpecRecorder.instance],
      builder: (context, child) => RepaintBoundary(
        key: recordingSurfaceKey,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const Scaffold(body: Center(child: Text('Ready'))),
    );
  }
}
```

When SaySpec launches the instrumented app, it supplies its private `SAYSPEC_RECORDING_*` values as Dart defines and connects the app to its local capture server: through a port forward on Android, and directly on an iOS simulator, which shares the Mac's loopback interface. The SDK reads and validates those values internally and shows a small draggable SaySpec overlay: the app opens idle, **Record** starts one test and **Stop** saves it, after which SaySpec restarts the app process (without rebuilding) for the next test. Overlay taps are not recorded and the overlay is hidden from evidence screenshots. When the app is launched normally, `initializeFromEnvironment` returns `false`, leaves the recorder disabled, and the app runs normally.

Add stable keys and semantic labels to important controls so generated finders are resilient:

```dart
FilledButton(
  key: const ValueKey<String>('checkout_submit'),
  onPressed: submitOrder,
  child: const Text('Place order'),
)
```

Use markers when an application event should appear alongside user interactions:

```dart
await SaySpecRecorder.instance.mark('cart updated');
```

## Evidence and privacy

Text entry is recorded as the field's final value, so typing, pasting, autofill and dictation all end up in the same `enterText` action. Every field is recorded as entered, passwords included: recordings are made with test accounts, and the generated test signs in with the same value. An obscured field's action also carries `obscured: true`. Record only with test accounts, never with real personal credentials.

The recorder posts evidence to the capture URL supplied at launch. SaySpec uses an ephemeral bearer token and a loopback-only desktop listener, reached through a port forward on Android and directly from an iOS simulator. The SDK does not contain a cloud endpoint and does not upload evidence by itself.

Screenshots are optional. Set `captureScreenshots: false`, or omit `screenshotBoundaryKey`, to record interaction identity and timing without image evidence.

## Limitations

- The app must be built with this package; it cannot instrument an arbitrary production binary.
- Recording works on Android emulators and phones and on iOS simulators, not on physical iPhones or iPads.
- A generated finder is evidence, not a final assertion. Review generated Patrol tests before saving or running them.
- Screenshot capture is bounded by `maxScreenshots` and `maxScreenshotBytes`.

For the SaySpec product and desktop recorder, visit [sayspec.app](https://sayspec.app).
