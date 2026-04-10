import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:permission_handler/permission_handler.dart';
import 'package:telephony/telephony.dart' as telephony;

typedef BankingSmsHandler = Future<void> Function(telephony.SmsMessage sms);

/// Single [Telephony.listenIncomingSms] registration; routes to the topmost
/// pushed handler so [ReadSmsScreen] can override the dashboard without losing
/// the dashboard callback when the route is popped.
class SmsTelephonyBridge {
  SmsTelephonyBridge._();

  static final List<BankingSmsHandler> _stack = <BankingSmsHandler>[];
  static bool _started = false;

  static bool get _isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static Future<void> _dispatch(telephony.SmsMessage m) async {
    if (_stack.isEmpty) return;
    await _stack.last(m);
  }

  /// Registers the listener once (Android + SMS permission).
  static Future<void> ensureStarted() async {
    if (!_isAndroid) return;
    if (_started) return;
    final smsStatus = await Permission.sms.status;
    if (!smsStatus.isGranted) return;

    telephony.Telephony.instance.listenIncomingSms(
      onNewMessage: _dispatch,
      listenInBackground: false,
    );
    _started = true;
  }

  static void pushHandler(BankingSmsHandler handler) {
    _stack.add(handler);
  }

  static void popHandler() {
    if (_stack.isNotEmpty) _stack.removeLast();
  }
}
