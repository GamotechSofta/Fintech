package com.example.app

import android.content.Context

object SmsNativeConfig {
    private const val PREF = "sms_native_config"
    private const val KEY_BACKEND = "backend_base_url"
    private const val KEY_JWT = "jwt_token"

    fun save(context: Context, backend: String, jwt: String) {
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
            .putString(KEY_BACKEND, backend.trim())
            .putString(KEY_JWT, jwt.trim())
            .apply()
    }

    fun getBackend(context: Context): String =
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_BACKEND, "") ?: ""

    fun getJwt(context: Context): String =
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_JWT, "") ?: ""
}
