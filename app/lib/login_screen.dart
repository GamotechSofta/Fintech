import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

import 'backend_session_sync.dart';
import 'session_store.dart';
import 'sms_ingest_service.dart';

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

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.dashboardBuilder});

  final Widget Function({
    required String username,
    required String userId,
    required String role,
    required String token,
  })
  dashboardBuilder;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isLoading = false;
  DateTime? _loginBlockedUntil;
  Timer? _loginCooldownTimer;
  int _retryAfterSeconds = 0;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _requestSmsOnFirstLaunch());
    }
  }

  /// SMS capture works when the app is killed only after OS permissions are granted.
  Future<void> _requestSmsOnFirstLaunch() async {
    await Permission.notification.request();
    final status = await Permission.sms.status;
    if (status.isGranted) {
      await SmsIngestService.start();
      return;
    }
    if (status.isPermanentlyDenied) return;
    await Permission.sms.request();
    await SmsIngestService.start();
  }

  @override
  void dispose() {
    _loginCooldownTimer?.cancel();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  int _parseRetryAfterSeconds(http.Response response) {
    final headerValue = response.headers['retry-after'];
    if (headerValue == null) return 30;
    final direct = int.tryParse(headerValue);
    if (direct != null && direct > 0) return direct;
    final parsedDate = DateTime.tryParse(headerValue);
    if (parsedDate != null) {
      final diff = parsedDate.difference(DateTime.now()).inSeconds;
      if (diff > 0) return diff;
    }
    return 30;
  }

  void _startLoginCooldown(int seconds) {
    _loginCooldownTimer?.cancel();
    _retryAfterSeconds = seconds;
    _loginBlockedUntil = DateTime.now().add(Duration(seconds: seconds));
    _loginCooldownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      final remaining = _loginBlockedUntil!.difference(DateTime.now()).inSeconds;
      if (remaining <= 0) {
        timer.cancel();
        setState(() {
          _retryAfterSeconds = 0;
          _loginBlockedUntil = null;
        });
      } else {
        setState(() {
          _retryAfterSeconds = remaining;
        });
      }
    });
  }

  Map<String, String> _extractAuthData(
    Map<String, dynamic> responseData,
    String fallbackUsername,
  ) {
    final data = responseData['data'];
    final user = responseData['user'];
    final admin = responseData['admin'];

    String getString(dynamic value) => value == null ? '' : value.toString();

    final token = getString(
      responseData['token'] ??
          responseData['jwt'] ??
          responseData['accessToken'] ??
          responseData['access_token'] ??
          (data is Map<String, dynamic>
              ? data['token'] ?? data['accessToken']
              : null),
    );

    final source = data is Map<String, dynamic>
        ? data
        : user is Map<String, dynamic>
        ? user
        : admin is Map<String, dynamic>
        ? admin
        : responseData;

    final userId = getString(source['_id'] ?? source['id'] ?? source['userId']);
    final username = getString(source['username'] ?? source['name']);
    final role = getString(source['role']);

    return {
      'token': token,
      'userId': userId,
      'username': username.isEmpty ? fallbackUsername : username,
      'role': role,
    };
  }

  Future<void> _login() async {
    if (!_formKey.currentState!.validate()) return;
    if (_retryAfterSeconds > 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Too many requests. Try again in $_retryAfterSeconds seconds.',
          ),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    setState(() => _isLoading = true);

    final baseUrl = _authBaseUrlFromEnv();
    final url = Uri.parse('$baseUrl/admin/login');

    try {
      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'username': _usernameController.text.trim(),
          'password': _passwordController.text,
        }),
      );

      if (!mounted) return;

      final responseData = response.body.isNotEmpty ? jsonDecode(response.body) : {};
      final isSuccess = response.statusCode >= 200 && response.statusCode < 300;
      if (!isSuccess && response.statusCode == 429) {
        final retryAfter = _parseRetryAfterSeconds(response);
        _startLoginCooldown(retryAfter);
      }
      final message =
          responseData is Map<String, dynamic> && responseData['message'] != null
          ? responseData['message'].toString()
          : isSuccess
          ? 'Login successful'
          : 'Login failed';

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: isSuccess ? Colors.green : Colors.red,
        ),
      );

      if (isSuccess) {
        final authData = _extractAuthData(
          responseData,
          _usernameController.text.trim(),
        );
        await SessionStore.save(
          savedToken: authData['token'] ?? '',
          savedUserId: authData['userId'] ?? '',
          savedUsername: authData['username'] ?? _usernameController.text.trim(),
          savedRole: authData['role'] ?? '',
        );
        await registerLoginJwtWithFintechBackend();
        await SmsIngestService.start();

        Navigator.of(context).pushReplacement(
          MaterialPageRoute(
            builder: (_) => widget.dashboardBuilder(
              username: authData['username'] ?? _usernameController.text.trim(),
              userId: authData['userId'] ?? '',
              role: authData['role'] ?? '',
              token: authData['token'] ?? '',
            ),
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Unable to connect to server'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F7FF),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Card(
                elevation: 10,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'LOGIN',
                          style: TextStyle(
                            fontSize: 30,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF1B56D2),
                          ),
                        ),
                        const SizedBox(height: 24),
                        TextFormField(
                          controller: _usernameController,
                          decoration: InputDecoration(
                            labelText: 'Username',
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          validator: (value) {
                            if (value == null || value.trim().isEmpty) {
                              return 'Username is required';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 14),
                        TextFormField(
                          controller: _passwordController,
                          obscureText: true,
                          decoration: InputDecoration(
                            labelText: 'Password',
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          validator: (value) {
                            if (value == null || value.isEmpty) {
                              return 'Password is required';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 22),
                        Align(
                          alignment: Alignment.center,
                          child: SizedBox(
                            width: 180,
                            height: 48,
                            child: ElevatedButton(
                              onPressed: (_isLoading || _retryAfterSeconds > 0)
                                  ? null
                                  : _login,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFFFF9800),
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(30),
                                ),
                              ),
                              child: _isLoading
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Text(
                                      'LOGIN',
                                      style: TextStyle(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                            ),
                          ),
                        ),
                        if (_retryAfterSeconds > 0) ...[
                          const SizedBox(height: 10),
                          Text(
                            'Retry after $_retryAfterSeconds seconds',
                            style: const TextStyle(
                              color: Colors.red,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
