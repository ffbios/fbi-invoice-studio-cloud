package com.fbigh.smsgateway;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.telephony.SmsManager;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class GatewayService extends Service {
    // Network fallback keeps the phone gateway usable while the custom domain DNS is repaired.
    private static final String CHANNEL = "fbi_sms_gateway";
    // Rebuild trigger after correcting the Android pairing fallback.
    private static final String[] BASE_URLS = {
            "https://invoice.fbigh.com",
            "https://czo1a4qo.up.railway.app"
    };
    private static final String PREFS = "fbi_sms_gateway";
    private static final String KEY_TOKEN = "gateway_token";
    private static final String KEY_GATEWAY_ID = "gateway_id";
    private volatile boolean running = true;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(7001, notification("FBI SMS Gateway is running"));
        new Thread(this::loop, "fbi-sms-gateway").start();
    }

    @Override public int onStartCommand(Intent i, int flags, int startId) {
        return START_STICKY;
    }

    private String token() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TOKEN, "").trim();
    }

    private String gatewayId() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GATEWAY_ID, "private-gateway-1");
    }

    private void loop() {
        while (running) {
            try {
                if (token().isEmpty()) { stopSelf(); return; }
                heartbeat();
                JSONObject job = nextJob();
                if (job != null && job.optString("id","").length() > 0) sendJob(job);
            } catch (Throwable ignored) { }
            try { Thread.sleep(5000); } catch (InterruptedException ignored) { }
        }
    }

    private JSONObject nextJob() throws Exception {
        Throwable last = null;
        for (String base : BASE_URLS) {
            HttpURLConnection c = null;
            try {
                c = auth(new URL(base + "/api/sms/gateway/next"), "GET");
                int code = c.getResponseCode();
                if (code == 404 && !base.equals(BASE_URLS[BASE_URLS.length - 1])) { c.disconnect(); continue; }
                if (code != 200) { c.disconnect(); return null; }
                String s = read(c);
                c.disconnect();
                if (s == null || s.isEmpty() || "null".equals(s)) return null;
                JSONObject o = new JSONObject(s);
                return o.optJSONObject("job");
            } catch (Throwable t) {
                last = t;
                if (c != null) c.disconnect();
            }
        }
        if (last instanceof Exception) throw (Exception) last;
        return null;
    }

    private void heartbeat() throws Exception {
        JSONObject b = new JSONObject();
        b.put("gatewayId", gatewayId());
        b.put("gatewayName", "FBI Android SMS Gateway");
        b.put("simLine", "FBI SIM");
        b.put("portLabel", Build.MANUFACTURER + " " + Build.MODEL);
        b.put("modemStatus", "online");
        b.put("detail", "Android GSM gateway");
        post("/api/sms/gateway/heartbeat", b);
    }

    private void sendJob(JSONObject job) {
        String id = job.optString("id","");
        String to = job.optString("phone","");
        String body = job.optString("message","");
        boolean ok = false;
        String err = null;
        try {
            if (to.isEmpty() || body.isEmpty()) throw new IllegalArgumentException("Missing recipient or message");
            SmsManager.getDefault().sendTextMessage(to, null, body, null, null);
            ok = true;
        } catch (Throwable t) {
            err = t.toString();
        }
        try {
            JSONObject r = new JSONObject();
            r.put("id", id);
            r.put("status", ok ? "sent" : "failed");
            if (!ok) r.put("error", err == null ? "SMS send failed" : err);
            post("/api/sms/gateway/result", r);
        } catch (Throwable ignored) { }
    }

    private HttpURLConnection auth(URL u, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        String t = token();
        c.setRequestProperty("Authorization", "Bearer " + t);
        c.setRequestProperty("X-FBI-SMS-Gateway-Token", t);
        return c;
    }

    private void post(String path, JSONObject body) throws Exception {
        Throwable last = null;
        for (String base : BASE_URLS) {
            HttpURLConnection c = null;
            try {
                c = auth(new URL(base + path), "POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream o = c.getOutputStream()) { o.write(bytes); }
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 404 && !base.equals(BASE_URLS[BASE_URLS.length - 1])) continue;
                return;
            } catch (Throwable t) {
                last = t;
                if (c != null) c.disconnect();
            }
        }
        if (last instanceof Exception) throw (Exception) last;
    }

    private String read(HttpURLConnection c) throws Exception {
        BufferedReader r = new BufferedReader(
                new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder s = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) s.append(line);
        r.close();
        return s.toString();
    }

    private Notification notification(String text) {
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("FBI SMS Gateway")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "FBI SMS Gateway", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    @Override public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}