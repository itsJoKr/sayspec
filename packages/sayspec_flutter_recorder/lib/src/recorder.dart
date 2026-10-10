import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'clock.dart';
import 'identity.dart';
import 'overlay.dart';
import 'schema.dart';
import 'transport.dart';

/// Host-visible recording state.
enum SaySpecRecordingState { idle, recording, paused, stopped, failed }

/// Options for one recording session.
class SaySpecRecorderOptions {
  const SaySpecRecorderOptions({
    required this.baseUrl,
    required this.projectId,
    required this.sessionId,
    this.sessionToken,
    this.appId = 'unknown',
    this.screenshotBoundaryKey,
    this.captureScreenshots = true,
    this.maxScreenshotBytes = 900 * 1024,
    this.flushInterval = const Duration(milliseconds: 400),
    this.maxScreenshots = 240,
    this.autoStart = false,
    this.showOverlay = false,
  });

  /// SaySpec host origin, for example `http://127.0.0.1:4517`.
  final String baseUrl;
  final String projectId;
  final String sessionId;

  /// Bearer token the host minted for this capture session.
  final String? sessionToken;
  final String appId;

  /// Boundary the app exposes for evidence screenshots. When null, screenshots
  /// are skipped and the evidence carries widget identity and timing only.
  final GlobalKey? screenshotBoundaryKey;
  final bool captureScreenshots;
  final int maxScreenshotBytes;
  final Duration flushInterval;
  final int maxScreenshots;

  /// Start recording as soon as [SaySpecRecorder.initialize] completes.
  ///
  /// A host-launched instrumented app sets this so evidence exists for the
  /// first interaction; a normal app leaves it off and starts explicitly.
  final bool autoStart;

  /// Draw the SaySpec Record/Stop overlay above the app's root navigator.
  ///
  /// A SaySpec-launched app shows it so the tester starts and stops each test
  /// on the device, exactly like the web lane's target-page overlay.
  final bool showOverlay;
}

