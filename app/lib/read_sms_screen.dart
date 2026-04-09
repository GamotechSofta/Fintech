import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_sms_inbox/flutter_sms_inbox.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

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

String _smsReaderBaseUrlFromEnv() =>
    _normalizeBackendBaseUrl(dotenv.env['Backend_URL_LOCAL'] ?? '');

const int _bulkRetryChunkSize = 20;
const Duration _bulkRequestTimeout = Duration(seconds: 60);

class ReadSmsScreen extends StatefulWidget {
  const ReadSmsScreen({super.key});

  @override
  State<ReadSmsScreen> createState() => _ReadSmsScreenState();
}

class _ReadSmsScreenState extends State<ReadSmsScreen> {
  Future<http.Response> _postBulkSms(
    List<Map<String, dynamic>> records,
  ) async {
    final baseUrl = _smsReaderBaseUrlFromEnv();
    return http
        .post(
          Uri.parse('$baseUrl/sms-reader/bulk'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({"smsList": records}),
        )
        .timeout(_bulkRequestTimeout);
  }

  Future<Map<String, int>> _uploadBulkInChunks(
    List<Map<String, dynamic>> records,
  ) async {
    var created = 0;
    var duplicates = 0;
    var failed = 0;

    for (var i = 0; i < records.length; i += _bulkRetryChunkSize) {
      final end = (i + _bulkRetryChunkSize) > records.length
          ? records.length
          : (i + _bulkRetryChunkSize);
      final chunk = records.sublist(i, end);
      final response = await _postBulkSms(chunk);

      debugPrint(
        "SMS BULK retry chunk ${i ~/ _bulkRetryChunkSize + 1} response -> status=${response.statusCode}",
      );

      if (response.statusCode == 200 || response.statusCode == 201) {
        dynamic decoded;
        try {
          decoded = response.body.isNotEmpty ? jsonDecode(response.body) : null;
        } catch (_) {
          decoded = null;
        }
        if (decoded is Map<String, dynamic>) {
          created += decoded["created"] is num
              ? (decoded["created"] as num).toInt()
              : 0;
          duplicates += decoded["duplicates"] is num
              ? (decoded["duplicates"] as num).toInt()
              : 0;
          failed += decoded["failed"] is num
              ? (decoded["failed"] as num).toInt()
              : 0;
        } else {
          created += chunk.length;
        }
      } else {
        failed += chunk.length;
      }
    }

    return {
      "created": created,
      "duplicates": duplicates,
      "failed": failed,
    };
  }

  final SmsQuery _query = SmsQuery();
  bool _loading = false;
  bool _saving = false;
  List<Map<String, dynamic>> _messages = const [];
  String? _error;

  Map<String, dynamic> _sanitizeSmsPayload(Map<String, dynamic> smsData) {
    return <String, dynamic>{
      "amount": smsData["amount"],
      "utrNo": smsData["utrNo"],
      "transactionType": smsData["transactionType"],
      "accountLast4": smsData["accountLast4"],
      "date": smsData["date"],
      "time": smsData["time"],
      "senderId": smsData["senderId"],
      "transactionId":
          (smsData["transactionId"]?.toString().isNotEmpty ?? false)
          ? smsData["transactionId"]
          : "NA",
    };
  }

  Future<void> sendSmsToBackend(Map<String, dynamic> smsData) async {
    try {
      final payload = _sanitizeSmsPayload(smsData);

      debugPrint("SMS POST payload: ${jsonEncode(payload)}");

      final response = await http
          .post(
            Uri.parse('${_smsReaderBaseUrlFromEnv()}/sms-reader'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 10));

      debugPrint(
        "SMS POST response -> status=${response.statusCode}, body=${response.body}",
      );

      if (response.statusCode == 200 || response.statusCode == 201) {
        return;
      }

      debugPrint("SMS POST failed with status code ${response.statusCode}");
    } catch (e) {
      debugPrint("sendSmsToBackend error: $e");
    }
  }

  Future<void> sendBulkSmsToBackend(
    List<Map<String, dynamic>> smsDataList, {
    bool showSnackBar = false,
  }) async {
    if (smsDataList.isEmpty) return;
    try {
      final records = smsDataList.map(_sanitizeSmsPayload).toList();
      debugPrint("SMS BULK upload start -> total=${records.length}");
      Map<String, int> result;
      try {
        final response = await _postBulkSms(records);
        debugPrint(
          "SMS BULK single response -> status=${response.statusCode}, body=${response.body}",
        );
        if (response.statusCode == 200 || response.statusCode == 201) {
          dynamic decoded;
          try {
            decoded = response.body.isNotEmpty ? jsonDecode(response.body) : null;
          } catch (_) {
            decoded = null;
          }
          if (decoded is Map<String, dynamic>) {
            result = {
              "created": decoded["created"] is num
                  ? (decoded["created"] as num).toInt()
                  : 0,
              "duplicates": decoded["duplicates"] is num
                  ? (decoded["duplicates"] as num).toInt()
                  : 0,
              "failed": decoded["failed"] is num
                  ? (decoded["failed"] as num).toInt()
                  : 0,
            };
          } else {
            result = {"created": records.length, "duplicates": 0, "failed": 0};
          }
        } else {
          debugPrint(
            "SMS BULK single request failed with status ${response.statusCode}, retrying in chunks",
          );
          result = await _uploadBulkInChunks(records);
        }
      } catch (singleError) {
        debugPrint("SMS BULK single request error: $singleError");
        debugPrint("SMS BULK retrying in chunks");
        result = await _uploadBulkInChunks(records);
      }

      final totalSuccess = (result["created"] ?? 0) + (result["duplicates"] ?? 0);
      final totalFailed = result["failed"] ?? 0;
      debugPrint(
        "SMS BULK upload done -> total=${records.length}, success=$totalSuccess, failed=$totalFailed",
      );
      if (showSnackBar && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              totalFailed == 0
                  ? "Bulk SMS upload successful -> success: $totalSuccess"
                  : "Bulk SMS upload completed -> success: $totalSuccess, failed: $totalFailed",
            ),
            backgroundColor: totalFailed == 0 ? Colors.green : Colors.orange,
          ),
        );
      }
    } catch (e) {
      debugPrint("sendBulkSmsToBackend error: $e");
      if (showSnackBar && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text("Bulk SMS upload error: $e"),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  String _messagesAsJson() {
    return const JsonEncoder.withIndent('  ').convert({
      "count": _messages.length,
      "data": _messages,
    });
  }

  void _showJsonData() {
    final jsonText = _messagesAsJson();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Read SMS JSON',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 420),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      jsonText,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _saveReadSmsJsonToDb() async {
    if (_messages.isEmpty || _saving) return;
    if (_smsReaderBaseUrlFromEnv().isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Backend base URL is missing'),
        ),
      );
      return;
    }

    setState(() => _saving = true);
    var success = 0;
    var failed = 0;

    try {
      final payloadList = _messages
          .map(
            (item) => <String, dynamic>{
              "transactionType": item["transactionType"],
              "amount": item["amount"],
              "accountLast4": item["accountLast4"] ?? "0000",
              "transactionId": item["transactionId"],
              "utrNo": item["utrNo"] ?? item["UTR"],
              "date": item["date"],
              "time": item["time"],
              "senderId": item["senderID"] ?? item["sender"],
            },
          )
          .toList();

      final result = await _uploadBulkInChunks(payloadList);
      success = (result["created"] ?? 0) + (result["duplicates"] ?? 0);
      failed = result["failed"] ?? 0;

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            failed == 0
                ? 'Bulk upload successful -> success: $success'
                : 'Bulk upload completed -> success: $success, failed: $failed',
          ),
          backgroundColor: failed == 0 ? Colors.green : Colors.orange,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Bulk upload error: $e'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  bool _isLikelyBankingSms(String text, String sender) {
    final value = '$sender $text'.toLowerCase();
    final senderValue = sender.toUpperCase();
    final isBankingSender =
        senderValue.contains('VK-') ||
        senderValue.contains('VM-') ||
        senderValue.contains('BP-') ||
        senderValue.contains('AX-') ||
        senderValue.contains('HP-') ||
        senderValue.contains('ICICI') ||
        senderValue.contains('HDFCBK') ||
        senderValue.contains('SBI') ||
        senderValue.contains('KOTAK') ||
        senderValue.contains('AXISBK') ||
        senderValue.contains('PNBSMS') ||
        senderValue.contains('PAYTM') ||
        senderValue.contains('UPI');
    final isOtpMessage =
        value.contains('otp') || value.contains('one time password');
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
    final hasTxnKeywords = keywords.any(value.contains);
    return !isOtpMessage && (isBankingSender || hasTxnKeywords);
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
      r'(?:(?:inr|rs\.?|₹)\s*([0-9Oo,]+(?:\.[0-9Oo]{1,2})?)|([0-9Oo,]+(?:\.[0-9Oo]{1,2})?)\s*(?:inr|rs\.?|₹))',
      caseSensitive: false,
    );
    final currencyMatch = amountRegexWithCurrency.firstMatch(body);
    if (currencyMatch != null) {
      final raw = (currencyMatch.group(1) ?? currencyMatch.group(2) ?? '');
      final normalized = raw
          .replaceAll(',', '')
          .replaceAll('O', '0')
          .replaceAll('o', '0');
      return double.tryParse(normalized);
    }
    final plainAmountRegex = RegExp(r'([0-9]{2,}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)');
    final plainMatch = plainAmountRegex.firstMatch(body);
    if (plainMatch == null) return null;
    final normalized = (plainMatch.group(1) ?? '').replaceAll(',', '');
    return double.tryParse(normalized);
  }

  String _extractUtr(String body) {
    final utrRegex = RegExp(
      r'(?:utr|ref(?:erence)?(?:\s*no)?)[\s:.-]*([A-Za-z0-9]+)',
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

  String _extractTransactionId(String body) {
    final idRegex = RegExp(
      r'(?:transaction\s*id|txn\s*id|txnid|rrn)[\s:.-]*([A-Za-z0-9\-]{6,})',
      caseSensitive: false,
    );
    return idRegex.firstMatch(body)?.group(1)?.toUpperCase() ?? 'NA';
  }

  Future<void> _loadSms() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final status = await Permission.sms.request();
      if (!status.isGranted) {
        throw Exception('SMS permission denied');
      }
      final rawMessages = await _query.querySms(
        kinds: [SmsQueryKind.inbox],
        count: 500,
      );
      rawMessages.sort(
        (a, b) => (b.date ?? DateTime.fromMillisecondsSinceEpoch(0)).compareTo(
          a.date ?? DateTime.fromMillisecondsSinceEpoch(0),
        ),
      );
      final structured = <Map<String, dynamic>>[];
      final bulkPayload = <Map<String, dynamic>>[];
      for (final sms in rawMessages) {
        final body = (sms.body ?? '').trim();
        final sender = (sms.address ?? 'UNKNOWN').trim();
        if (body.isEmpty || !_isLikelyBankingSms(body, sender)) continue;
        final smsDate = sms.date ?? DateTime.now();
        final utr = _extractUtr(body);
        if (utr == 'NA') continue;
        final parsedData = <String, dynamic>{
          "transactionType": _extractTransactionType(body),
          "amount": _extractAmount(body) ?? 0,
          "accountLast4": _extractLastFourDigits(body),
          "transactionId": _extractTransactionId(body),
          "UTR": utr,
          "utrNo": utr,
          "date":
              '${smsDate.year}-${smsDate.month.toString().padLeft(2, '0')}-${smsDate.day.toString().padLeft(2, '0')}',
          "time":
              '${smsDate.hour.toString().padLeft(2, '0')}:${smsDate.minute.toString().padLeft(2, '0')}:${smsDate.second.toString().padLeft(2, '0')}',
          "sender": sender,
          "senderID": sender,
          "senderId": sender,
        };

        structured.add(parsedData);
        bulkPayload.add(parsedData);
      }
      if (!mounted) return;
      setState(() {
        _messages = structured;
      });
      sendBulkSmsToBackend(bulkPayload, showSnackBar: true).catchError((_) {
        // Ignore network failures here so UI remains responsive.
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
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
    _loadSms();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Read Banking SMS'),
        actions: [
          IconButton(
            onPressed: (_messages.isEmpty || _saving) ? null : _saveReadSmsJsonToDb,
            icon: _saving
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save),
            tooltip: 'Save JSON to DB',
          ),
          IconButton(
            onPressed: _messages.isEmpty ? null : _showJsonData,
            icon: const Icon(Icons.data_object),
            tooltip: 'Show JSON',
          ),
          IconButton(
            onPressed: _loading ? null : _loadSms,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(child: Text(_error!))
          : _messages.isEmpty
          ? const Center(child: Text('No banking SMS found'))
          : ListView.builder(
              itemCount: _messages.length,
              itemBuilder: (context, index) {
                final item = _messages[index];
                final txnType =
                    (item["transactionType"]?.toString().toLowerCase() == 'debit')
                    ? 'debit'
                    : 'credit';
                final amountText = item["amount"]?.toString() ?? '-';
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: ListTile(
                    title: Text('SMS ${index + 1}'),
                    subtitle: Text(
                      'Type: $txnType\nAmount: $amountText\nAccountLast4: ${item["accountLast4"]}\nTxnId: ${item["transactionId"]}\nUTR: ${item["UTR"]}\nSender: ${item["sender"]}\nDate: ${item["date"]} ${item["time"]}',
                    ),
                    trailing: const Icon(Icons.message, color: Colors.blue),
                  ),
                );
              },
            ),
    );
  }
}
