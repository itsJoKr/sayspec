import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:flutter/material.dart';

import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;

/// Proves a real assertion derived from recorded widget identity:
/// every finder below uses the key the recorder captured for that element.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('recorded cart flow reaches a confirmed order total', (WidgetTester tester) async {
    await tester.pumpWidget(const app.SampleApp());
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(AppKeys.signInEmail), 'fixture@sayspec.local');
    await tester.enterText(find.byKey(AppKeys.signInPassword), 'fixture-password');
    await tester.tap(find.byKey(AppKeys.signInSubmit));
    await tester.pumpAndSettle();

    expect(find.byKey(AppKeys.catalogList), findsOneWidget);
    await tester.tap(find.byKey(AppKeys.addFirstItem));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addSecondItem));
    await tester.pumpAndSettle();
    expect(find.byKey(AppKeys.catalogTotal), findsOneWidget);

    await tester.tap(find.byKey(AppKeys.openCart));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.cartLineCount))).data, '2 items');

    await tester.tap(find.byKey(AppKeys.cartPlaceOrder));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.receiptHeading))).data, 'Order confirmed');
    expect((tester.widget<Text>(find.byKey(AppKeys.receiptTotal))).data, 'Total paid \$20.00');
  });

  testWidgets('known cart total defect fails the recorded assertion', (WidgetTester tester) async {
    await tester.pumpWidget(const app.SampleApp());
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(AppKeys.signInEmail), 'fixture@sayspec.local');
    await tester.enterText(find.byKey(AppKeys.signInPassword), 'fixture-password');
    await tester.tap(find.byKey(AppKeys.signInSubmit));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addFirstItem));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.addSecondItem));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(AppKeys.openCart));
    await tester.pumpAndSettle();
    expect((tester.widget<Text>(find.byKey(AppKeys.cartTotal))).data, isNot('Total \$20.00'));
    expect(find.text('Coffee beans'), findsNothing);
  });
}
