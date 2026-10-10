/// SaySpec Flutter recording SDK.
///
/// Drop-in instrumentation for a Flutter app under test. It records taps,
/// drags, text entry, navigation, lifecycle and explicit markers with widget identity,
/// monotonic timing and host-aligned clock calibration, then streams bounded
/// batches to the SaySpec desktop app.
library;

export 'src/clock.dart';
export 'src/identity.dart';
export 'src/overlay.dart';
export 'src/recorder.dart';
export 'src/schema.dart';
export 'src/transport.dart';
