import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';

import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;

/// Derived from the F05 recording, not hand-written.
///
/// The recorder observed the tap on the Email field first, so this test asserts
/// the widget key it captured for that event. The finders are exactly the
/// suggestions `deriveAssertions` produced for the F05 capture (route `/`,
/// first action event, confidence high).
void main() {
  patrolTest('recorded sign-in email key is present', ($) async {
    await $.pumpWidgetAndSettle(const app.SampleApp());
    expect(find.byKey(AppKeys.signInEmail), findsOneWidget);
    await $(AppKeys.signInEmail).enterText('fixture@sayspec.local');
    expect(find.byKey(AppKeys.signInPassword), findsOneWidget);
  });
}
