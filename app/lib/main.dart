import 'dart:convert';
import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_background_service_android/flutter_background_service_android.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_sms_inbox/flutter_sms_inbox.dart' hide SmsMessage;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:telephony/telephony.dart' as telephony;

import 'login_screen.dart';
import 'payment_screen.dart';
import 'read_sms_screen.dart';
import 'sms_telephony_bridge.dart';

const _bgChannelId = 'sms_sync_channel';
const _bgNotificationId = 9001;
const _bgSyncIntervalSeconds = 30;

String _normalizeBackendBaseUrl(String raw) {
  var url = raw.trim();
  if (url.isEmpty) return '';
  if (url.endsWith('/')) {
    url = url.substring(0, url.length - 1);
  }
  if (!url.contains('/api/v1')) {
    url = '$url/api/v1';
  }
  return url;
}

String _authBaseUrlFromEnv() =>
    _normalizeBackendBaseUrl(dotenv.env['BACKEND_URL'] ?? '');

String _smsReaderBaseUrlFromEnv() =>
    _normalizeBackendBaseUrl(dotenv.env['Backend_URL_LOCAL'] ?? '');

@pragma('vm:entry-point')
Future<void> onBackgroundServiceStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();
  debugPrint(
    '[BG] Service started. Sync interval=${_bgSyncIntervalSeconds}s',
  );
  service.on("stopService").listen((event) {
    debugPrint('[BG] stopService received. Stopping background service');
    service.stopSelf();
  });

  if (service is AndroidServiceInstance) {
    service.setAsForegroundService();
    service.setForegroundNotificationInfo(
      title: "SMS Sync Active",
      content: "Syncing banking SMS every 30 seconds",
    );
  }

  Timer.periodic(
    const Duration(seconds: _bgSyncIntervalSeconds),
    (timer) async {
      debugPrint('[BG] Heartbeat tick #${timer.tick}');
    if (service is AndroidServiceInstance) {
      final isForeground = await service.isForegroundService();
      if (!isForeground) {
        debugPrint('[BG] Promoting service back to foreground mode');
        service.setAsForegroundService();
      }
    }
    debugPrint('[BG] Running background SMS sync');
    await runBackgroundSmsSync();
    debugPrint('[BG] Background SMS sync completed');
  },
  );
}

Future<void> configureBackgroundService() async {
  final notifications = FlutterLocalNotificationsPlugin();
  const channel = AndroidNotificationChannel(
    _bgChannelId,
    'SMS Background Sync',
    description: 'Runs SMS sync every 30 seconds',
    importance: Importance.low,
  );
  await notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >()
      ?.createNotificationChannel(channel);

  final service = FlutterBackgroundService();
  await service.configure(
    androidConfiguration: AndroidConfiguration(
      onStart: onBackgroundServiceStart,
      autoStart: true,
      isForegroundMode: true,
      autoStartOnBoot: true,
      notificationChannelId: _bgChannelId,
      initialNotificationTitle: "SMS Sync Active",
      initialNotificationContent: "Preparing background sync",
      foregroundServiceNotificationId: _bgNotificationId,
    ),
    iosConfiguration: IosConfiguration(),
  );
  // Ensure service is running even if autoStart timing is delayed.
  final isRunning = await service.isRunning();
  if (!isRunning) {
    await service.startService();
  }
}

Future<void> stopBackgroundServiceIfRunning() async {
  final service = FlutterBackgroundService();
  service.invoke("stopService");
}

bool _isLikelyBankingSmsGlobal(String text, String sender) {
  final value = '$sender $text'.toLowerCase();
  const keywords = [
    'debited',
    'credited',
    'txn',
    'transaction',
    'upi',
    'a/c',
    'account',
    'utr',
    'imps',
    'neft',
    'rtgs',
    'bank',
  ];
  return keywords.any(value.contains);
}

String _extractTransactionTypeGlobal(String body) {
  final text = body.toLowerCase();
  if (text.contains('debited') ||
      text.contains('withdrawn') ||
      text.contains('dr')) {
    return 'debit';
  }
  return 'credit';
}