/// Records widget-level Flutter evidence and streams it to the SaySpec host.
///
/// ```dart
/// WidgetsFlutterBinding.ensureInitialized();
/// await SaySpecRecorder.instance.initializeFromEnvironment(
///   appId: 'com.example.my_app',
///   screenshotBoundaryKey: recordingSurfaceKey,
/// );
/// runApp(const MyApp());
/// ```
class SaySpecRecorder extends RouteObserver<PageRoute<dynamic>>
    with WidgetsBindingObserver {
  SaySpecRecorder._() : super();

  static final SaySpecRecorder instance = SaySpecRecorder._();

  SaySpecRecorderOptions? _options;
  SaySpecRecorderTransport? _transport;
  SaySpecClockCalibration? _calibration;
  final Stopwatch _monotonic = Stopwatch();
  final ValueNotifier<SaySpecRecordingState> _stateNotifier =
      ValueNotifier<SaySpecRecordingState>(SaySpecRecordingState.idle);
  SaySpecRecordingState get _state => _stateNotifier.value;
  set _state(SaySpecRecordingState value) => _stateNotifier.value = value;
  final Stopwatch _elapsed = Stopwatch();
  int _recordingIndex = 0;
  OverlayEntry? _overlayEntry;
  final Set<int> _overlayPointers = <int>{};

  /// Key of the overlay control; its bounds are excluded from evidence.
  final GlobalKey overlayKey = GlobalKey(
    debugLabel: 'SaySpec recorder overlay',
  );

  /// True while an evidence screenshot is taken, so the overlay stays out of it.
  final ValueNotifier<bool> overlayHidden = ValueNotifier<bool>(false);
  int _seq = 0;
  int _screenshotsTaken = 0;
  bool _envelopeSent = false;
  bool _flushing = false;
  DateTime? _startedAt;
  String? _currentRoute;
  String? _error;
  Timer? _flushTimer;
  bool _initialized = false;
  Offset? _dragStart;
  double _dragDistance = 0;

  /// The focused text field and the value last recorded for it.
  _TrackedText? _trackedText;

  SaySpecRecordingState get state => _state;
  ValueListenable<SaySpecRecordingState> get stateListenable => _stateNotifier;

  /// Time spent recording in the current test, paused time included.
  Duration get elapsed => _elapsed.elapsed;
  int get eventCount => _seq;
  SaySpecClockCalibration? get calibration => _calibration;
  String? get error => _error;
  String? get currentRoute => _currentRoute;

  /// Initializes a recording from the launch values supplied by SaySpec.
  ///
  /// Returns `false` without changing the app when it was launched normally.
  /// When any SaySpec launch value is present, all four values must be present;
  /// a partial configuration fails immediately instead of producing an
  /// unauthenticated or incorrectly attributed capture.
  ///
  /// Call this after [WidgetsFlutterBinding.ensureInitialized] and before
  /// `runApp`. SaySpec owns the internal Dart defines; applications provide
  /// only their identity and optional screenshot boundary.
  Future<bool> initializeFromEnvironment({
    required String appId,
    GlobalKey? screenshotBoundaryKey,
    bool captureScreenshots = true,
    int maxScreenshotBytes = 900 * 1024,
    Duration flushInterval = const Duration(milliseconds: 400),
    int maxScreenshots = 240,
  }) async {
    const baseUrl = String.fromEnvironment('SAYSPEC_RECORDING_URL');
    const sessionId = String.fromEnvironment('SAYSPEC_RECORDING_SESSION');
    const sessionToken = String.fromEnvironment('SAYSPEC_RECORDING_TOKEN');
    const projectId = String.fromEnvironment('SAYSPEC_RECORDING_PROJECT');
    const values = <String, String>{
      'SAYSPEC_RECORDING_URL': baseUrl,
      'SAYSPEC_RECORDING_SESSION': sessionId,
      'SAYSPEC_RECORDING_TOKEN': sessionToken,
      'SAYSPEC_RECORDING_PROJECT': projectId,
    };
    if (values.values.every((value) => value.isEmpty)) return false;
    final missing = values.entries
        .where((entry) => entry.value.isEmpty)
        .map((entry) => entry.key)
        .join(', ');
    if (missing.isNotEmpty) {
      throw StateError(
        'The SaySpec recording launch is incomplete. Missing: $missing. Start the recording from the SaySpec desktop app.',
      );
    }
    if (appId.trim().isEmpty) {
      throw ArgumentError.value(
        appId,
        'appId',
        'The application id cannot be empty.',
      );
    }
    final endpoint = Uri.tryParse(baseUrl);
    if (endpoint == null || !endpoint.hasScheme || endpoint.host.isEmpty) {
      throw StateError(
        'SAYSPEC_RECORDING_URL is not a valid absolute URL. Start the recording again from the SaySpec desktop app.',
      );
    }
    await initialize(
      SaySpecRecorderOptions(
        baseUrl: baseUrl,
        projectId: projectId,
        sessionId: sessionId,
        sessionToken: sessionToken,
        appId: appId,
        screenshotBoundaryKey: screenshotBoundaryKey,
        captureScreenshots: captureScreenshots,
        maxScreenshotBytes: maxScreenshotBytes,
        flushInterval: flushInterval,
        maxScreenshots: maxScreenshots,
        showOverlay: true,
      ),
    );
    return true;
  }

  /// Installs observability. Must run after `WidgetsFlutterBinding.ensureInitialized()`.
  Future<void> initialize(SaySpecRecorderOptions options) async {
    if (_initialized) {
      throw StateError('SaySpecRecorder is already initialized.');
    }
    _initialized = true;
    _options = options;
    _monotonic.start();
    _transport = SaySpecRecorderTransport(
      endpoint: '${options.baseUrl}/events',
      sessionId: options.sessionId,
      sessionToken: options.sessionToken,
    );
    _calibration = await calibrateClock(
      endpoint: options.baseUrl,
      monotonic: _monotonic,
      sessionToken: options.sessionToken,
    );
    WidgetsBinding.instance.addObserver(this);
    GestureBinding.instance.pointerRouter.addGlobalRoute(_onPointerEvent);
    FocusManager.instance.addListener(_onFocusChange);
    ServicesBinding.instance.defaultBinaryMessenger.setMessageHandler(
      SaySpecRecorderSchema.commandChannel,
      (message) async {
        final command = <String, dynamic>{};
        if (message != null) {
          final decoded = jsonDecode(utf8.decode(message.buffer.asUint8List()));
          if (decoded is Map) command.addAll(decoded.cast<String, dynamic>());
        }
        try {
          return const StandardMethodCodec().encodeSuccessEnvelope(
            await handleCommand(command),
          );
        } catch (error) {
          return const StandardMethodCodec().encodeErrorEnvelope(
            code: 'recorder',
            message: error.toString(),
          );
        }
      },
    );
    if (options.showOverlay) _installOverlay();
    if (options.autoStart) await start();
  }

  /// Inserts the overlay into the root navigator's overlay once it exists.
  ///
  /// The navigator re-arranges only its own route entries, so this entry stays
  /// above every page and dialog without the app wrapping anything.
  void _installOverlay([int attempt = 0]) {
    if (_overlayEntry != null) return;
    // An app that did not register the recorder as a navigator observer still
    // gets the overlay through the first Overlay in the tree.
    final overlay =
        navigator?.overlay ?? (attempt > 0 ? _findRootOverlay() : null);
    if (overlay == null) {
      if (attempt < 120) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_initialized) _installOverlay(attempt + 1);
        });
        WidgetsBinding.instance.scheduleFrame();
      } else {
        debugPrint(
          'SaySpec recorder: no Overlay found; the Record control cannot be shown.',
        );
      }
      return;
    }
    final entry = OverlayEntry(
      builder: (context) => SaySpecRecorderOverlay(recorder: this),
    );
    _overlayEntry = entry;
    overlay.insert(entry);
  }

  static OverlayState? _findRootOverlay() {
    OverlayState? found;
    void visit(Element element) {
      if (found != null) return;
      if (element is StatefulElement && element.state is OverlayState) {
        found = element.state as OverlayState;
        return;
      }
      element.visitChildren(visit);
    }

    WidgetsBinding.instance.rootElement?.visitChildren(visit);
    return found;
  }

  Rect? _overlayBounds() {
    final object = overlayKey.currentContext?.findRenderObject();
    if (object is! RenderBox || !object.attached || !object.hasSize) {
      return null;
    }
    return object.localToGlobal(Offset.zero) & object.size;
  }

  /// Wraps the application root. The recorder observes routes through the
  /// `RouteObserver` registration the host app performs on its navigator.
  Widget wrap(Widget child) => child;

  /// Runs one host command. Exposed so the host channel and tests share one path.
  Future<Map<String, dynamic>> handleCommand(
    Map<String, dynamic> command,
  ) async {
    switch (command['command']) {
      case 'start':
        await start();
        return <String, dynamic>{'state': _state.name};
      case 'pause':
        await pause();
        return <String, dynamic>{'state': _state.name};
      case 'resume':
        await resume();
        return <String, dynamic>{'state': _state.name};
      case 'mark':
        await mark(command['label']?.toString() ?? 'marker');
        return <String, dynamic>{'state': _state.name};
      case 'stop':
        return stop();
      case 'status':
        return <String, dynamic>{
          'state': _state.name,
          'eventCount': _seq,
          'queued': _transport?.queued ?? 0,
          if (_calibration != null) 'calibration': _calibration!.toJson(),
          if (_currentRoute != null) 'route': _currentRoute,
        };
      default:
        throw ArgumentError(
          'Unknown SaySpec recorder command: ${command['command']}',
        );
    }
  }

  Future<void> start() async {
    if (_options == null) {
      throw StateError('Initialize the SaySpec recorder before starting it.');
    }
    if (_state == SaySpecRecordingState.recording ||
        _state == SaySpecRecordingState.paused) {
      return;
    }
    // Every Record press is a separate test: numbering, screenshots budget and
    // the envelope start over, and the clock is re-measured because the app may
    // have sat idle for a long time since launch.
    final calibration = await calibrateClock(
      endpoint: _options!.baseUrl,
      monotonic: _monotonic,
      sessionToken: _options!.sessionToken,
    );
    if (calibration.samples > 0 || _calibration == null) {
      _calibration = calibration;
    }
    _recordingIndex += 1;
    _seq = 0;
    _screenshotsTaken = 0;
    _startedAt = DateTime.now();
    _elapsed
      ..reset()
      ..start();
    _state = SaySpecRecordingState.recording;
    _envelopeSent = false;
    // Text already in a focused field belongs to the app's starting state.
    _trackedText = _focusedText();
    _emit(kind: 'lifecycle', payload: <String, dynamic>{'phase': 'started'});
    // The screen visible when Record is pressed is the test's first evidence.
    _emit(
      kind: 'navigation',
      payload: <String, dynamic>{
        'route': _currentRoute ?? 'unknown',
        'initial': true,
      },
      screenshot: await _captureScreenshot(),
    );
    await _flush();
    _flushTimer?.cancel();
    _flushTimer = Timer.periodic(
      _options!.flushInterval,
      (_) => unawaited(_flush(poll: true)),
    );
  }

  Future<void> mark(String label) async {
    _emit(kind: 'marker', payload: <String, dynamic>{'label': label});
    await _flush();
  }

  Future<void> pause() async {
    if (_state != SaySpecRecordingState.recording) return;
    _recordTextEntry();
    _state = SaySpecRecordingState.paused;
    _emit(kind: 'lifecycle', payload: <String, dynamic>{'phase': 'paused'});
    await _flush();
  }

  Future<void> resume() async {
    if (_state != SaySpecRecordingState.paused) return;
    // Edits made while paused are not part of the test.
    _trackedText = _focusedText();
    _state = SaySpecRecordingState.recording;
    _emit(kind: 'lifecycle', payload: <String, dynamic>{'phase': 'resumed'});
    await _flush();
  }

  /// Stops the session and drains every queued event before resolving.
  Future<Map<String, dynamic>> stop() async {
    _flushTimer?.cancel();
    _flushTimer = null;
    if (_state != SaySpecRecordingState.recording &&
        _state != SaySpecRecordingState.paused) {
      return _summary();
    }
    _recordTextEntry();
    _emit(kind: 'lifecycle', payload: <String, dynamic>{'phase': 'stopped'});
    _elapsed.stop();
    _state = SaySpecRecordingState.stopped;
    for (var attempt = 0; attempt < 20; attempt += 1) {
      await _flush();
      if ((_transport?.queued ?? 0) == 0) break;
      await Future<void>.delayed(const Duration(milliseconds: 150));
    }
    await _postSummary();
    final summary = _summary();
    // SaySpec normally restarts the app for the next test; if it does not,
    // the overlay returns to Ready so another Record press still works.
    Timer(const Duration(seconds: 6), () {
      if (_state == SaySpecRecordingState.stopped) {
        _state = SaySpecRecordingState.idle;
      }
    });
    return summary;
  }

  Future<void> _postSummary() async {
    final options = _options;
    if (options == null) return;
    try {
      await http
          .post(
            Uri.parse('${options.baseUrl}/session/complete'),
            headers: <String, String>{
              'content-type': 'application/json',
              if (options.sessionToken != null)
                'authorization': 'Bearer ${options.sessionToken}',
            },
            body: jsonEncode(_summary()),
          )
          .timeout(const Duration(seconds: 10));
    } catch (error) {
      _error = 'The recording summary could not be submitted: $error';
    }
  }

  Map<String, dynamic> _summary() => <String, dynamic>{
    'sessionId': _options?.sessionId,
    'state': _state.name,
    'eventCount': _seq,
    'delivered': _transport?.delivered ?? 0,
    'dropped': _transport?.dropped ?? 0,
    if (_transport?.lastError != null) 'lastError': _transport!.lastError,
    if (_error != null) 'error': _error,
  };

  Future<void> _flush({bool poll = false}) async {
    final transport = _transport;
    if (transport == null || _flushing) return;
    _flushing = true;
    try {
      final commands = await transport.flush(
        envelope: _envelopeSent ? null : _envelopeJson(),
        poll: poll,
      );
      _envelopeSent = true;
      for (final command in commands) {
        try {
          await handleCommand(command);
        } catch (error) {
          debugPrint('SaySpec recorder: host command failed — $error');
        }
      }
    } finally {
      _flushing = false;
    }
  }

  Map<String, dynamic> _envelopeJson() => SaySpecRecorderEnvelope(
    sessionId: _options!.sessionId,
    projectId: _options!.projectId,
    appId: _options!.appId,
    device: <String, dynamic>{
      'platform': defaultTargetPlatform.name,
      'dartVersion': Platform.version,
      'locale': Platform.localeName,
    },
    clock: _calibration?.toJson() ?? const <String, dynamic>{},
    startedAt: _startedAt ?? DateTime.now(),
    sdk: <String, dynamic>{
      'name': 'sayspec_flutter_recorder',
      'version': SaySpecRecorderSchema.sdkVersion,
      'schemaVersion': SaySpecRecorderSchema.version,
    },
  ).toJson();

  void _emit({
    required String kind,
    Map<String, dynamic> payload = const <String, dynamic>{},
    SaySpecWidgetIdentity? widget,
    String? previousRoute,
    String? screenshot,
    String? route,
  }) {
    if (_state == SaySpecRecordingState.paused &&
        kind != 'marker' &&
        kind != 'lifecycle') {
      return;
    }
    if (_state == SaySpecRecordingState.idle ||
        _state == SaySpecRecordingState.stopped) {
      return;
    }
    _seq += 1;
    _transport?.enqueue(
      SaySpecRecorderEvent(
        id: 'event_${_options?.sessionId ?? 'session'}_${_recordingIndex}_$_seq',
        seq: _seq,
        kind: kind,
        monotonicMs: _monotonic.elapsedMilliseconds,
        wallClockMs: DateTime.now().millisecondsSinceEpoch,
        route: route ?? _currentRoute,
        previousRoute: previousRoute,
        widget: widget,
        payload: payload,
        screenshot: screenshot,
      ).toJson(),
    );
  }

  void _onPointerEvent(PointerEvent event) {
    if (event is PointerDownEvent &&
        (_overlayBounds()?.contains(event.position) ?? false)) {
      _overlayPointers.add(event.pointer);
    }
    if (_overlayPointers.contains(event.pointer)) {
      if (event is PointerUpEvent || event is PointerCancelEvent) {
        _overlayPointers.remove(event.pointer);
      }
      return;
    }
    if (_state != SaySpecRecordingState.recording) return;
    if (event is PointerDownEvent) {
      // A button tap does not take focus from a text field, so the value typed
      // before this touch is recorded here, ahead of the touch itself.
      _recordTextEntry();
      _dragStart = event.position;
      _dragDistance = 0;
      unawaited(_recordTouch('tap', event.position));
    } else if (event is PointerMoveEvent && event.buttons != 0) {
      _dragDistance += event.delta.distance;
    } else if (event is PointerUpEvent && _dragStart != null) {
      final distance = _dragDistance;
      final start = _dragStart!;
      _dragStart = null;
      _dragDistance = 0;
      if (distance > kTouchSlop * 4) {
        unawaited(
          _recordTouch(
            'drag',
            start,
            payload: <String, dynamic>{
              'dx': (event.position.dx - start.dx).round(),
              'dy': (event.position.dy - start.dy).round(),
            },
          ),
        );
      }
    }
  }

  void _onFocusChange() {
    final focused = _focusedText();
    if (focused != null &&
        identical(focused.controller, _trackedText?.controller)) {
      return;
    }
    _recordTextEntry();
    _trackedText = focused;
  }

  /// The [EditableText] that owns primary focus, with its current value as the
  /// baseline. Every Flutter text input (TextField, TextFormField,
  /// CupertinoTextField, search and autocomplete fields) is built on it.
  _TrackedText? _focusedText() {
    final context = FocusManager.instance.primaryFocus?.context;
    if (context is! Element) return null;
    Element? editable;
    if (context.widget is EditableText) {
      editable = context;
    } else {
      var depth = 0;
      context.visitAncestorElements((ancestor) {
        if (ancestor.widget is EditableText) {
          editable = ancestor;
          return false;
        }
        return (depth += 1) < 24;
      });
    }
    final element = editable;
    if (element == null) return null;
    final widget = element.widget as EditableText;
    SaySpecWidgetIdentity? identity;
    try {
      identity = describeTextField(element);
    } catch (error) {
      debugPrint('SaySpec recorder: text field identity failed — $error');
    }
    return _TrackedText(
      controller: widget.controller,
      identity: identity,
      route: _currentRoute,
      obscured: widget.obscureText,
      recorded: widget.controller.text,
    );
  }

  /// Emits the focused field's value when it changed since it was last recorded.
  ///
  /// The final value is recorded rather than keystrokes, so pasting, autofill,
  /// dictation and keyboard suggestions are captured the same way as typing.
  /// Screenshots are left to the next touch, which shows the filled field.
  void _recordTextEntry() {
    final tracked = _trackedText;
    if (tracked == null || _state != SaySpecRecordingState.recording) return;
    final String value;
    try {
      value = tracked.controller.text;
    } catch (_) {
      return;
    }
    if (value == tracked.recorded) return;
    tracked.recorded = value;
    final truncated = value.length > _maxRecordedTextLength;
    _emit(
      kind: 'action',
      // Password and other obscured fields are recorded too: recordings use
      // test accounts, and the generated test types the same value.
      payload: <String, dynamic>{
        'action': 'enterText',
        'text': truncated ? value.substring(0, _maxRecordedTextLength) : value,
        if (truncated) 'truncated': true,
        if (tracked.obscured) 'obscured': true,
      },
      widget: tracked.identity,
      route: tracked.route,
    );
  }

  Future<void> _recordTouch(
    String action,
    Offset position, {
    Map<String, dynamic> payload = const <String, dynamic>{},
  }) async {
    // The tap may navigate before the screenshot below completes; the route
    // the tester touched is the one showing now.
    final route = _currentRoute;
    final element = _elementAt(position);
    SaySpecWidgetIdentity? identity;
    if (element != null) {
      try {
        identity = describeWidget(element);
      } catch (error) {
        debugPrint('SaySpec recorder: widget identity failed — $error');
      }
    }
    final screenshot = await _captureScreenshot();
    _emit(
      kind: 'action',
      payload: <String, dynamic>{
        'action': action,
        'x': position.dx.round(),
        'y': position.dy.round(),
        ...payload,
      },
      widget: identity,
      screenshot: screenshot,
      route: route,
    );
  }

  /// Smallest render box that both contains the point and accepts a hit there.
  ///
  /// Selecting the smallest match matters: a full-screen viewport also accepts
  /// the hit, and reporting it would erase every distinction between the
  /// widgets a user actually touched.
  Element? _elementAt(Offset position) {
    Element? best;
    double bestArea = double.infinity;
    void collect(Element element) {
      final object = element.renderObject;
      if (object is RenderBox &&
          object.attached &&
          object.hasSize &&
          !object.size.isEmpty) {
        final origin = object.localToGlobal(Offset.zero);
        final bounds = origin & object.size;
        if (bounds.contains(position) &&
            object.size.width * object.size.height < bestArea) {
          final result = BoxHitTestResult();
          if (object.hitTest(
            result,
            position: object.globalToLocal(position),
          )) {
            best = element;
            bestArea = object.size.width * object.size.height;
          }
        }
      }
      element.visitChildren(collect);
    }

    final root = WidgetsBinding.instance.rootElement;
    if (root == null) return null;
    root.visitChildren(collect);
    return best;
  }

  Future<String?> _captureScreenshot() async {
    final options = _options;
    final boundaryKey = options?.screenshotBoundaryKey;
    if (options == null || !options.captureScreenshots || boundaryKey == null) {
      return null;
    }
    if (_screenshotsTaken >= options.maxScreenshots) return null;
    final object = boundaryKey.currentContext?.findRenderObject();
    if (object is! RenderRepaintBoundary) return null;
    final hideOverlay = _overlayEntry != null;
    try {
      if (hideOverlay) {
        overlayHidden.value = true;
        await WidgetsBinding.instance.endOfFrame;
      }
      final image = await object.toImage(pixelRatio: 0.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      if (data == null) return null;
      final bytes = data.buffer.asUint8List();
      if (bytes.length > options.maxScreenshotBytes) return null;
      _screenshotsTaken += 1;
      return base64Encode(bytes);
    } catch (error) {
      debugPrint('SaySpec recorder: screenshot failed — $error');
      return null;
    } finally {
      if (hideOverlay) overlayHidden.value = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_state != SaySpecRecordingState.recording &&
        _state != SaySpecRecordingState.paused) {
      return;
    }
    _emit(kind: 'lifecycle', payload: <String, dynamic>{'phase': state.name});
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPush(route, previousRoute);
    _recordTextEntry();
    final name = routeName(route);
    if (name == null) return;
    final previous = _currentRoute;
    _currentRoute = name;
    _emit(
      kind: 'navigation',
      previousRoute: previous,
      payload: <String, dynamic>{'route': name},
    );
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPop(route, previousRoute);
    _recordTextEntry();
    final previous = _currentRoute;
    _currentRoute = routeName(previousRoute) ?? previous;
    _emit(
      kind: 'navigation',
      previousRoute: previous,
      payload: <String, dynamic>{'route': _currentRoute ?? 'unknown'},
    );
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
    _recordTextEntry();
    final name = newRoute == null ? null : routeName(newRoute);
    if (name == null) return;
    final previous = _currentRoute;
    _currentRoute = name;
    _emit(
      kind: 'navigation',
      previousRoute: previous,
      payload: <String, dynamic>{'route': name},
    );
  }

  /// `Route.settings.name` when set, otherwise the runtime route type. A null
  /// name is honest: the host records an unnamed route instead of inventing one.
  static String? routeName(Route<dynamic>? route) {
    if (route == null) return null;
    if (route.settings.name != null && route.settings.name!.isNotEmpty) {
      return route.settings.name;
    }
    return route.runtimeType.toString();
  }

  /// Detaches observers. Safe to call more than once.
  void dispose() {
    _flushTimer?.cancel();
    _flushTimer = null;
    WidgetsBinding.instance.removeObserver(this);
    GestureBinding.instance.pointerRouter.removeGlobalRoute(_onPointerEvent);
    FocusManager.instance.removeListener(_onFocusChange);
    _trackedText = null;
    ServicesBinding.instance.defaultBinaryMessenger.setMessageHandler(
      SaySpecRecorderSchema.commandChannel,
      null,
    );
    _transport?.dispose();
    _overlayEntry?.remove();
    _overlayEntry = null;
    _overlayPointers.clear();
    _initialized = false;
    _state = SaySpecRecordingState.idle;
  }
}

const int _maxRecordedTextLength = 4000;

class _TrackedText {
  _TrackedText({
    required this.controller,
    required this.identity,
    required this.route,
    required this.obscured,
    required this.recorded,
  });

  final TextEditingController controller;
  final SaySpecWidgetIdentity? identity;
  final String? route;

  /// True for a password-style field that shows dots instead of the value.
  final bool obscured;
  String recorded;
}
