package com.fbigh.smsgateway;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int SMS_PERMISSION = 1001;
    // Pairing uses GET + private headers to avoid the Railway edge POST 429.
    // Keep the Railway service domain first, with the custom domain as fallback.
    private static final String[] PAIR_PATHS = {"/api/sms/gateway/pair-v2", "/sms-gateway-pair"};
    private static final String[] BASE_URLS = {
            "https://fbi-invoice-studio-production.up.railway.app",
            "https://invoice.fbigh.com"
    };
    private static final String PREFS = "fbi_sms_gateway";
    private static final String KEY_TOKEN = "gateway_token";
    private static final String KEY_GATEWAY_ID = "gateway_id";

    private TextView status;
    private TextView permissionStatus;
    private Button permissionButton;
    private Button pairButton;
    private Button startButton;
    private EditText codeInput;

    private int gold() { return Color.rgb(212,175,55); }
    private int bg() { return Color.rgb(10,10,12); }
    private int card() { return Color.rgb(23,23,27); }
    private int white() { return Color.rgb(245,245,247); }
    private int muted() { return Color.rgb(175,175,182); }

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(bg());
        getWindow().setNavigationBarColor(bg());
        ensureGatewayId();
        buildUi();
        refreshUi();
    }

    private void ensureGatewayId() {
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).contains(KEY_GATEWAY_ID)) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_GATEWAY_ID, UUID.randomUUID().toString()).apply();
        }
    }

    private boolean isPaired() {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(KEY_TOKEN, "").trim().length() > 20;
    }

    private boolean hasSmsPermission() {
        return android.os.Build.VERSION.SDK_INT < 23 ||
                checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    private GradientDrawable rounded(int color, int strokeColor) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(22);
        d.setStroke(1, strokeColor);
        return d;
    }

    private TextView label(String text, int size, int color) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextColor(color);
        v.setTextSize(size);
        return v;
    }

    private Button actionButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(14);
        b.setTextColor(bg());
        b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setMinHeight(54);
        b.setPadding(18, 8, 18, 8);
        GradientDrawable d = rounded(gold(), gold());
        b.setBackground(d);
        return b;
    }

    private LinearLayout cardLayout() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(20,20,20,20);
        c.setBackground(rounded(card(), Color.rgb(48,48,54)));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1,-2);
        p.setMargins(0,0,0,14);
        c.setLayoutParams(p);
        return c;
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(bg());

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int top = 34;
        root.setPadding(20, top, 20, 28);

        TextView brand = label("FILM BEYOND IMAGINATION", 12, gold());
        brand.setGravity(Gravity.CENTER);
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(brand, new LinearLayout.LayoutParams(-1,28));

        TextView title = label("FBI SMS GATEWAY", 28, white());
        title.setGravity(Gravity.CENTER);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(title, new LinearLayout.LayoutParams(-1,50));

        TextView sub = label("Private company SMS gateway\nThis phone provides the GSM/SIM connection.", 14, muted());
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-1,-2);
        sp.setMargins(0,0,0,18);
        root.addView(sub, sp);

        LinearLayout statusCard = cardLayout();
        TextView stitle = label("GATEWAY STATUS", 12, gold());
        stitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        statusCard.addView(stitle);
        status = label("CHECKING…", 20, white());
        status.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        status.setPadding(0,8,0,2);
        statusCard.addView(status);
        root.addView(statusCard);

        LinearLayout permCard = cardLayout();
        TextView pt = label("1. SMS PERMISSION", 15, white());
        pt.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        permCard.addView(pt);
        permissionStatus = label("", 13, muted());
        permissionStatus.setPadding(0,8,0,12);
        permCard.addView(permissionStatus);
        permissionButton = actionButton("GRANT SMS ACCESS");
        permissionButton.setOnClickListener(v -> handlePermission());
        permCard.addView(permissionButton);
        TextView hint = label("On this phone, Android may require: Settings → Apps → FBI SMS Gateway → ⋮ → Allow restricted settings → Permissions → SMS → Allow.", 12, muted());
        hint.setPadding(0,12,0,0);
        permCard.addView(hint);
        root.addView(permCard);

        LinearLayout pairCard = cardLayout();
        TextView pairTitle = label("2. PAIR THIS PHONE", 15, white());
        pairTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        pairCard.addView(pairTitle);

        TextView pairHint = label("On a computer, sign in to Invoice Studio and open /sms-gateway-pair. Enter the 6-digit code shown there.", 13, muted());
        pairHint.setPadding(0,8,0,12);
        pairCard.addView(pairHint);

        codeInput = new EditText(this);
        codeInput.setHint("6-digit pairing code");
        codeInput.setHintTextColor(Color.rgb(120,120,126));
        codeInput.setTextColor(white());
        codeInput.setTextSize(18);
        codeInput.setInputType(2);
        codeInput.setGravity(Gravity.CENTER);
        codeInput.setSingleLine(true);
        codeInput.setPadding(16,0,16,0);
        codeInput.setBackground(rounded(Color.rgb(13,13,16), Color.rgb(70,70,78)));
        pairCard.addView(codeInput, new LinearLayout.LayoutParams(-1,58));

        pairButton = actionButton("PAIR PHONE");
        pairButton.setOnClickListener(v -> pairPhone());
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(-1,58);
        pp.setMargins(0,12,0,0);
        pairCard.addView(pairButton, pp);
        root.addView(pairCard);

        LinearLayout startCard = cardLayout();
        TextView startTitle = label("3. START SMS GATEWAY", 15, white());
        startTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        startCard.addView(startTitle);
        TextView startHint = label("Once permission and pairing are complete, start the gateway and keep this phone on mobile data and charging.", 13, muted());
        startHint.setPadding(0,8,0,12);
        startCard.addView(startHint);
        startButton = actionButton("START GATEWAY");
        startButton.setOnClickListener(v -> startGateway());
        startCard.addView(startButton);
        root.addView(startCard);

        TextView footer = label("FBI Private SMS Gateway • No third-party SMS provider", 11, Color.rgb(110,110,116));
        footer.setGravity(Gravity.CENTER);
        root.addView(footer, new LinearLayout.LayoutParams(-1,42));

        scroll.addView(root);
        setContentView(scroll);
    }

    private void handlePermission() {
        if (hasSmsPermission()) {
            refreshUi();
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            requestPermissions(new String[]{Manifest.permission.SEND_SMS}, SMS_PERMISSION);
        }
    }

    private void openAppSettings() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        i.setData(Uri.parse("package:" + getPackageName()));
        startActivity(i);
    }

    private void refreshUi() {
        boolean permitted = hasSmsPermission();
        permissionStatus.setText(permitted
                ? "SMS access is enabled. The phone can send SMS."
                : "SMS access is blocked. Android is protecting this sensitive permission.");
        permissionButton.setText(permitted ? "SMS ACCESS ENABLED" : "GRANT / OPEN SMS SETTINGS");
        permissionButton.setEnabled(!permitted);

        if (!permitted) {
            status.setText("WAITING FOR SMS PERMISSION");
        } else if (isPaired()) {
            status.setText("PAIRED • READY");
        } else {
            status.setText("NOT PAIRED");
        }

        pairButton.setEnabled(true);
        codeInput.setEnabled(true);
        startButton.setEnabled(permitted && isPaired());
        startButton.setText(permitted && isPaired() ? "START GATEWAY" : "COMPLETE STEPS 1 + 2");
    }

    private JSONObject parsePairResponse(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) return new JSONObject();
        try {
            JSONObject direct = new JSONObject(text);
            direct.put("_raw", text);
            return direct;
        } catch (Throwable ignored) {
            // Some proxies/older gateways return a JSON string containing the
            // actual JSON object. Unwrap that safely instead of crashing.
            try {
                Object value = new org.json.JSONTokener(text).nextValue();
                if (value instanceof String) {
                    String nested = ((String) value).trim();
                    try {
                        JSONObject nestedObject = new JSONObject(nested);
                        nestedObject.put("_raw", text);
                        return nestedObject;
                    } catch (Throwable ignoredNested) {
                        JSONObject out = new JSONObject();
                        out.put("error", nested);
                        out.put("_raw", text);
                        return out;
                    }
                }
            } catch (Throwable ignoredString) {
                // Fall through to a diagnostic object below.
            }
            try {
                JSONObject out = new JSONObject();
                out.put("error", text);
                out.put("_raw", text);
                return out;
            } catch (Throwable ignoredFinal) {
                return new JSONObject();
            }
        }
    }

    private void pairPhone() {
        final String code = codeInput.getText().toString().replaceAll("\\D", "");
        if (!code.matches("\\d{6}")) {
            status.setText("ENTER THE 6-DIGIT CODE");
            return;
        }
        pairButton.setEnabled(false);
        status.setText("PAIRING…");
        new Thread(() -> {
            String lastDetail = "Unable to reach the SMS gateway.";
            final String gatewayId = getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getString(KEY_GATEWAY_ID, "");
            // Try the Railway-generated host first, then the custom domain,
            // and try both supported GET pairing paths.
            boolean paired = false;
            outer:
            for (String base : BASE_URLS) {
                for (String pairPath : PAIR_PATHS) {
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(base + pairPath).openConnection();
                        c.setRequestMethod("GET");
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(15000);
                        c.setDoInput(true);
                        c.setUseCaches(false);
                        c.setRequestProperty("Accept", "application/json");
                        c.setRequestProperty("Cache-Control", "no-cache");
                        c.setRequestProperty("X-FBI-Pair-Code", code);
                        c.setRequestProperty("X-FBI-Gateway-Id", gatewayId);
                        c.setRequestProperty("X-FBI-Gateway-Name", "FBI Android SMS Gateway");
                        c.setRequestProperty("User-Agent", "FBI-SMS-Gateway-Android/10");

                        int response = c.getResponseCode();
                        java.io.InputStream in = response >= 200 && response < 400
                                ? c.getInputStream() : c.getErrorStream();
                        String raw = in == null ? "" : new java.io.BufferedReader(
                                new java.io.InputStreamReader(in, StandardCharsets.UTF_8))
                                .lines().collect(java.util.stream.Collectors.joining());
                        JSONObject result = parsePairResponse(raw);

                        if (response == 200 && result.optBoolean("ok")
                                && result.optString("token").length() > 20) {
                            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                    .putString(KEY_TOKEN, result.getString("token")).apply();
                            paired = true;
                            runOnUiThread(() -> {
                                status.setText("PAIRED • READY");
                                refreshUi();
                            });
                            break outer;
                        }

                        String serverError = result.optString("error", "").trim();
                        if (serverError.isEmpty()) serverError = raw.trim();
                        if (serverError.isEmpty()) serverError = "Empty response.";
                        lastDetail = base + pairPath + " → HTTP " + response + " → " + serverError;
                    } catch (Throwable t) {
                        lastDetail = base + pairPath + " → " + String.valueOf(t.getMessage());
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
            }

            if (paired) return;

            final String detail = lastDetail;
            runOnUiThread(() -> {
                status.setText(("PAIRING FAILED • " + detail).toUpperCase());
                pairButton.setEnabled(true);
            });
        }, "fbi-pair").start();
    }

    private void startGateway() {
        if (!hasSmsPermission()) {
            openAppSettings();
            return;
        }
        if (!isPaired()) {
            status.setText("PAIR PHONE FIRST");
            return;
        }
        startForegroundService(new Intent(this, GatewayService.class));
        status.setText("GATEWAY RUNNING");
        startButton.setText("GATEWAY RUNNING");
    }

    @Override protected void onResume() {
        super.onResume();
        if (status != null) refreshUi();
    }

    @Override public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r,p,g);
        if (r == SMS_PERMISSION && (g.length == 0 || g[0] != PackageManager.PERMISSION_GRANTED)) {
            status.setText("SMS ACCESS STILL BLOCKED");
            permissionButton.setText("OPEN PHONE APP SETTINGS");
            permissionButton.setEnabled(true);
            permissionButton.setOnClickListener(v -> openAppSettings());
        }
        refreshUi();
    }
}