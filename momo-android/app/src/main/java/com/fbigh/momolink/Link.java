package com.fbigh.momolink;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Everything the app does: decide which SMS are MoMo payments, keep them in a queue, and send them to Invoice Studio. */
final class Link {
    static final String VERSION = "1.0";
    // The custom domain first, then Railway's own address in case the domain has a problem.
    static final String[] BASE_URLS = {
            "https://invoice.fbigh.com",
            "https://fbi-invoice-studio-production.up.railway.app"
    };
    static final int JOB_PERIODIC = 4101;
    static final int JOB_NOW = 4102;

    private static final String PREFS = "fbi_momo_link";
    private static final Pattern MONEY_IN = Pattern.compile("(payment received for|cash in received for|you have received)", Pattern.CASE_INSENSITIVE);
    private static final Pattern AMOUNT = Pattern.compile("GHS\\s*([\\d,]+(?:\\.\\d{1,2})?)", Pattern.CASE_INSENSITIVE);

    private Link() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static String token(Context c) { return prefs(c).getString("token", ""); }
    static boolean linked(Context c) { return token(c).length() > 20; }

    /**
     * Only MoMo payment messages are ever sent. Messages from normal phone numbers are never forwarded,
     * so private texts stay on the phone and a fake "payment received" SMS from a number is ignored.
     */
    static boolean isMomoPayment(String sender, String body) {
        if (sender == null || body == null) return false;
        String s = sender.trim();
        if (s.isEmpty() || s.replaceAll("[^0-9]", "").length() >= 6) return false;
        return MONEY_IN.matcher(body).find();
    }

    static String amountOf(String body) {
        Matcher m = AMOUNT.matcher(body == null ? "" : body);
        return m.find() ? "GHS " + m.group(1) : "";
    }

