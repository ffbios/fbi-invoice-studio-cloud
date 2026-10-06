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
    private static final String CHANNEL = "fbi_sms_gateway";
    private static final String BASE_URL = "https://invoice.fbigh.com";
    private static final String TOKEN = "__FBI_SMS_GATEWAY_TOKEN__";
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

    private void loop() {
        while (running) {
            try {
                heartbeat();
                JSONObject job = nextJob();
                if (job != null && job.optString("id","").length() > 0) sendJob(job);
            } catch (Throwable ignored) { }
            try { Thread.sleep(5000); } catch (InterruptedException ignored) { }
        }
    }

    private JSONObject nextJob() throws Exception {
        HttpURLConnection c = auth(new URL(BASE_URL + "/api/sms/gateway/next"), "GET");
        int code = c.getResponseCode();
        if (code != 200) { c.disconnect(); return null; }
        String s = read(c);
        c.disconnect();
        if (s == null || s.isEmpty() || "null".equals(s)) return null;
        JSONObject o = new JSONObject(s);
        JSONObject job = o.optJSONObject("job");
        return job != null ? job : o;
    }

    private void heartbeat() throws Exception {
        JSONObject b = new JSONObject();
        b.put("deviceName", "FBI Android SMS Gateway");
        b.put("phoneModel", Build.MANUFACTURER + " " + Build.MODEL);
        post("/api/sms/gateway/heartbeat", b);
    }

    private void sendJob(JSONObject job) {
        String id = job.optString("id","");
        String to = job.optString("to", job.optString("phone",""));
        String body = job.optString("message", job.optString("body",""));
        boolean ok = false;
        String err = null;
        try {
            SmsManager.getDefault().sendTextMessage(to, null, body, null, null);
            ok = true;
        } catch (Throwable t) {
            err = t.toString();
        }
        try {
            JSONObject r = new JSONObject();
            r.put("jobId", id);
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
        c.setRequestProperty("Authorization", "Bearer " + TOKEN);
        c.setRequestProperty("X-FBI-SMS-Gateway-Token", TOKEN);
        return c;
    }

    private void post(String path, JSONObject body) throws Exception {
        HttpURLConnection c = auth(new URL(BASE_URL + path), "POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream o = c.getOutputStream()) { o.write(bytes); }
        c.getResponseCode();
        c.disconnect();
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