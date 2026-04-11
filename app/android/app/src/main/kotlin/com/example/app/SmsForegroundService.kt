package com.example.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors

class SmsForegroundService : Service() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        createChannel()
        ensureForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForeground()
        if (intent != null && intent.hasExtra(EXTRA_BODY)) {
            val sender = intent.getStringExtra(EXTRA_SENDER) ?: ""
            val body = intent.getStringExtra(EXTRA_BODY) ?: ""
            val ts = intent.getLongExtra(EXTRA_TS, System.currentTimeMillis())
            executor.execute {
                processSms(sender, body, ts)
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "SMS listener",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps banking SMS capture active"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(ch)
        }
    }

    private fun ensureForeground() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pending = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Banking SMS listener")
            .setContentText("Listening for transaction SMS")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun processSms(sender: String, body: String, receivedAtMs: Long) {
        Log.i(TAG_LOGCAT, "service processSms from=$sender chars=${body.length}")
        SmsDartNotifier.notify(sender, body, "processing")
        Log.d(TAG, "Processing SMS from=$sender")
        val parsed = SmsBankingParser.parse(sender, body, receivedAtMs) ?: run {
            Log.d(TAG, "parse failed or non-banking / invalid fields")
            SmsDartNotifier.notify(sender, body, "skipped_parse")
            return
        }
        val dedupKey =
            "${parsed.senderID}|${parsed.utrNo}|${parsed.date}|${parsed.time}|${parsed.amount}|${parsed.transactionType}"
        if (SmsDedupStore.isDuplicate(this, dedupKey)) {
            Log.d(TAG, "skipped duplicate key")
            SmsDartNotifier.notify(sender, body, "skipped_duplicate")
            return
        }
        val (code, _) = SmsApiClient.postSmsReader(this, parsed)
        val ok = code in 200..299 || code == 409
        if (ok) {
            SmsDedupStore.recordSuccess(this, dedupKey)
            Log.d(TAG, "sms-reader accepted (code=$code)")
            SmsDartNotifier.notify(sender, "sms-reader ok code=$code", "api_ok")
            SmsApiClient.postExtractBulk(this)
        } else {
            Log.w(TAG, "sms-reader failed code=$code")
            SmsDartNotifier.notify(sender, "sms-reader failed code=$code", "api_error")
        }
    }

    companion object {
        private const val TAG = "SMS_SERVICE"
        private const val TAG_LOGCAT = "NativeSMS"
        private const val CHANNEL_ID = "sms_listener_fg"
        private const val NOTIF_ID = 1001
        const val EXTRA_SENDER = "sender"
        const val EXTRA_BODY = "body"
        const val EXTRA_TS = "received_at_ms"
    }
}
