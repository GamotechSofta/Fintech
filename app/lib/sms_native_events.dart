import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

bool _nativeSmsHandlerRegistered = false;

/// Handles [MethodChannel.invokeMethod] from Android so SMS lines show in `flutter run`.
///
/// Native `Log.*` only appears in logcat, not the IDE terminal. This path uses the
/// cached [FlutterEngine] + `com.example.app/sms_push` channel.
void listenNativeSmsInFlutterConsole() {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
  if (_nativeSmsHandlerRegistered) return;
  _nativeSmsHandlerRegistered = true;

  const channel = MethodChannel('com.example.app/sms_push');
  // ignore: avoid_print
  print('[NativeSMS] MethodChannel handler registered — incoming SMS will print below');
  channel.setMethodCallHandler((call) async {
    if (call.method != 'sms') return null;
    final raw = call.arguments;
    if (raw is! Map) return null;
    final stage = raw['stage']?.toString() ?? '';
    final sender = raw['sender']?.toString() ?? '';
    final body = raw['body']?.toString() ?? '';
    // `print` is not throttled like `debugPrint`; shows in `flutter run` output.
    // ignore: avoid_print
    print('[NativeSMS][$stage] sender=$sender len=${body.length}');
    // ignore: avoid_print
    print('[NativeSMS] $body');
    return null;
  });
}
