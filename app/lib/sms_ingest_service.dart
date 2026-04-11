import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'session_store.dart';
import 'sms_native_bridge.dart';

/// Banking SMS → native Android `SmsForegroundService` → `POST /sms-reader`.
/// Uses a foreground service + [SmsReceiver] so capture works when the app is killed.
class SmsIngestService {
  SmsIngestService._();

  static bool _initialized = false;

  static bool get isActive => _initialized;

  /// Idempotent: safe to call from [main], after login, and after permission grant.
  /// Always pushes latest backend URL + JWT to the native layer on Android.
  static Future<void> start() async {
    final smsStatus = await Permission.sms.status;
    if (!smsStatus.isGranted) return;

    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
      _initialized = true;
      debugPrint('[SmsIngest] non-Android: native SMS pipeline skipped');
      return;
    }

    await SessionStore.load();
    final prefs = await SharedPreferences.getInstance();
    final baseUrl = (prefs.getString('backend_url_local') ?? '').trim();

    await SmsNativeBridge.configure(
      backendBaseUrl: baseUrl,
      jwtToken: SessionStore.token,
    );
    await SmsNativeBridge.startForegroundListener();
    _initialized = true;
    debugPrint('[SmsIngest] native Android SMS pipeline active');
  }
}
