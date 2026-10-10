import 'package:flutter/material.dart';
import 'package:patrol/patrol.dart';

void main() {
  patrolTest('recorded sign-in key exists', ($) async {
    await $(#sign_in_submit).tap();
    expect(find.byKey(const ValueKey<String>('sign_in_email')), findsOneWidget);
  });
}
