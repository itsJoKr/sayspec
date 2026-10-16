/// Wire contract between the SaySpec Flutter recording SDK and the SaySpec
/// desktop host.
///
/// `schemaVersion` is part of the envelope. The host refuses an envelope whose
/// major version it does not understand instead of guessing at missing fields.
class SaySpecRecorderSchema {
  /// SDK release version included in every recording envelope.
  static const String sdkVersion = '0.12.0';

  /// Increment on any breaking change to the envelope or event payload.
  static const int version = 1;

  /// Name of the `MethodChannel` the host uses to reach the recorder.
  static const String commandChannel = 'dev.sayspec.recorder/commands';

  /// `ext.flutter.*` extension the host calls for command dispatch.
  static const String commandExtension = 'ext.flutter.sayspecRecorder';

  static const String envelopeKind = 'sayspec-flutter-recording';
}

/// Everything the host needs to attribute and interpret one recording session.
class SaySpecRecorderEnvelope {
  SaySpecRecorderEnvelope({
    required this.sessionId,
    required this.projectId,
    required this.appId,
    required this.device,
    required this.clock,
    required this.startedAt,
    required this.sdk,
  });

  final String sessionId;
  final String projectId;
  final String appId;
  final Map<String, dynamic> device;
  final Map<String, dynamic> clock;
  final DateTime startedAt;
  final Map<String, dynamic> sdk;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': SaySpecRecorderSchema.envelopeKind,
    'schemaVersion': SaySpecRecorderSchema.version,
    'sessionId': sessionId,
    'projectId': projectId,
    'appId': appId,
    'device': device,
    'clock': clock,
    'startedAt': startedAt.toUtc().toIso8601String(),
    'sdk': sdk,
  };
}

/// One recorded interaction, navigation or lifecycle entry.
class SaySpecRecorderEvent {
  SaySpecRecorderEvent({
    required this.id,
    required this.seq,
    required this.kind,
    required this.monotonicMs,
    required this.wallClockMs,
    this.route,
    this.previousRoute,
    this.widget,
    this.payload = const <String, dynamic>{},
    this.screenshot,
  });

  final String id;
  final int seq;

  /// One of `action`, `navigation`, `lifecycle` or `marker`.
  final String kind;
  final int monotonicMs;
  final int wallClockMs;
  final String? route;
  final String? previousRoute;
  final SaySpecWidgetIdentity? widget;
  final Map<String, dynamic> payload;
  final String? screenshot;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id,
    'seq': seq,
    'kind': kind,
    'monotonicMs': monotonicMs,
    'wallClockMs': wallClockMs,
    if (route != null) 'route': route,
    if (previousRoute != null) 'previousRoute': previousRoute,
    if (widget != null) 'widget': widget!.toJson(),
    'payload': payload,
    if (screenshot != null) 'screenshot': screenshot,
  };
}

/// Best-effort stable identity for the widget that produced an event.
///
/// A recorded literal is evidence, never the final assertion. The host uses
/// [candidates] (ranked, most durable first) to let a human or coding agent
/// choose a resilient finder instead of a coordinate.
class SaySpecWidgetIdentity {
  SaySpecWidgetIdentity({
    required this.widgetType,
    this.key,
    this.keyKind,
    this.semanticLabel,
    this.text,
    this.ancestors = const <String>[],
    this.candidates = const <Map<String, dynamic>>[],
    this.bounds,
  });

  final String widgetType;
  final String? key;

  /// `value` for `ValueKey<String>`, `global` for `GlobalKey`, otherwise the
  /// raw `Key.toString()` shape.
  final String? keyKind;
  final String? semanticLabel;
  final String? text;
  final List<String> ancestors;
  final List<Map<String, dynamic>> candidates;
  final Map<String, dynamic>? bounds;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'widgetType': widgetType,
    if (key != null) 'key': key,
    if (keyKind != null) 'keyKind': keyKind,
    if (semanticLabel != null) 'semanticLabel': semanticLabel,
    if (text != null) 'text': text,
    'ancestors': ancestors,
    'candidates': candidates,
    if (bounds != null) 'bounds': bounds,
  };
}