double? _extractAmountGlobal(String body) {
  final amountRegexWithCurrency = RegExp(
    r'(?:inr|rs\.?|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)',
    caseSensitive: false,
  );
  final currencyMatch = amountRegexWithCurrency.firstMatch(body);
  if (currencyMatch != null) {
    final normalized = (currencyMatch.group(1) ?? '').replaceAll(',', '');
    return double.tryParse(normalized);
  }

  final plainAmountRegex = RegExp(
    r'([0-9]{2,}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)',
  );
  final plainMatch = plainAmountRegex.firstMatch(body);
  if (plainMatch == null) return null;
  final normalized = (plainMatch.group(1) ?? '').replaceAll(',', '');
  return double.tryParse(normalized);
}

String _extractLastFourDigitsGlobal(String body) {
  final accountRegex = RegExp(
    r'(?:a/c|ac|acct|account)[^0-9]{0,10}(?:x+|\*+)?\s*([0-9]{4})',
    caseSensitive: false,
  );
  final match = accountRegex.firstMatch(body);
  if (match != null) return match.group(1)!;
  final anyFour = RegExp(r'([0-9]{4})(?!.*[0-9]{4})').firstMatch(body);
  return anyFour?.group(1) ?? '0000';
}

String _extractUtrGlobal(String body) {
  final utrRegex = RegExp(
    r'(?:utr|ref(?:erence)?(?:\s*no)?|transaction\s*id|txn\s*id)[\s:.-]*([A-Za-z0-9]{8,})',
    caseSensitive: false,
  );
  final match = utrRegex.firstMatch(body);
  if (match != null) {
    final raw = match.group(1)!.trim();
    final digitsOnly = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (digitsOnly.length == 12) return digitsOnly;
  }
  return 'NA';
}

String _extractTransactionIdGlobal(String body) {
  final idRegex = RegExp(
    r'(?:transaction\s*id|txn\s*id|txnid|rrn)[\s:.-]*([A-Za-z0-9\-]{6,})',
    caseSensitive: false,
  );
  return idRegex.firstMatch(body)?.group(1)?.toUpperCase() ?? 'NA';
}

