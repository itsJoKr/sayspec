import 'package:flutter/material.dart';
import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';

final GlobalKey recordingSurfaceKey = GlobalKey();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SaySpecRecorder.instance.initializeFromEnvironment(
    appId: 'dev.sayspec.recorder_example',
    screenshotBoundaryKey: recordingSurfaceKey,
  );
  runApp(const RecorderExample());
}

class RecorderExample extends StatelessWidget {
  const RecorderExample({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorObservers: <NavigatorObserver>[SaySpecRecorder.instance],
      builder: (BuildContext context, Widget? child) => RepaintBoundary(
        key: recordingSurfaceKey,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const _CounterPage(),
    );
  }
}

class _CounterPage extends StatefulWidget {
  const _CounterPage();

  @override
  State<_CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<_CounterPage> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Recorder example')),
      body: Center(
        child: Text(
          'Count: $count',
          key: const ValueKey<String>('counter_value'),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        key: const ValueKey<String>('counter_increment'),
        onPressed: () {
          setState(() => count += 1);
          SaySpecRecorder.instance.mark('counter incremented');
        },
        tooltip: 'Increment',
        child: const Icon(Icons.add),
      ),
    );
  }
}
