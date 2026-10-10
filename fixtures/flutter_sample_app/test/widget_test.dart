import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart';

/// Unit coverage for the fixture's own behavior, so the acceptance script can
/// trust that the known cart defect changes exactly one visible value.
void main() {
  testWidgets('catalog and receipt totals reflect the catalog prices', (tester) async {
    await tester.pumpWidget(const SampleApp());
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(AppKeys.signInEmail), 'fixture@sayspec.local');
    await tester.enterText(find.byKey(AppKeys.signInPassword), 'fixture-password');
    await tester.tap(find.byKey(AppKeys.signInSubmit));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addFirstItem));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addSecondItem));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.catalogTotal))).data, 'Items: 2 · Total: \$20.00');
    await tester.tap(find.byKey(AppKeys.openCart));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.cartPlaceOrder));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.receiptTotal))).data, 'Total paid \$20.00');
  });

  testWidgets('the known cart defect under-reports the total', (tester) async {
    await tester.pumpWidget(const SampleApp());
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(AppKeys.signInEmail), 'fixture@sayspec.local');
    await tester.enterText(find.byKey(AppKeys.signInPassword), 'fixture-password');
    await tester.tap(find.byKey(AppKeys.signInSubmit));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addFirstItem));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.openCart));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.cartTotal))).data, 'Total \$7.00');
  });
}
