package com.example.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Intent.ACTION_BOOT_COMPLETED != intent.action) return
        Log.d(TAG, "BOOT_COMPLETED — starting SmsForegroundService")
        val i = Intent(context, SmsForegroundService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                @Suppress("DEPRECATION")
                context.startService(i)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForegroundService failed", e)
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}
