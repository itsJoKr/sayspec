import 'package:flutter/material.dart';

import 'recorder.dart';

const Color _ink = Color(0xFF202522);
const Color _paper = Color(0xFFF5F2EB);
const Color _border = Color(0xFFD4D4CA);
const Color _record = Color(0xFFC44B2D);

/// Small draggable Record/Stop control drawn above the app while SaySpec
/// launched it for recording.
///
/// A wordless vertical pill: the SaySpec mark above one circular button. The
/// app opens idle so the tester can navigate or sign in without producing
/// evidence, Record starts one test, Stop saves it. Taps on the overlay are
/// excluded from evidence and the overlay is hidden while evidence screenshots
/// are taken.
class SaySpecRecorderOverlay extends StatefulWidget {
  const SaySpecRecorderOverlay({super.key, required this.recorder});

  final SaySpecRecorder recorder;

  @override
  State<SaySpecRecorderOverlay> createState() => _SaySpecRecorderOverlayState();
}

class _SaySpecRecorderOverlayState extends State<SaySpecRecorderOverlay>
    with SingleTickerProviderStateMixin {
  static const double _width = 40;
  static const double _height = 72;

  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 600),
  );
  Offset? _position;
  bool _busy = false;

  bool get _active =>
      widget.recorder.state == SaySpecRecordingState.recording ||
      widget.recorder.state == SaySpecRecordingState.paused;

  @override
  void initState() {
    super.initState();
    widget.recorder.stateListenable.addListener(_onState);
    _onState();
  }

  @override
  void dispose() {
    widget.recorder.stateListenable.removeListener(_onState);
    _pulse.dispose();
    super.dispose();
  }

  void _onState() {
    // The mark's dot pulses while evidence is being recorded, like the web
    // overlay; a paused test holds it still.
    if (widget.recorder.state == SaySpecRecordingState.recording) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse
        ..stop()
        ..value = 0;
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggle() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (_active) {
        await widget.recorder.stop();
      } else {
        await widget.recorder.start();
      }
    } catch (error) {
      debugPrint('SaySpec recorder: overlay control failed — $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.maybeOf(context);
    final size = media?.size ?? const Size(360, 640);
    final padding = media?.padding ?? EdgeInsets.zero;
    // The software keyboard is a separate window; keep the control above it
    // so Stop stays reachable while the tester types.
    final keyboard = media?.viewInsets.bottom ?? 0;
    final position =
        _position ??
        Offset(
          size.width - _width - 12,
          size.height - _height - padding.bottom - 96,
        );
    final clamped = Offset(
      position.dx.clamp(0, (size.width - _width).clamp(0, double.infinity)),
      position.dy.clamp(
        padding.top,
        (size.height - keyboard - _height - 8).clamp(
          padding.top,
          double.infinity,
        ),
      ),
    );
    final active = _active;
    final stopped = widget.recorder.state == SaySpecRecordingState.stopped;
    return ValueListenableBuilder<bool>(
      valueListenable: widget.recorder.overlayHidden,
      builder: (context, hidden, child) => Positioned(
        left: clamped.dx,
        top: clamped.dy,
        child: Offstage(offstage: hidden, child: child),
      ),
      child: KeyedSubtree(
        key: widget.recorder.overlayKey,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onPanUpdate: (details) =>
              setState(() => _position = clamped + details.delta),
          child: Semantics(
            container: true,
            explicitChildNodes: true,
            label: 'SaySpec recorder',
            child: Container(
              width: _width,
              height: _height,
              decoration: BoxDecoration(
                color: _paper,
                border: Border.all(color: _border),
                borderRadius: BorderRadius.circular(_width / 2),
                boxShadow: const <BoxShadow>[
                  BoxShadow(
                    color: Color(0x33202522),
                    blurRadius: 14,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: <Widget>[
                  ExcludeSemantics(child: _Mark(pulse: _pulse)),
                  Semantics(
                    container: true,
                    button: true,
                    enabled: !_busy && !stopped,
                    label: active ? 'Stop recording' : 'Record',
                    child: Material(
                      color: active ? _record : _ink,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: _busy || stopped ? null : _toggle,
                        child: SizedBox.square(
                          dimension: 28,
                          child: Center(
                            child: AnimatedOpacity(
                              duration: const Duration(milliseconds: 150),
                              opacity: _busy || stopped ? 0.5 : 1,
                              child: Container(
                                width: active ? 10 : 12,
                                height: active ? 10 : 12,
                                decoration: BoxDecoration(
                                  color: active ? _paper : _record,
                                  shape: active
                                      ? BoxShape.rectangle
                                      : BoxShape.circle,
                                  borderRadius: active
                                      ? BorderRadius.circular(2)
                                      : null,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The SaySpec mark: a vermilion dot between square brackets.
class _Mark extends StatelessWidget {
  const _Mark({required this.pulse});

  final Animation<double> pulse;

  @override
  Widget build(BuildContext context) {
    // Brackets are painted rather than typed so the mark keeps its shape
    // whatever fonts the app under test ships.
    return CustomPaint(
      painter: const _BracketsPainter(),
      child: SizedBox(
        width: 18,
        height: 16,
        child: Center(
          child: AnimatedBuilder(
            animation: pulse,
            builder: (context, _) => Opacity(
              opacity: 1 - pulse.value * 0.7,
              child: Transform.scale(
                scale: 1 - pulse.value * 0.28,
                child: Container(
                  width: 5,
                  height: 5,
                  decoration: const BoxDecoration(
                    color: _record,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BracketsPainter extends CustomPainter {
  const _BracketsPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = _ink
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.square;
    const arm = 3.5;
    final top = 2.0;
    final bottom = size.height - 2;
    canvas.drawPath(
      Path()
        ..moveTo(1 + arm, top)
        ..lineTo(1, top)
        ..lineTo(1, bottom)
        ..lineTo(1 + arm, bottom),
      paint,
    );
    canvas.drawPath(
      Path()
        ..moveTo(size.width - 1 - arm, top)
        ..lineTo(size.width - 1, top)
        ..lineTo(size.width - 1, bottom)
        ..lineTo(size.width - 1 - arm, bottom),
      paint,
    );
  }

  @override
  bool shouldRepaint(_BracketsPainter oldDelegate) => false;
}
