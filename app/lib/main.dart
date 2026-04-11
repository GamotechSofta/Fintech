import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'backend_session_sync.dart';
import 'login_screen.dart';
import 'payment_screen.dart';
import 'session_store.dart';
import 'sms_ingest_service.dart';
import 'sms_native_events.dart';

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
  await SessionStore.load();
  await registerLoginJwtWithFintechBackend();
  // So SMS is handled even when UI (e.g. dashboard) is not open — after kill, screen off, etc.
  await SmsIngestService.start();
  runApp(const MyApp());
  // After the first frame, platform channels are reliably wired for native → Dart calls.
  WidgetsBinding.instance.addPostFrameCallback((_) {
    listenNativeSmsInFlutterConsole();
  });
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
  bool _showedListenerStartedSnack = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _askSmsPermission());
  }

  Future<void> _tryStartSmsIngestAndNotify() async {
    final wasInactive = !SmsIngestService.isActive;
    await SmsIngestService.start();
    if (wasInactive &&
        SmsIngestService.isActive &&
        mounted &&
        !_showedListenerStartedSnack) {
      _showedListenerStartedSnack = true;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Banking SMS capture active (including in background)'),
        ),
      );
    }
  }

  Future<void> _askSmsPermission() async {
    await Permission.notification.request();

    final currentStatus = await Permission.sms.status;

    if (currentStatus.isGranted) {
      await _tryStartSmsIngestAndNotify();
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
      await _tryStartSmsIngestAndNotify();
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
