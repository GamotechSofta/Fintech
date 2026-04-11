package com.example.app

import android.content.Intent
import android.os.Build
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        FlutterEngineCache.getInstance().put(ENGINE_CACHE_ID, flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "configure" -> {
                    val backend = call.argument<String>("backendBaseUrl") ?: ""
                    val jwt = call.argument<String>("jwtToken") ?: ""
                    SmsNativeConfig.save(this, backend, jwt)
                    Log.d(TAG, "configure backend len=${backend.length} jwt len=${jwt.length}")
                    result.success(null)
                }
                "startForegroundListener" -> {
                    val intent = Intent(this, SmsForegroundService::class.java)
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            startForegroundService(intent)
                        } else {
                            @Suppress("DEPRECATION")
                            startService(intent)
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "startForegroundListener failed", e)
                        result.error("start_failed", e.message, null)
                        return@setMethodCallHandler
                    }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    companion object {
        private const val TAG = "MainActivity"
        const val CHANNEL = "com.example.app/sms_native"
        /** Must match [SmsDartNotifier] lookup — engine must be cached before SMS can log to Dart. */
        const val ENGINE_CACHE_ID = "fintech_main"
    }
}
