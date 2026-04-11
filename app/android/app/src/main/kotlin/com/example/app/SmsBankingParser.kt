package com.example.app

import android.util.Log
import java.util.Calendar
import java.util.Locale
import java.util.regex.Pattern

/**
 * Banking SMS parsing aligned with [app/lib/sms_ingest_service.dart], with strict validation:
 * all fields required or [ParsedSms] is null.
 */
data class ParsedSms(
    val transactionType: String,
    val amount: Double,
    val bankAccountLastFourDigits: String,
    val transactionId: String,
    val utrNo: String,
    val date: String,
    val time: String,
    val senderID: String,
)

object SmsBankingParser {
    private val bankingKeywords = listOf(
        "debited", "credited", "txn", "transaction", "upi",
        "a/c", "account", "utr", "imps", "neft", "rtgs", "bank",
    )

    fun parse(sender: String, body: String, receivedAtMs: Long): ParsedSms? {
        val trimmedSender = sender.trim()
        if (body.isBlank() || trimmedSender.isEmpty()) return null
        if (!isLikelyBankingSms(body, trimmedSender)) {
            Log.d("SmsBankingParser", "parse: skipped (not likely banking)")
            return null
        }

        val utr = extractUtr(body) ?: run {
            Log.d("SmsBankingParser", "parse: skipped (no 12-digit UTR)")
            return null
        }
        val amount = extractAmount(body) ?: run {
            Log.d("SmsBankingParser", "parse: skipped (no amount)")
            return null
        }
        val lastFour = extractLastFourDigits(body) ?: run {
            Log.d("SmsBankingParser", "parse: skipped (no account last 4)")
            return null
        }
        val txType = extractTransactionType(body)
        val txId = extractTransactionId(body)

        val cal = Calendar.getInstance().apply { timeInMillis = receivedAtMs }
        val date = String.format(
            Locale.US,
            "%04d-%02d-%02d",
            cal.get(Calendar.YEAR),
            cal.get(Calendar.MONTH) + 1,
            cal.get(Calendar.DAY_OF_MONTH),
        )
        val time = String.format(
            Locale.US,
            "%02d:%02d:%02d",
            cal.get(Calendar.HOUR_OF_DAY),
            cal.get(Calendar.MINUTE),
            cal.get(Calendar.SECOND),
        )

        return ParsedSms(
            transactionType = txType.lowercase(Locale.US),
            amount = amount,
            bankAccountLastFourDigits = lastFour,
            transactionId = txId,
            utrNo = utr,
            date = date,
            time = time,
            senderID = trimmedSender,
        )
    }

    private fun isLikelyBankingSms(text: String, sender: String): Boolean {
        val value = "$sender $text".lowercase(Locale.US)
        return bankingKeywords.any { value.contains(it) }
    }

    private fun extractTransactionType(body: String): String {
        val text = body.lowercase(Locale.US)
        if (text.contains("debited") || text.contains("withdrawn") || text.contains("dr")) {
            return "debit"
        }
        return "credit"
    }

    private fun extractAmount(body: String): Double? {
        val currency = Pattern.compile(
            """(?:inr|rs\.?|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)""",
            Pattern.CASE_INSENSITIVE,
        ).matcher(body)
        if (currency.find()) {
            val n = currency.group(1)?.replace(",", "") ?: return null
            return n.toDoubleOrNull()
        }
        val plain = Pattern.compile("""([0-9]{2,}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)""").matcher(body)
        if (plain.find()) {
            val n = plain.group(1)?.replace(",", "") ?: return null
            return n.toDoubleOrNull()
        }
        return null
    }

    private fun extractLastFourDigits(body: String): String? {
        val account = Pattern.compile(
            """(?:a/c|ac|acct|account)[^0-9]{0,10}(?:x+|\*+)?\s*([0-9]{4})""",
            Pattern.CASE_INSENSITIVE,
        ).matcher(body)
        if (account.find()) return account.group(1)
        return null
    }

    private fun extractUtr(body: String): String? {
        val utr = Pattern.compile(
            """(?:utr|ref(?:erence)?(?:\s*no)?|transaction\s*id|txn\s*id)[\s:.-]*([A-Za-z0-9]{8,})""",
            Pattern.CASE_INSENSITIVE,
        ).matcher(body)
        if (!utr.find()) return null
        val raw = utr.group(1)?.trim() ?: return null
        val digitsOnly = raw.replace(Regex("[^0-9]"), "")
        return if (digitsOnly.length == 12) digitsOnly else null
    }

    private fun extractTransactionId(body: String): String {
        val id = Pattern.compile(
            """(?:transaction\s*id|txn\s*id|txnid|rrn)[\s:.-]*([A-Za-z0-9\-]{6,})""",
            Pattern.CASE_INSENSITIVE,
        ).matcher(body)
        return if (id.find()) {
            id.group(1)?.uppercase(Locale.US) ?: "NA"
        } else {
            "NA"
        }
    }
}
