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
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.OAEPParameterSpec;
import java.security.spec.PSource;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.Cipher;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int SMS_PERMISSION = 1001;
    // Railway's HTTP edge is returning 429 for automated pairing requests.
    // Pairing uses the dedicated raw TCP proxy; the gateway token is RSA-encrypted
    // to a one-time phone key before it crosses that connection.
    private static final String PAIR_TCP_BASE = "http://thomas.proxy.rlwy.net:27251";
    private static final String PAIR_BOOTSTRAP_PATH = "/api/sms/gateway/pair-bootstrap";
    private static final String PAIR_EXCHANGE_PATH = "/api/sms/gateway/pair-exchange";
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
            try {
                if (gatewayId.isEmpty()) throw new IllegalStateException("Gateway ID is missing.");

                KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
                generator.initialize(2048);
                KeyPair keyPair = generator.generateKeyPair();

                String secret = UUID.randomUUID().toString() + UUID.randomUUID();
                String secretHash = sha256Hex(secret);
                String publicKey = Base64.getEncoder().encodeToString(keyPair.getPublic().getEncoded());

                HttpURLConnection bootstrap = null;
                try {
                    bootstrap = (HttpURLConnection) new URL(PAIR_TCP_BASE + PAIR_BOOTSTRAP_PATH).openConnection();
                    bootstrap.setRequestMethod("GET");
                    bootstrap.setConnectTimeout(15000);
                    bootstrap.setReadTimeout(15000);
                    bootstrap.setDoInput(true);
                    bootstrap.setUseCaches(false);
                    bootstrap.setRequestProperty("Accept", "application/json");
                    bootstrap.setRequestProperty("Cache-Control", "no-cache");
                    bootstrap.setRequestProperty("X-FBI-Pair-Code", code);
                    bootstrap.setRequestProperty("X-FBI-Gateway-Id", gatewayId);
                    bootstrap.setRequestProperty("X-FBI-Gateway-Name", "FBI Android SMS Gateway");
                    bootstrap.setRequestProperty("X-FBI-Pair-Secret-Hash", secretHash);
                    bootstrap.setRequestProperty("X-FBI-Pair-Public-Key", publicKey);
                    bootstrap.setRequestProperty("User-Agent", "FBI-SMS-Gateway-Android/14");

                    int response = bootstrap.getResponseCode();
                    String raw = readResponse(bootstrap, response);
                    JSONObject result = parsePairResponse(raw);
                    if (response != 200 || !result.optBoolean("ok")) {
                        String error = result.optString("error", raw.trim());
                        throw new IllegalStateException("Bootstrap HTTP " + response + " → " + error);
                    }

                    String exchangeId = result.optString("exchangeId", "").trim();
                    if (exchangeId.isEmpty()) throw new IllegalStateException("Bootstrap did not return an exchange ID.");

                    HttpURLConnection exchange = null;
                    try {
                        String exchangeUrl = PAIR_TCP_BASE + PAIR_EXCHANGE_PATH
                                + "?exchangeId=" + java.net.URLEncoder.encode(exchangeId, "UTF-8");
                        exchange = (HttpURLConnection) new URL(exchangeUrl).openConnection();
                        exchange.setRequestMethod("GET");
                        exchange.setConnectTimeout(15000);
                        exchange.setReadTimeout(15000);
                        exchange.setDoInput(true);
                        exchange.setUseCaches(false);
                        exchange.setRequestProperty("Accept", "application/json");
                        exchange.setRequestProperty("Cache-Control", "no-cache");
                        exchange.setRequestProperty("User-Agent", "FBI-SMS-Gateway-Android/14");

                        int exchangeResponse = exchange.getResponseCode();
                        String exchangeRaw = readResponse(exchange, exchangeResponse);
                        JSONObject exchangeResult = parsePairResponse(exchangeRaw);
                        if (exchangeResponse != 200 || !exchangeResult.optBoolean("ok")) {
                            String error = exchangeResult.optString("error", exchangeRaw.trim());
                            throw new IllegalStateException("Exchange HTTP " + exchangeResponse + " → " + error);
                        }

                        String encrypted = exchangeResult.optString("encryptedToken", "").trim();
                        if (encrypted.isEmpty()) throw new IllegalStateException("Encrypted gateway token was not returned.");

                        String token = decryptToken(encrypted, keyPair);
                        if (token.length() < 20) throw new IllegalStateException("Decrypted gateway token is invalid.");

                        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                .putString(KEY_TOKEN, token).apply();

                        runOnUiThread(() -> {
                            status.setText("PAIRED • READY");
                            refreshUi();
                        });
                        return;
                    } finally {
                        if (exchange != null) exchange.disconnect();
                    }
                } finally {
                    if (bootstrap != null) bootstrap.disconnect();
                }
            } catch (Throwable t) {
                lastDetail = t.getMessage() == null ? t.toString() : t.getMessage();
            }

            final String detail = lastDetail;
            runOnUiThread(() -> {
                status.setText(("PAIRING FAILED • " + detail).toUpperCase());
                pairButton.setEnabled(true);
            });
        }, "fbi-pair").start();
    }

    private static String sha256Hex(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(digest.length * 2);
        for (byte b : digest) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }

    private static String readResponse(HttpURLConnection c, int response) throws Exception {
        java.io.InputStream in = response >= 200 && response < 400
                ? c.getInputStream() : c.getErrorStream();
        if (in == null) return "";
        return new java.io.BufferedReader(new java.io.InputStreamReader(in, StandardCharsets.UTF_8))
                .lines().collect(java.util.stream.Collectors.joining());
    }

    private static String decryptToken(String encryptedBase64, KeyPair keyPair) throws Exception {
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        OAEPParameterSpec spec = new OAEPParameterSpec(
                "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);
        cipher.init(Cipher.DECRYPT_MODE, keyPair.getPrivate(), spec);
        byte[] encrypted = Base64.getDecoder().decode(encryptedBase64);
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
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