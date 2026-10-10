import 'dart:convert';

import 'package:http/http.dart' as http;

/// Aligns device monotonic time with host time.
///
/// The recorder timestamps events with [Stopwatch] elapsed milliseconds so
/// pauses and clock changes cannot reorder them; the host needs the offset and
/// a measured round-trip uncertainty to line those events up with narration.
class SaySpecClockCalibration {
  SaySpecClockCalibration({
    required this.offsetMs,
    required this.roundTripMs,
    required this.samples,
    required this.uncertaintyMs,
  });

  final int offsetMs;
  final int roundTripMs;
  final int samples;

  /// Best available bound on alignment error: half the best round trip.
  final int uncertaintyMs;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'offsetMs': offsetMs,
    'roundTripMs': roundTripMs,
    'samples': samples,
    'uncertaintyMs': uncertaintyMs,
  };
}

/// Measures host↔device offset using the minimum-round-trip sample of
/// [samples] requests, which is the standard NTP-style estimate.
Future<SaySpecClockCalibration> calibrateClock({
  required String endpoint,
  required Stopwatch monotonic,
  String? sessionToken,
  int samples = 3,
  http.Client? client,
}) async {
  final httpClient = client ?? http.Client();
  var bestRoundTrip = -1;
  var bestOffset = 0;
  var attempts = 0;
  try {
    for (var index = 0; index < samples; index += 1) {
      final sentMonotonic = monotonic.elapsedMilliseconds;
      final sentWall = DateTime.now().millisecondsSinceEpoch;
      try {
        final response = await httpClient
            .post(
              Uri.parse('$endpoint/clock'),
              headers: <String, String>{
                'content-type': 'application/json',
                if (sessionToken != null)
                  'authorization': 'Bearer $sessionToken',
              },
              body: jsonEncode(<String, dynamic>{
                'sentMonotonicMs': sentMonotonic,
                'sentWallClockMs': sentWall,
              }),
            )
            .timeout(const Duration(seconds: 5));
        if (response.statusCode < 200 || response.statusCode >= 300) continue;
        final receivedMonotonic = monotonic.elapsedMilliseconds;
        final roundTrip = receivedMonotonic - sentMonotonic;
        final body = jsonDecode(response.body) as Map<String, dynamic>;
        final hostMs = (body['hostMonotonicMs'] as num).toInt();
        final midpoint = sentMonotonic + (roundTrip ~/ 2);
        final offset = hostMs - midpoint;
        attempts += 1;
        if (bestRoundTrip < 0 || roundTrip < bestRoundTrip) {
          bestRoundTrip = roundTrip;
          bestOffset = offset;
        }
      } catch (_) {
        continue;
      }
    }
  } finally {
    if (client == null) httpClient.close();
  }
  final roundTrip = bestRoundTrip < 0 ? 0 : bestRoundTrip;
  return SaySpecClockCalibration(
    offsetMs: bestOffset,
    roundTripMs: roundTrip,
    samples: attempts,
    uncertaintyMs: roundTrip ~/ 2,
  );
}
