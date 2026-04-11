import 'package:shared_preferences/shared_preferences.dart';

/// Persisted auth session (used from UI and from background SMS handling).
class SessionStore {
  SessionStore._();

  static String token = '';
  static String userId = '';
  static String username = '';
  static String role = '';

  static Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    token = prefs.getString('auth_token') ?? '';
    userId = prefs.getString('auth_user_id') ?? '';
    username = prefs.getString('auth_username') ?? '';
    role = prefs.getString('auth_role') ?? '';
  }

  static Future<void> save({
    required String savedToken,
    required String savedUserId,
    required String savedUsername,
    required String savedRole,
  }) async {
    token = savedToken;
    userId = savedUserId;
    username = savedUsername;
    role = savedRole;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('auth_token', token);
    await prefs.setString('auth_user_id', userId);
    await prefs.setString('auth_username', username);
    await prefs.setString('auth_role', role);
  }

  static Map<String, String> authHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }
}
