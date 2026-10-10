# SaySpec Flutter sample app

This is SaySpec's local Flutter fixture. It is intentionally small but behaves
like a real mobile product: sign in, add catalog items, review a cart, and place
an order. Stable widget keys make recordings and generated Patrol finders
repeatable.

Use this folder as the source directory when creating a Flutter project in
SaySpec. It contains:

- a Flutter 3.38.5 pin in `.fvmrc`;
- the local `sayspec_flutter_recorder` package integration;
- Android and iOS runner projects;
- a Patrol fixture under `patrol_test/`;
- widget and integration tests covering the correct catalog/receipt totals
  and the known cart defect.

The recorder is inactive during ordinary launches. SaySpec supplies its
private launch values when a recording starts, and the SDK reads them
internally through `initializeFromEnvironment`.

## Known sample defect

The cart page always shows **$5.00 less** than the sum of the items in the
cart. No flag or launch option is involved: the bug is in the source, so a
plain `flutter run` reproduces it.

Add Coffee beans ($12.00), open the cart, and compare the displayed total
($7.00) with the item price. The catalog footer and the receipt both show the
correct $12.00. The fault is in `lib/main.dart`, where `CartPage` subtracts
`welcomeDiscountCents` from the subtotal. Fixing it means removing that
subtraction. After the fix, update the "known cart defect" tests in
`test/widget_test.dart` and `integration_test/cart_flow_test.dart`, because
they pin the buggy value.

```sh
flutter analyze
flutter test
```

Do not add customer data, credentials, or production tenant assumptions to
this fixture.
