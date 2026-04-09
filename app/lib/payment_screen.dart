import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;

import 'login_screen.dart';

String _paymentsEndpointFromEnv() {
  final raw = (dotenv.env['BACKEND_URL'] ?? '').trim();
  if (raw.isEmpty) return '';
  final normalized = raw.endsWith('/') ? raw.substring(0, raw.length - 1) : raw;
  if (normalized.endsWith('/payments')) return normalized;
  return '$normalized/payments';
}

class PaymentScreen extends StatefulWidget {
  const PaymentScreen({super.key, required this.token});

  final String token;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _payments = const [];

  Future<void> _loadPayments() async {
    final endpoint = _paymentsEndpointFromEnv();
    if (endpoint.isEmpty) {
      setState(() {
        _error = 'BACKEND_URL is missing in app/.env';
      });
      return;
    }
    final jwtToken = widget.token.isNotEmpty ? widget.token : SessionStore.token;
    if (jwtToken.isEmpty) {
      setState(() {
        _error = 'JWT token is missing. Please login again.';
      });
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final response = await http
          .get(
            Uri.parse(endpoint),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $jwtToken',
            },
          )
          .timeout(const Duration(seconds: 30));

      debugPrint('Payments GET $endpoint status=${response.statusCode}');
      debugPrint('Payments response: ${response.body}');

      if (response.statusCode < 200 || response.statusCode >= 300) {
        setState(() {
          _error = 'Failed to load payments (status ${response.statusCode})';
        });
        return;
      }

      dynamic decoded;
      try {
        decoded = response.body.isNotEmpty ? jsonDecode(response.body) : null;
      } catch (_) {
        decoded = null;
      }

      final list = <Map<String, dynamic>>[];
      if (decoded is List) {
        for (final item in decoded) {
          if (item is Map<String, dynamic>) list.add(item);
        }
      } else if (decoded is Map<String, dynamic>) {
        final data = decoded['data'] ?? decoded['payments'] ?? decoded['results'];
        if (data is List) {
          for (final item in data) {
            if (item is Map<String, dynamic>) list.add(item);
          }
        }
      }

      setState(() {
        _payments = list;
      });
    } catch (e) {
      setState(() {
        _error = 'Failed to load payments: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  @override
  void initState() {
    super.initState();
    _loadPayments();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Payments'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _loadPayments,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(child: Text(_error!))
          : _payments.isEmpty
          ? const Center(child: Text('No payments found'))
          : ListView.builder(
              itemCount: _payments.length,
              itemBuilder: (context, index) {
                final payment = _payments[index];
                final amount = payment['amount'] ?? payment['paymentAmount'] ?? '-';
                final status = payment['status'] ?? payment['paymentStatus'] ?? '-';
                final id = payment['_id'] ?? payment['id'] ?? '-';
                final date = payment['date'] ?? payment['createdAt'] ?? '-';
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: ListTile(
                    title: Text('Payment ${index + 1}'),
                    subtitle: Text(
                      'Amount: $amount\nStatus: $status\nID: $id\nDate: $date',
                    ),
                  ),
                );
              },
            ),
    );
  }
}
