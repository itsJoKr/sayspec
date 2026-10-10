// SAYSPEC_GENERATED
// Recording 1 (flutter_capture_b5a5378d-658d-4d1f-b416-98239edb5059)
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';

import 'package:flutter_sample_app/main.dart' as app;

void main() {
  patrolTest(
    'sign in shows validation error when empty, then signs in with email and password',
    ($) async {
      app.main();
      await $.pumpAndSettle();

      final email = $(find.byKey(const ValueKey<String>('sign_in_email')));
      final password = $(find.byKey(const ValueKey<String>('sign_in_password')));
      final submit = $(find.byKey(const ValueKey<String>('sign_in_submit')));
      const validationError = 'Enter your email and password.';

      // Tap 'Sign in' without email/password -> validation error is shown.
      await submit.waitUntilVisible();
      await submit.tap();
      await $.pumpAndSettle();
      expect($(validationError), findsOneWidget);

      // Enter email and password and sign in -> login works.
      await email.enterText('joe@joe.com');
      await password.enterText('test');
      await submit.tap();
      await $.pumpAndSettle();

      // Login succeeded: the sign-in form is gone and no validation error remains.
      expect(submit, findsNothing);
      expect(email, findsNothing);
      expect($(validationError), findsNothing);
    },
  );
}
