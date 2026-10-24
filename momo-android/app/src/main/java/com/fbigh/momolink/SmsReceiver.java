package com.fbigh.momolink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.LinkedHashMap;
import java.util.Map;

/** Android calls this for every incoming SMS, even when the app is closed. Only MoMo payment messages are kept. */
public class SmsReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null || parts.length == 0) return;
        // Long messages arrive in pieces; join the pieces from the same sender.
        Map<String, StringBuilder> bodies = new LinkedHashMap<>();
        Map<String, Long> times = new LinkedHashMap<>();
        for (SmsMessage m : parts) {
            if (m == null) continue;
            String from = m.getDisplayOriginatingAddress();
            if (from == null) from = "";
            bodies.computeIfAbsent(from, k -> new StringBuilder()).append(m.getDisplayMessageBody() == null ? "" : m.getDisplayMessageBody());
            times.putIfAbsent(from, m.getTimestampMillis() > 0 ? m.getTimestampMillis() : System.currentTimeMillis());
        }
        boolean any = false;
        for (Map.Entry<String, StringBuilder> e : bodies.entrySet()) {
            if (Link.enqueue(context, e.getKey(), e.getValue().toString(), times.get(e.getKey()))) any = true;
        }
        if (any && Link.linked(context)) Link.syncSoon(context);
    }
}
