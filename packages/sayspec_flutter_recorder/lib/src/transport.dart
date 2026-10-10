import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Posts bounded event batches to the SaySpec host and receives the host's
/// pending recorder commands in the same HTTP round trip.
///
/// Commands travel on the response instead of a second channel so pause/stop
/// still arrive while the app is offline from the Dart VM service, for example
/// in a release-mode build installed by hand.
///
/// Events are never dropped silently: a failed flush leaves the queue intact
/// (up to [maxQueuedEvents]) so a short host restart does not lose evidence.
class SaySpecRecorderTransport {
  SaySpecRecorderTransport({
    required this.endpoint,
    required this.sessionId,
    this.sessionToken,
    this.batchSize = 25,
    this.maxQueuedEvents = 5000,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String endpoint;
  final String sessionId;

  /// Bearer token minted by the host for this one capture session.
  final String? sessionToken;
  final int batchSize;
  final int maxQueuedEvents;
  final http.Client _client;
  final List<Map<String, dynamic>> _queue = <Map<String, dynamic>>[];
  bool _flushing = false;
  int delivered = 0;
  int dropped = 0;
  String? lastError;

  int get queued => _queue.length;

  void enqueue(Map<String, dynamic> event) {
    _queue.add(event);
    while (_queue.length > maxQueuedEvents) {
      _queue.removeAt(0);
      dropped += 1;
    }
  }

  /// Sends one batch plus (on request) the session envelope and returns the
  /// command list the host wants executed next.
  ///
  /// With [poll], an empty batch is still posted so host commands such as a
  /// desktop Stop arrive while the tester is not touching the app.
  Future<List<Map<String, dynamic>>> flush({
    Map<String, dynamic>? envelope,
    bool poll = false,
  }) async {
    if (_flushing) return const <Map<String, dynamic>>[];
    if (!poll && envelope == null && _queue.isEmpty) {
      return const <Map<String, dynamic>>[];
    }
    _flushing = true;
    try {
      final batch = _queue.take(batchSize).toList(growable: false);
      final headers = <String, String>{'content-type': 'application/json'};
      if (sessionToken != null) {
        headers['authorization'] = 'Bearer $sessionToken';
      }
      final body = <String, dynamic>{'sessionId': sessionId, 'events': batch};
      if (envelope case final presentEnvelope?) {
        body['envelope'] = presentEnvelope;
      }
      final response = await _client
          .post(Uri.parse(endpoint), headers: headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode >= 200 && response.statusCode < 300) {
        _queue.removeRange(0, batch.length);
        delivered += batch.length;
        lastError = null;
        final body = response.body.isEmpty ? null : jsonDecode(response.body);
        if (body is Map && body['commands'] is List) {
          return (body['commands'] as List)
              .whereType<Map>()
              .map((item) => item.cast<String, dynamic>())
              .toList(growable: false);
        }
        return const <Map<String, dynamic>>[];
      }
      lastError = 'Host rejected the batch with HTTP ${response.statusCode}.';
      return const <Map<String, dynamic>>[];
    } catch (error) {
      lastError = error.toString();
      debugPrint('SaySpec recorder: batch flush failed — $error');
      return const <Map<String, dynamic>>[];
    } finally {
      _flushing = false;
    }
  }

  void dispose() => _client.close();
}
