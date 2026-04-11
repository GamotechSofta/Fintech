package com.example.app

import android.content.Context

/**
 * De-duplicates SMS POSTs using the same key shape as the former Flutter ingest path.
 */
object SmsDedupStore {
    private const val PREF = "sms_native_dedup"
    private const val KEY_SEEN = "seen_keys"
    private const val MAX_KEYS = 3000

    fun isDuplicate(context: Context, key: String): Boolean {
        val set = context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getStringSet(KEY_SEEN, emptySet()) ?: emptySet()
        return set.contains(key)
    }

    fun recordSuccess(context: Context, key: String) {
        val prefs = context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val prev = HashSet(prefs.getStringSet(KEY_SEEN, emptySet()) ?: emptySet())
        prev.add(key)
        while (prev.size > MAX_KEYS) {
            val it = prev.iterator()
            if (it.hasNext()) it.remove() else break
        }
        prefs.edit().putStringSet(KEY_SEEN, prev).apply()
    }
}
