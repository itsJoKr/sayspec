import 'package:flutter/material.dart';

/// Root navigation keys the wrapper app registers so recorded evidence can
/// name the flow that produced each event.
class AppRoutes {
  static const String signIn = '/';
  static const String catalog = '/catalog';
  static const String cart = '/cart';
  static const String receipt = '/receipt';
}

/// Widget keys are the most durable recorded identity, so the fixture names
/// every interactive element the same way a real instrumented app should.
class AppKeys {
  static const Key signInEmail = ValueKey<String>('sign_in_email');
  static const Key signInPassword = ValueKey<String>('sign_in_password');
  static const Key signInSubmit = ValueKey<String>('sign_in_submit');
  static const Key catalogList = ValueKey<String>('catalog_list');
  static const Key catalogTotal = ValueKey<String>('catalog_total');
  static const Key addFirstItem = ValueKey<String>('add_item_coffee');
  static const Key addSecondItem = ValueKey<String>('add_item_tea');
  static const Key openCart = ValueKey<String>('open_cart');
  static const Key cartLineCount = ValueKey<String>('cart_line_count');
  static const Key cartTotal = ValueKey<String>('cart_total');
  static const Key cartPlaceOrder = ValueKey<String>('cart_place_order');
  static const Key receiptHeading = ValueKey<String>('receipt_heading');
  static const Key receiptTotal = ValueKey<String>('receipt_total');
}

class CatalogItem {
  const CatalogItem({required this.id, required this.name, required this.priceCents});
  final String id;
  final String name;
  final int priceCents;
}

const List<CatalogItem> catalogItems = <CatalogItem>[
  CatalogItem(id: 'coffee', name: 'Coffee beans', priceCents: 1200),
  CatalogItem(id: 'tea', name: 'Green tea', priceCents: 800),
];

String money(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';
