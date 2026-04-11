package com.example.app

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object SmsApiClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun postSmsReader(context: Context, parsed: ParsedSms): Pair<Int, String> {
        val base = SmsNativeConfig.getBackend(context).trimEnd('/')
        if (base.isEmpty()) {
            Log.w("SmsApiClient", "postSmsReader: empty backend URL")
            return -1 to "no_backend"
        }
        val url = "$base/sms-reader"
        val body = JSONObject().apply {
            put("transactionType", parsed.transactionType)
            put("amount", parsed.amount)
            put("bankAccountLastFourDigits", parsed.bankAccountLastFourDigits)
            put("transactionId", parsed.transactionId)
            put("utrNo", parsed.utrNo)
            put("date", parsed.date)
            put("time", parsed.time)
            put("senderID", parsed.senderID)
        }
        val builder = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody(jsonMedia))
        val jwt = SmsNativeConfig.getJwt(context)
        if (jwt.isNotEmpty()) {
            builder.header("Authorization", "Bearer $jwt")
        }
        val req = builder.build()
        Log.d("SmsApiClient", "POST $url")
        client.newCall(req).execute().use { resp ->
            val respBody = resp.body?.string() ?: ""
            Log.d("SmsApiClient", "sms-reader status=${resp.code} body=${respBody.take(500)}")
            return resp.code to respBody
        }
    }

    fun postExtractBulk(context: Context): Pair<Int, String> {
        val base = SmsNativeConfig.getBackend(context).trimEnd('/')
        val jwt = SmsNativeConfig.getJwt(context)
        if (base.isEmpty() || jwt.isEmpty()) {
            Log.w("SmsApiClient", "extract/bulk skipped (no base or jwt)")
            return -1 to "skipped"
        }
        val url = "$base/extract/bulk"
        val body = JSONObject().apply { put("jwtToken", jwt) }
        val req = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody(jsonMedia))
            .build()
        Log.d("SmsApiClient", "POST $url")
        client.newCall(req).execute().use { resp ->
            val respBody = resp.body?.string() ?: ""
            Log.d("SmsApiClient", "extract/bulk status=${resp.code} body=${respBody.take(500)}")
            return resp.code to respBody
        }
    }
}