Future<void> runBackgroundSmsSync() async {
  final permission = await Permission.sms.status;
  if (!permission.isGranted) {
    print('[BG] SMS permission missing; skipping background sync');
    return;
  }

  final prefs = await SharedPreferences.getInstance();
  // Background isolate should not read dotenv directly.
  final baseUrl = (prefs.getString('backend_url_local') ?? '').trim();
  if (baseUrl.isEmpty) {
    print('[BG] Backend base URL missing; skipping background sync');
    return;
  }
  final authToken = prefs.getString('auth_token') ?? '';

  final seen = prefs.getStringList('bg_seen_sms_keys') ?? <String>[];
  final seenSet = seen.toSet();
  var hasNewSavedSms = false;
  var totalScanned = 0;
  var bankingCandidates = 0;
  var validUtrCount = 0;
  var duplicateCount = 0;
  var newDetectedCount = 0;
  var savedCount = 0;

  final query = SmsQuery();
  final messages = await query.querySms(
    kinds: [SmsQueryKind.inbox],
    count: 200,
  );

  for (final sms in messages) {
    totalScanned += 1;
    final body = sms.body ?? '';
    final sender = sms.address ?? 'UNKNOWN';
    final preview = body.replaceAll('\n', ' ').trim();
    print(
      '[BG] SMS read: sender=$sender bodyPreview=${preview.length > 80 ? "${preview.substring(0, 80)}..." : preview}',
    );
    if (body.isEmpty || !_isLikelyBankingSmsGlobal(body, sender)) continue;
    bankingCandidates += 1;

    final amount = _extractAmountGlobal(body) ?? 0;
    final smsDate = sms.date ?? DateTime.now();
    final utr = _extractUtrGlobal(body);
    if (utr == 'NA') continue;
    validUtrCount += 1;
    final payload = <String, dynamic>{
      'transactionType': _extractTransactionTypeGlobal(body).toLowerCase(),
      'amount': amount.toDouble(),
      'bankAccountLastFourDigits': _extractLastFourDigitsGlobal(body),
      'transactionId': _extractTransactionIdGlobal(body),
      'utrNo': utr,
      'date':
          '${smsDate.year}-${smsDate.month.toString().padLeft(2, '0')}-${smsDate.day.toString().padLeft(2, '0')}',
      'time':
          '${smsDate.hour.toString().padLeft(2, '0')}:${smsDate.minute.toString().padLeft(2, '0')}:${smsDate.second.toString().padLeft(2, '0')}',
      'senderID': sender.trim(),
    };

    final hasAllRequired =
        payload['utrNo'] != null &&
        (payload['utrNo'] as String).isNotEmpty &&
        payload['utrNo'] != 'NA' &&
        payload['transactionType'] != null &&
        (payload['transactionType'] as String).isNotEmpty &&
        payload['bankAccountLastFourDigits'] != null &&
        (payload['bankAccountLastFourDigits'] as String).isNotEmpty &&
        payload['date'] != null &&
        (payload['date'] as String).isNotEmpty &&
        payload['time'] != null &&
        (payload['time'] as String).isNotEmpty &&
        payload['senderID'] != null &&
        (payload['senderID'] as String).isNotEmpty;
    if (!hasAllRequired) {
      debugPrint('SMS Sync skipped (missing required fields): $payload');
      continue;
    }

    final smsKey =
        '${payload["senderID"]}|${payload["utrNo"]}|${payload["date"]}|${payload["time"]}|${payload["amount"]}|${payload["transactionType"]}';
    if (seenSet.contains(smsKey)) {
      duplicateCount += 1;
      continue;
    }
    newDetectedCount += 1;
    print(
      '[BG] New SMS detected: sender=${payload["senderID"]} utr=${payload["utrNo"]} amount=${payload["amount"]}',
    );

    final response = await http.post(
      Uri.parse('$baseUrl/sms-reader'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(payload),
    );
    debugPrint('SMS Sync POST $baseUrl/sms-reader payload=$payload');
    debugPrint(
      'SMS Sync response code=${response.statusCode} body=${response.body}',
    );

    if ((response.statusCode >= 200 && response.statusCode < 300) ||
        response.statusCode == 409) {
      seenSet.add(smsKey);
      hasNewSavedSms = true;
      savedCount += 1;
    }
  }

  await prefs.setStringList('bg_seen_sms_keys', seenSet.take(3000).toList());
  print(
    '[BG] Sync summary: scanned=$totalScanned bankingCandidates=$bankingCandidates '
    'validUtr=$validUtrCount newDetected=$newDetectedCount duplicates=$duplicateCount '
    'saved=$savedCount',
  );

  if (hasNewSavedSms) {
    if (authToken.isEmpty) {
      print(
        '[BG] New SMS saved, but auth token missing. Skipping extraction trigger',
      );
      return;
    }
    try {
      final extractionResponse = await http.post(
        Uri.parse('$baseUrl/extract/bulk'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'jwtToken': authToken}),
      );
      print(
        '[BG] Triggered extraction from background. '
        'status=${extractionResponse.statusCode} body=${extractionResponse.body}',
      );
    } catch (e) {
      print('[BG] Failed to trigger extraction from background: $e');
    }
  } else {
    print('[BG] No new banking SMS found in this sync tick');
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await dotenv.load(fileName: '.env');
  } catch (_) {
    // Keep app booting even when env file is missing/misconfigured.
  }
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(
    'backend_url_auth',
    _authBaseUrlFromEnv(),
  );
  await prefs.setString(
    'backend_url_local',
    _smsReaderBaseUrlFromEnv(),
  );
  // Enable background SMS sync service so inbox is processed without opening UI.
  await configureBackgroundService();
  await SessionStore.load();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Admin Login',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
      ),
      home: LoginScreen(
        dashboardBuilder: ({
          required String username,
          required String userId,
          required String role,
          required String token,
        }) => DashboardScreen(
          username: username,
          userId: userId,
          role: role,
          token: token,
        ),
      ),
    );
  }
}

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.username,
    required this.userId,
    required this.role,
    required this.token,
  });

  final String username;
  final String userId;
  final String role;
  final String token;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  bool _isSmsListenerStarted = false;
  final Set<String> _seenSmsKeys = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _askSmsPermission());
  }

  Future<void> _startContinuousSmsListener() async {
    if (_isSmsListenerStarted) return;
    final smsStatus = await Permission.sms.status;
    if (!smsStatus.isGranted) {
      debugPrint('Dashboard telephony: listener not started (SMS permission denied)');
      return;
    }

    SmsTelephonyBridge.pushHandler(_processIncomingBankingSms);
    await SmsTelephonyBridge.ensureStarted();
    debugPrint('Dashboard telephony: listener started');

    _isSmsListenerStarted = true;
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Continuous banking SMS listener started')),
    );
  }

  Future<void> _processIncomingBankingSms(telephony.SmsMessage sms) async {
    final body = sms.body ?? '';
    final sender = sms.address ?? 'UNKNOWN';
    if (body.isEmpty || !_isLikelyBankingSms(body, sender)) {
      debugPrint('Dashboard telephony: skipped non-banking/empty SMS');
      return;
    }

    final baseUrl = _smsReaderBaseUrlFromEnv();
    if (baseUrl.isEmpty) {
      debugPrint('Dashboard telephony: skipped (base URL missing)');
      return;
    }

    final amount = _extractAmount(body);
    final messageDate = sms.date != null
        ? DateTime.fromMillisecondsSinceEpoch(sms.date!)
        : DateTime.now();
    final utr = _extractUtr(body);
    if (utr == 'NA') {
      debugPrint('Dashboard telephony: skipped (valid 12-digit UTR not found)');
      return;
    }

    final payload = <String, dynamic>{
      'transactionType': _extractTransactionType(body).toLowerCase(),
      'amount': (amount ?? 0).toDouble(),
      'bankAccountLastFourDigits': _extractLastFourDigits(body),
      'transactionId': _extractTransactionId(body),
      'utrNo': utr,
      'date':
          '${messageDate.year}-${messageDate.month.toString().padLeft(2, '0')}-${messageDate.day.toString().padLeft(2, '0')}',
      'time':
          '${messageDate.hour.toString().padLeft(2, '0')}:${messageDate.minute.toString().padLeft(2, '0')}:${messageDate.second.toString().padLeft(2, '0')}',
      'senderID': sender.trim(),
    };

    final smsKey =
        '${payload["senderID"]}|${payload["utrNo"]}|${payload["date"]}|${payload["time"]}|${payload["amount"]}|${payload["transactionType"]}';
    if (_seenSmsKeys.contains(smsKey)) {
      debugPrint('Dashboard telephony: skipped duplicate SMS key');
      return;
    }

    try {
      final response = await http.post(
        Uri.parse('$baseUrl/sms-reader'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(payload),
      );
      debugPrint(
        'Dashboard telephony: /sms-reader status=${response.statusCode} body=${response.body}',
      );

      if ((response.statusCode >= 200 && response.statusCode < 300) ||
          response.statusCode == 409) {
        _seenSmsKeys.add(smsKey);
        debugPrint('Dashboard telephony: SMS saved, triggering extraction pipeline');
        await _triggerPaymentsAndExtraction();
      } else {
        debugPrint('Dashboard telephony: SMS save failed, extraction not triggered');
      }
    } catch (e) {
      debugPrint('Dashboard telephony: /sms-reader call error: $e');
      // Keep listener alive even if one network call fails.
    }
  }

  Future<void> _triggerPaymentsAndExtraction() async {
    final baseUrl = _smsReaderBaseUrlFromEnv();
    if (baseUrl.isEmpty) {
      debugPrint('Dashboard telephony: extraction trigger skipped (base URL missing)');
      return;
    }

    final token = widget.token.isNotEmpty ? widget.token : SessionStore.token;
    if (token.isEmpty) {
      debugPrint('Dashboard telephony: extraction trigger skipped (token missing)');
      return;
    }

    try {
      final response = await http.post(
        Uri.parse('$baseUrl/extract/bulk'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'jwtToken': token}),
      );
      debugPrint(
        'Triggered payments->extraction pipeline status=${response.statusCode} body=${response.body}',
      );
    } catch (e) {
      debugPrint('Failed to trigger payments->extraction pipeline: $e');
    }
  }

  Future<void> _askSmsPermission() async {
    await Permission.notification.request();

    final currentStatus = await Permission.sms.status;

    // If already granted, do not prompt again. Android keeps it until user revokes.
    if (currentStatus.isGranted) {
      await _startContinuousSmsListener();
      return;
    }

    if (currentStatus.isPermanentlyDenied) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'SMS permission is disabled. Enable it from app settings.',
          ),
        ),
      );
      await openAppSettings();
      return;
    }

    final proceed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('SMS Permission'),
        content: const Text(
          'This app needs permission to read SMS messages from your device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Not now'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Allow'),
          ),
        ],
      ),
    );

    if (proceed != true) return;

    final status = await Permission.sms.request();
    if (!mounted) return;

    if (status.isGranted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('SMS permission granted')));
      await _startContinuousSmsListener();
      return;
    }

    if (status.isPermanentlyDenied) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Enable SMS permission from app settings'),
        ),
      );
      await openAppSettings();
      return;
    }

    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('SMS permission denied')));
  }

  bool _isLikelyBankingSms(String text, String sender) {
    final value = '$sender $text'.toLowerCase();
    const keywords = [
      'debited',
      'credited',
      'txn',
      'transaction',
      'upi',
      'a/c',
      'account',
      'utr',
      'imps',
      'neft',
      'rtgs',
      'bank',
    ];
    return keywords.any(value.contains);
  }

  String _extractTransactionType(String body) {
    final text = body.toLowerCase();
    if (text.contains('debited') ||
        text.contains('withdrawn') ||
        text.contains('dr')) {
      return 'debit';
    }
    return 'credit';
  }

  double? _extractAmount(String body) {
    final amountRegexWithCurrency = RegExp(
      r'(?:inr|rs\.?|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)',
      caseSensitive: false,
    );
    final currencyMatch = amountRegexWithCurrency.firstMatch(body);
    if (currencyMatch != null) {
      final normalized = (currencyMatch.group(1) ?? '').replaceAll(',', '');
      return double.tryParse(normalized);
    }

    // Fallback for SMS formats that omit INR/RS prefix.
    final plainAmountRegex = RegExp(
      r'([0-9]{2,}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)',
    );
    final plainMatch = plainAmountRegex.firstMatch(body);
    if (plainMatch == null) return null;
    final normalized = (plainMatch.group(1) ?? '').replaceAll(',', '');
    return double.tryParse(normalized);
  }

  String _extractLastFourDigits(String body) {
    final accountRegex = RegExp(
      r'(?:a/c|ac|acct|account)[^0-9]{0,10}(?:x+|\*+)?\s*([0-9]{4})',
      caseSensitive: false,
    );
    final match = accountRegex.firstMatch(body);
    if (match != null) return match.group(1)!;

    final anyFour = RegExp(r'([0-9]{4})(?!.*[0-9]{4})').firstMatch(body);
    return anyFour?.group(1) ?? '0000';
  }

  String _extractUtr(String body) {
    final utrRegex = RegExp(
      r'(?:utr|ref(?:erence)?(?:\s*no)?|transaction\s*id|txn\s*id)[\s:.-]*([A-Za-z0-9]{8,})',
      caseSensitive: false,
    );
    final match = utrRegex.firstMatch(body);
    if (match != null) {
      final raw = match.group(1)!.trim();
      final digitsOnly = raw.replaceAll(RegExp(r'[^0-9]'), '');
      if (digitsOnly.length == 12) return digitsOnly;
    }
    return 'NA';
  }

  String _extractTransactionId(String body) {
    final idRegex = RegExp(
      r'(?:transaction\s*id|txn\s*id|txnid|rrn)[\s:.-]*([A-Za-z0-9\-]{6,})',
      caseSensitive: false,
    );
    return idRegex.firstMatch(body)?.group(1)?.toUpperCase() ?? 'NA';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Dashboard'), centerTitle: true),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Welcome, ${widget.username}',
              style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 6),
            Text('ID: ${widget.userId.isEmpty ? '-' : widget.userId}'),
            Text('Role: ${widget.role.isEmpty ? '-' : widget.role}'),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const ReadSmsScreen()),
                );
              },
              child: const Text('Read SMS'),
            ),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => PaymentScreen(token: widget.token),
                  ),
                );
              },
              child: const Text('Payments'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

