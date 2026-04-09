import 'dart:convert';
import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_background_service_android/flutter_background_service_android.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_sms_inbox/flutter_sms_inbox.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'login_screen.dart';
import 'read_sms_screen.dart';

const _bgChannelId = 'sms_sync_channel';
const _bgNotificationId = 9001;

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
  service.on("stopService").listen((event) {
    service.stopSelf();
  });

  if (service is AndroidServiceInstance) {
    service.setAsForegroundService();
    service.setForegroundNotificationInfo(
      title: "SMS Sync Active",
      content: "Syncing banking SMS every 30 seconds",
    );
  }

  Timer.periodic(const Duration(seconds: 30), (timer) async {
    if (service is AndroidServiceInstance) {
      final isForeground = await service.isForegroundService();
      if (!isForeground) {
        service.setAsForegroundService();
      }
    }
    await runBackgroundSmsSync();
  });
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
  if (!permission.isGranted) return;

  final prefs = await SharedPreferences.getInstance();
  final baseUrl = _smsReaderBaseUrlFromEnv();
  if (baseUrl.isEmpty) return;

  final seen = prefs.getStringList('bg_seen_sms_keys') ?? <String>[];
  final seenSet = seen.toSet();

  final query = SmsQuery();
  final messages = await query.querySms(
    kinds: [SmsQueryKind.inbox],
    count: 200,
  );

  for (final sms in messages) {
    final body = sms.body ?? '';
    final sender = sms.address ?? 'UNKNOWN';
    if (body.isEmpty || !_isLikelyBankingSmsGlobal(body, sender)) continue;

    final amount = _extractAmountGlobal(body) ?? 0;
    final smsDate = sms.date ?? DateTime.now();
    final utr = _extractUtrGlobal(body);
    if (utr == 'NA') continue;
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
    if (seenSet.contains(smsKey)) continue;

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
    }
  }

  await prefs.setStringList('bg_seen_sms_keys', seenSet.take(3000).toList());
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
  // Background execution disabled by request.
  await stopBackgroundServiceIfRunning();
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
        }) => DashboardScreen(username: username, userId: userId, role: role),
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
  });

  final String username;
  final String userId;
  final String role;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final SmsQuery _smsQuery = SmsQuery();
  bool _isSyncingSms = false;
  int _syncedCount = 0;
  final Set<String> _seenSmsKeys = {};
  Timer? _autoSyncTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _askSmsPermission());
  }

  @override
  void dispose() {
    _autoSyncTimer?.cancel();
    super.dispose();
  }

  void _startAutoSync() {
    _autoSyncTimer?.cancel();
    _autoSyncTimer = Timer.periodic(const Duration(seconds: 30), (_) async {
      final status = await Permission.sms.status;
      if (!mounted || !status.isGranted) return;
      await _syncBankingSmsToBackend(showSummary: false);
    });
  }

  Future<void> _askSmsPermission() async {
    await Permission.notification.request();

    final currentStatus = await Permission.sms.status;

    // If already granted, do not prompt again. Android keeps it until user revokes.
    if (currentStatus.isGranted) {
      await _syncBankingSmsToBackend();
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
      await _syncBankingSmsToBackend();
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

  Future<void> _syncBankingSmsToBackend({bool showSummary = true}) async {
    if (_isSyncingSms) return;

    final baseUrl = _smsReaderBaseUrlFromEnv();
    if (baseUrl.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Backend_URL_LOCAL is missing in app/.env'),
        ),
      );
      return;
    }

    setState(() => _isSyncingSms = true);
    var newAddedCount = 0;
    var failedCount = 0;
    var bankingCandidateCount = 0;

    try {
      final messages = await _smsQuery.querySms(
        kinds: [SmsQueryKind.inbox],
        count: 200,
      );

      for (final sms in messages) {
        final body = sms.body ?? '';
        final sender = sms.address ?? 'UNKNOWN';
        if (body.isEmpty || !_isLikelyBankingSms(body, sender)) continue;
        bankingCandidateCount++;

        final amount = _extractAmount(body);

        final smsDate = sms.date ?? DateTime.now();
        final utr = _extractUtr(body);
        if (utr == 'NA') continue;
        final payload = <String, dynamic>{
          'transactionType': _extractTransactionType(body).toLowerCase(),
          'amount': (amount ?? 0).toDouble(),
          'bankAccountLastFourDigits': _extractLastFourDigits(body),
          'transactionId': _extractTransactionId(body),
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
          failedCount++;
          debugPrint('SMS Sync skipped (missing required fields): $payload');
          continue;
        }

        final smsKey =
            '${payload["senderID"]}|${payload["utrNo"]}|${payload["date"]}|${payload["time"]}|${payload["amount"]}|${payload["transactionType"]}';
        if (_seenSmsKeys.contains(smsKey)) {
          continue;
        }

        final response = await http.post(
          Uri.parse('$baseUrl/sms-reader'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode(payload),
        );
        debugPrint('SMS Sync POST $baseUrl/sms-reader payload=$payload');

        dynamic responseBody;
        try {
          responseBody = response.body.isNotEmpty
              ? jsonDecode(response.body)
              : null;
        } catch (_) {
          responseBody = null;
        }
        debugPrint(
          'SMS Sync response code=${response.statusCode} body=${response.body}',
        );

        final backendSuccess =
            responseBody is Map<String, dynamic> &&
            responseBody['success'] == true;
        final treatedAsSynced =
            (response.statusCode >= 200 && response.statusCode < 300) ||
            response.statusCode == 409 ||
            backendSuccess;

        if (treatedAsSynced) {
          // Mark as synced only after backend accepted/persisted it.
          newAddedCount++;
          _syncedCount++;
          _seenSmsKeys.add(smsKey);
        } else {
          failedCount++;
        }
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Failed to read/sync SMS')));
    } finally {
      if (mounted) {
        setState(() {
          _isSyncingSms = false;
        });
        if (showSummary) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Scanned: $bankingCandidateCount | New: $newAddedCount | Total Synced: $_syncedCount | Failed: $failedCount',
              ),
            ),
          );
        }
      }
    }
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
              onPressed: _isSyncingSms ? null : _syncBankingSmsToBackend,
              child: _isSyncingSms
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Sync Banking SMS'),
            ),
            const SizedBox(height: 10),
            Text('Records synced: $_syncedCount'),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const ReadSmsScreen()),
                );
              },
              child: const Text('Read SMS'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

