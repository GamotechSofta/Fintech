import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'session_store.dart';

/// POST `/session/register-login-jwt` — optional; approve uses WEBHOOK_DECLARE_PASSWORD_JWT on the server.
Future<void> registerLoginJwtWithFintechBackend() async {
  await SessionStore.load();
  final token = SessionStore.token.trim();
  if (token.isEmpty) return;

  final prefs = await SharedPreferences.getInstance();
  final base = (prefs.getString('backend_url_auth') ?? '').trim();
  if (base.isEmpty) return;

  final uri = Uri.parse('$base/session/register-login-jwt');
  try {
    final response = await http.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
    );
    // ignore: avoid_print
    print(
      '[SessionSync] register-login-jwt status=${response.statusCode}',
    );
  } catch (e) {
    // ignore: avoid_print
    print('[SessionSync] register-login-jwt failed: $e');
  }
}
