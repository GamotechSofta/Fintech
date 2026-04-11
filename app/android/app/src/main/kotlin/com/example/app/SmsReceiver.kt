package com.example.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Telephony
import android.util.Log

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Telephony.Sms.Intents.SMS_RECEIVED_ACTION != intent.action) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // Multipart SMS: one intent may contain several PDUs — merge before one service run.
        val body = buildString {
            for (smsMessage in messages) {
                append(smsMessage.messageBody ?: "")
            }
        }
        val first = messages[0]
        val sender = first.displayOriginatingAddress ?: ""
        val ts = first.timestampMillis

        // Log.i is visible with default `adb logcat`; Log.d is often filtered out.
        Log.i(TAG_LOGCAT, "SMS from=$sender chars=${body.length}")
        Log.i(TAG_LOGCAT, body.take(500).let { if (body.length > 500) "$it…" else it })

        SmsDartNotifier.notify(sender, body, "received")

        val serviceIntent = Intent(context, SmsForegroundService::class.java).apply {
            putExtra(SmsForegroundService.EXTRA_SENDER, sender)
            putExtra(SmsForegroundService.EXTRA_BODY, body)
            putExtra(SmsForegroundService.EXTRA_TS, ts)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                @Suppress("DEPRECATION")
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e(TAG_LOGCAT, "startForegroundService failed", e)
        }
    }

    companion object {
        /** Grep logcat: `adb logcat -s NativeSMS` */
        private const val TAG_LOGCAT = "NativeSMS"
    }
}
