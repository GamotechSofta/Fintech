package com.example.app

import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.plugin.common.MethodChannel

/**
 * Pushes SMS text into the running Dart isolate via [MethodChannel.invokeMethod].
 * [EventChannel] alone is unreliable for this because the stream may not be listened yet.
 */
object SmsDartNotifier {
    private val mainHandler = Handler(Looper.getMainLooper())

    fun notify(sender: String, body: String, stage: String) {
        mainHandler.post {
            try {
                val engine = FlutterEngineCache.getInstance().get(MainActivity.ENGINE_CACHE_ID)
                if (engine == null) {
                    Log.w(
                        TAG,
                        "FlutterEngine not cached (open the app at least once). stage=$stage sender=$sender len=${body.length}",
                    )
                    return@post
                }
                val channel = MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL_NAME)
                channel.invokeMethod(
                    "sms",
                    mapOf(
                        "stage" to stage,
                        "sender" to sender,
                        "body" to body,
                    ),
                    object : MethodChannel.Result {
                        override fun success(result: Any?) {}

                        override fun error(
                            errorCode: String,
                            errorMessage: String?,
                            errorDetails: Any?,
                        ) {
                            Log.e(TAG, "invokeMethod error: $errorCode $errorMessage")
                        }

                        override fun notImplemented() {
                            Log.w(TAG, "invokeMethod notImplemented — register listenNativeSmsInFlutterConsole()")
                        }
                    },
                )
            } catch (e: Exception) {
                Log.e(TAG, "notify failed", e)
            }
        }
    }

    private const val TAG = "SmsDartNotifier"
    private const val CHANNEL_NAME = "com.example.app/sms_push"
}