    static String key(String sender, long when, String body) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-1");
            byte[] h = d.digest((sender + "|" + when + "|" + body).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 10; i++) sb.append(String.format("%02x", h[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString((sender + when + body).hashCode());
        }
    }

    /** Adds a payment SMS to the waiting list unless it was already sent or queued. */
    static synchronized boolean enqueue(Context c, String sender, String body, long when) {
        if (!isMomoPayment(sender, body)) return false;
        String k = key(sender, when, body);
        SharedPreferences p = prefs(c);
        Set<String> sent = p.getStringSet("sent_keys", new HashSet<>());
        if (sent.contains(k)) return false;
        try {
            JSONArray q = new JSONArray(p.getString("queue", "[]"));
            for (int i = 0; i < q.length(); i++) if (k.equals(q.getJSONObject(i).optString("ref"))) return false;
            JSONObject m = new JSONObject();
            m.put("ref", k); m.put("sender", sender); m.put("body", body); m.put("receivedAt", when);
            q.put(m);
            while (q.length() > 300) q.remove(0);
            p.edit().putString("queue", q.toString()).apply();
            addRecent(c, amountOf(body), when);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static int queued(Context c) {
        try { return new JSONArray(prefs(c).getString("queue", "[]")).length(); } catch (Exception e) { return 0; }
    }

    private static void addRecent(Context c, String amount, long when) {
        try {
            JSONArray r = new JSONArray(prefs(c).getString("recent", "[]"));
            JSONObject o = new JSONObject(); o.put("amount", amount); o.put("when", when);
            JSONArray out = new JSONArray(); out.put(o);
            for (int i = 0; i < r.length() && out.length() < 8; i++) out.put(r.get(i));
            prefs(c).edit().putString("recent", out.toString()).apply();
        } catch (Exception ignored) { }
    }

    /** Looks through the SMS inbox for payment messages the receiver may have missed (phone off, app updated…). */
    static int scanInbox(Context c, long sinceMs) {
        int added = 0;
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(Uri.parse("content://sms/inbox"),
                    new String[]{"address", "body", "date"}, "date > ?", new String[]{String.valueOf(sinceMs)}, "date ASC");
            if (cur == null) return 0;
            while (cur.moveToNext()) {
                if (enqueue(c, cur.getString(0), cur.getString(1), cur.getLong(2))) added++;
            }
        } catch (SecurityException se) {
            return -1;
        } catch (Exception ignored) {
        } finally {
            if (cur != null) cur.close();
        }
        return added;
    }

    /** Sends everything waiting, then checks in. Returns a short status line for the screen. */
    static synchronized String sync(Context c) {
        if (!linked(c)) return "Not linked yet";
        SharedPreferences p = prefs(c);
        long first = p.getLong("first_scan_done", 0);
        long since = first == 0 ? System.currentTimeMillis() - 7L * 86400000L : System.currentTimeMillis() - 3L * 86400000L;
        scanInbox(c, since);
        if (first == 0) p.edit().putLong("first_scan_done", System.currentTimeMillis()).apply();
        int sent = 0;
        try {
            JSONArray q = new JSONArray(p.getString("queue", "[]"));
            for (int start = 0; start < q.length(); start += 50) {
                JSONArray batch = new JSONArray();
                for (int i = start; i < Math.min(q.length(), start + 50); i++) batch.put(q.get(i));
                JSONObject body = new JSONObject();
                body.put("appVersion", VERSION);
                body.put("messages", batch);
                JSONObject res = post(c, "/api/momo/sms", body);
                Set<String> done = new HashSet<>(p.getStringSet("sent_keys", new HashSet<>()));
                JSONArray results = res.optJSONArray("results");
                for (int i = 0; results != null && i < results.length(); i++) {
                    String ref = results.getJSONObject(i).optString("ref");
                    if (!ref.isEmpty()) done.add(ref);
                    if (results.getJSONObject(i).optBoolean("stored")) sent++;
                }
                if (done.size() > 2000) done = new HashSet<>(); // keep the list small; the server ignores repeats anyway
                p.edit().putStringSet("sent_keys", done).apply();
            }
            // Everything above was accepted, so the queue can be cleared.
            JSONArray left = new JSONArray();
            Set<String> done = p.getStringSet("sent_keys", new HashSet<>());
            JSONArray now = new JSONArray(p.getString("queue", "[]"));
            for (int i = 0; i < now.length(); i++) if (!done.contains(now.getJSONObject(i).optString("ref"))) left.put(now.get(i));
            p.edit().putString("queue", left.toString()).apply();
            JSONObject hb = new JSONObject(); hb.put("appVersion", VERSION);
            post(c, "/api/momo/heartbeat", hb);
            p.edit().putLong("last_ok", System.currentTimeMillis()).putString("last_error", "").apply();
            return sent > 0 ? sent + " new payment" + (sent == 1 ? "" : "s") + " sent" : "Up to date";
        } catch (Unlinked u) {
            p.edit().remove("token").apply();
            return "This phone was unlinked in Invoice Studio. Link it again.";
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.toString() : e.getMessage();
            p.edit().putString("last_error", msg).apply();
            return "Could not reach Invoice Studio. Will retry. (" + msg + ")";
        }
    }

    static final class Unlinked extends Exception { Unlinked() { super("unlinked"); } }

    static JSONObject post(Context c, String path, JSONObject body) throws Exception {
        Exception last = null;
        for (String base : BASE_URLS) {
            HttpURLConnection h = null;
            try {
                h = (HttpURLConnection) new URL(base + path).openConnection();
                h.setRequestMethod("POST");
                h.setConnectTimeout(20000);
                h.setReadTimeout(30000);
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                h.setRequestProperty("Accept", "application/json");
                h.setRequestProperty("User-Agent", "FBI-MoMo-Link/" + VERSION + " (Android " + Build.VERSION.RELEASE + ")");
                String t = token(c);
                if (!t.isEmpty()) h.setRequestProperty("Authorization", "Bearer " + t);
                try (OutputStream o = h.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                int code = h.getResponseCode();
                String text = read(code >= 400 ? h.getErrorStream() : h.getInputStream());
                JSONObject out;
                try { out = new JSONObject(text); } catch (Exception e) { out = new JSONObject(); }
                if (code == 401 && path.startsWith("/api/momo/sms") || code == 401 && path.startsWith("/api/momo/heartbeat")) throw new Unlinked();
                if (code >= 200 && code < 300) return out;
                // A clear answer from the app (wrong code, etc.) is final; network or edge errors try the next address.
                if (out.has("error") && code < 500 && code != 429) throw new IllegalStateException(out.optString("error"));
                last = new IllegalStateException("HTTP " + code);
            } catch (Unlinked | IllegalStateException e) {
                if (e instanceof Unlinked || !e.getMessage().startsWith("HTTP ")) throw e;
                last = e;
            } catch (Exception e) {
                last = e;
            } finally {
                if (h != null) h.disconnect();
            }
        }
        throw last == null ? new IllegalStateException("No connection") : last;
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder s = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line; while ((line = r.readLine()) != null) s.append(line);
        }
        return s.toString();
    }

    /** Pairs this phone using the 6-digit code from Invoice Studio. */
    static String pair(Context c, String code) throws Exception {
        JSONObject b = new JSONObject();
        b.put("code", code);
        b.put("deviceName", (Build.MANUFACTURER + " " + Build.MODEL).trim());
        b.put("appVersion", VERSION);
        JSONObject res = post(c, "/api/momo/pair", b);
        String t = res.optString("token", "");
        if (t.length() < 20) throw new IllegalStateException(res.optString("error", "Linking failed"));
        prefs(c).edit().putString("token", t).putLong("first_scan_done", 0).putStringSet("sent_keys", new HashSet<>()).apply();
        return res.optString("deviceName", "this phone");
    }

    /** Checks in every 15 minutes (when there is internet), also after a restart. */
    static void schedulePeriodic(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        JobInfo info = new JobInfo.Builder(JOB_PERIODIC, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(info);
    }

    /** Sends as soon as there is internet. */
    static void syncSoon(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        JobInfo info = new JobInfo.Builder(JOB_NOW, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build();
        js.schedule(info);
    }
}
