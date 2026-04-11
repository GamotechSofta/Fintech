import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:flutter/services.dart';

/// Android native SMS pipeline: [BroadcastReceiver] + foreground service + HTTP.
class SmsNativeBridge {
  SmsNativeBridge._();

  static const MethodChannel _channel = MethodChannel('com.example.app/sms_native');

  static bool get isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static Future<void> configure({
    required String backendBaseUrl,
    required String jwtToken,
  }) async {
    if (!isAndroid) return;
    await _channel.invokeMethod<void>('configure', <String, dynamic>{
      'backendBaseUrl': backendBaseUrl,
      'jwtToken': jwtToken,
    });
  }

  static Future<void> startForegroundListener() async {
    if (!isAndroid) return;
    await _channel.invokeMethod<void>('startForegroundListener');
  }
}
