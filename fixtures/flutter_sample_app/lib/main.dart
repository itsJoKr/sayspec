import 'package:flutter/material.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

import 'catalog.dart';

/// Recording surface the SDK screenshots. It sits above the navigator so one
/// boundary captures whichever route the app is showing.
final GlobalKey recordingSurfaceKey = GlobalKey();

final RouteObserver<PageRoute<dynamic>> recorderRouteObserver =
    RouteObserver<PageRoute<dynamic>>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SaySpecRecorder.instance.initializeFromEnvironment(
    appId: 'dev.sayspec.flutter_sample_app',
    screenshotBoundaryKey: recordingSurfaceKey,
  );
  runApp(const SampleApp());
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SaySpec sample',
      navigatorObservers: <NavigatorObserver>[
        recorderRouteObserver,
        SaySpecRecorder.instance,
      ],
      builder: (context, child) => RepaintBoundary(
        key: recordingSurfaceKey,
        child: child ?? const SizedBox.shrink(),
      ),
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF3B6E5A),
        useMaterial3: true,
      ),
      initialRoute: AppRoutes.signIn,
      routes: <String, WidgetBuilder>{
        AppRoutes.signIn: (_) => const SignInPage(),
        AppRoutes.catalog: (_) => const CatalogPage(),
        AppRoutes.cart: (_) => const CartPage(),
        AppRoutes.receipt: (_) => const ReceiptPage(),
      },
    );
  }
}

class SignInPage extends StatefulWidget {
  const SignInPage({super.key});
  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final TextEditingController email = TextEditingController();
  final TextEditingController password = TextEditingController();
  String? error;

  @override
  void dispose() {
    email.dispose();
    password.dispose();
    super.dispose();
  }

  void submit() {
    if (email.text.trim().isEmpty || password.text.isEmpty) {
      setState(() => error = 'Enter your email and password.');
      return;
    }
    setState(() => error = null);
    Navigator.of(context).pushReplacementNamed(AppRoutes.catalog);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            TextField(
              key: AppKeys.signInEmail,
              controller: email,
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: AppKeys.signInPassword,
              controller: password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              key: AppKeys.signInSubmit,
              onPressed: submit,
              child: const Text('Sign in'),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(error!, style: const TextStyle(color: Colors.red)),
              ),
          ],
        ),
      ),
    );
  }
}

class CatalogPage extends StatefulWidget {
  const CatalogPage({super.key});
  @override
  State<CatalogPage> createState() => _CatalogPageState();
}

class _CatalogPageState extends State<CatalogPage> {
  final List<CatalogItem> cart = <CatalogItem>[];

  int get total => cart.fold(0, (sum, item) => sum + item.priceCents);

  void add(CatalogItem item) {
    setState(() => cart.add(item));
    SaySpecRecorder.instance.mark('added ${item.id}');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Catalog'),
        actions: <Widget>[
          TextButton.icon(
            key: AppKeys.openCart,
            onPressed: () async {
              await Navigator.of(
                context,
              ).pushNamed(AppRoutes.cart, arguments: cart);
            },
            icon: const Icon(Icons.shopping_cart_outlined),
            label: const Text('Cart'),
          ),
        ],
      ),
      body: ListView(
        key: AppKeys.catalogList,
        children: <Widget>[
          for (final CatalogItem item in catalogItems)
            ListTile(
              key: ValueKey<String>('catalog_row_${item.id}'),
              title: Text(item.name),
              subtitle: Text(money(item.priceCents)),
              trailing: FilledButton(
                key: item.id == 'coffee'
                    ? AppKeys.addFirstItem
                    : AppKeys.addSecondItem,
                onPressed: () => add(item),
                child: const Text('Add'),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              'Items: ${cart.length} · Total: ${money(total)}',
              key: AppKeys.catalogTotal,
            ),
          ),
        ],
      ),
    );
  }
}

const int welcomeDiscountCents = 500;

class CartPage extends StatelessWidget {
  const CartPage({super.key});

  @override
  Widget build(BuildContext context) {
    final List<CatalogItem> cart =
        (ModalRoute.of(context)?.settings.arguments as List<CatalogItem>?) ??
        <CatalogItem>[];
    final int subtotal = cart.fold(0, (sum, item) => sum + item.priceCents);
    final int total = subtotal - welcomeDiscountCents;
    return Scaffold(
      appBar: AppBar(title: const Text('Cart')),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text('${cart.length} items', key: AppKeys.cartLineCount),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text('Total ${money(total)}', key: AppKeys.cartTotal),
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.all(24),
            child: FilledButton(
              key: AppKeys.cartPlaceOrder,
              onPressed: () => Navigator.of(
                context,
              ).pushNamed(AppRoutes.receipt, arguments: cart),
              child: const Text('Place order'),
            ),
          ),
        ],
      ),
    );
  }
}

class ReceiptPage extends StatelessWidget {
  const ReceiptPage({super.key});

  @override
  Widget build(BuildContext context) {
    final List<CatalogItem> cart =
        (ModalRoute.of(context)?.settings.arguments as List<CatalogItem>?) ??
        <CatalogItem>[];
    final int total = cart.fold(0, (sum, item) => sum + item.priceCents);
    return Scaffold(
      appBar: AppBar(title: const Text('Receipt')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Text(
              'Order confirmed',
              key: AppKeys.receiptHeading,
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            Text('Total paid ${money(total)}', key: AppKeys.receiptTotal),
          ],
        ),
      ),
    );
  }
}
