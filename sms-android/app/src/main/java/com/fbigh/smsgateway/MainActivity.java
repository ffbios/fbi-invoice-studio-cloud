package com.fbigh.smsgateway;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int SMS_PERMISSION = 1001;
    private static final String BASE_URL = "https://invoice.fbigh.com";
    private static final String PREFS = "fbi_sms_gateway";
    private static final String KEY_TOKEN = "gateway_token";
    private static final String KEY_GATEWAY_ID = "gateway_id";
    private TextView status;
    private Button pairButton;
    private Button startButton;
    private EditText codeInput;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        ensureGatewayId();
        buildUi();
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.SEND_SMS}, SMS_PERMISSION);
        }
        refreshUi();
    }

    private void ensureGatewayId() {
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).contains(KEY_GATEWAY_ID)) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_GATEWAY_ID, UUID.randomUUID().toString())
                    .apply();
        }
    }

    private boolean isPaired() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TOKEN, "").trim().length() > 20;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(28, 36, 28, 28);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.rgb(11,11,13));

        TextView title = new TextView(this);
        title.setText("FBI SMS GATEWAY");
        title.setTextColor(Color.rgb(212,175,55));
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView sub = new TextView(this);
        sub.setText("Private company SMS gateway\nUses the SIM card in this phone");
        sub.setTextColor(Color.LTGRAY);
        sub.setTextSize(14);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-1,-2);
        sp.setMargins(0,12,0,18);
        root.addView(sub, sp);

        status = new TextView(this);
        status.setText("STATUS: CHECKING");
        status.setTextColor(Color.WHITE);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        root.addView(status, new LinearLayout.LayoutParams(-1, 60));

        TextView pairLabel = new TextView(this);
        pairLabel.setText("PAIR THIS PHONE");
        pairLabel.setTextColor(Color.rgb(212,175,55));
        pairLabel.setTextSize(14);
        pairLabel.setGravity(Gravity.CENTER);
        root.addView(pairLabel, new LinearLayout.LayoutParams(-1, -2));

        codeInput = new EditText(this);
        codeInput.setHint("Enter 6-digit pairing code");
        codeInput.setInputType(2);
        codeInput.setTextColor(Color.WHITE);
        codeInput.setHintTextColor(Color.GRAY);
        codeInput.setGravity(Gravity.CENTER);
        root.addView(codeInput, new LinearLayout.LayoutParams(-1, 58));

        pairButton = new Button(this);
        pairButton.setText("PAIR PHONE");
        pairButton.setOnClickListener(v -> pairPhone());
        root.addView(pairButton, new LinearLayout.LayoutParams(-1, 58));

        startButton = new Button(this);
        startButton.setText("START GATEWAY");
        startButton.setOnClickListener(v -> startGateway());
        LinearLayout.LayoutParams sb = new LinearLayout.LayoutParams(-1, 58);
        sb.setMargins(0, 10, 0, 0);
        root.addView(startButton, sb);

        TextView info = new TextView(this);
        info.setText("\nOn your computer, sign in to Invoice Studio and open:\n/sms-gateway-pair\n\nEnter the displayed code here. Then keep this phone connected to mobile data and charging.");
        info.setTextColor(Color.GRAY);
        info.setTextSize(12);
        info.setGravity(Gravity.CENTER);
        root.addView(info, new LinearLayout.LayoutParams(-1,-2));

        setContentView(root);
    }

    private void refreshUi() {
        if (isPaired()) {
            status.setText("STATUS: PAIRED");
            pairButton.setText("PAIRED");
            pairButton.setEnabled(false);
            codeInput.setEnabled(false);
            startButton.setEnabled(true);
        } else {
            status.setText("STATUS: NOT PAIRED");
            pairButton.setText("PAIR PHONE");
            pairButton.setEnabled(true);
            codeInput.setEnabled(true);
            startButton.setEnabled(false);
        }
    }

    private void pairPhone() {
        final String code = codeInput.getText().toString().replaceAll("\\D", "");
        if (!code.matches("\\d{6}")) {
            status.setText("STATUS: ENTER 6 DIGITS");
            return;
        }
        pairButton.setEnabled(false);
        status.setText("STATUS: PAIRING...");
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                JSONObject body = new JSONObject();
                body.put("code", code);
                body.put("gatewayId", getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GATEWAY_ID, ""));
                body.put("gatewayName", "FBI Android SMS Gateway");
                c = (HttpURLConnection) new URL(BASE_URL + "/api/sms/gateway/pair").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                int response = c.getResponseCode();
                java.io.InputStream in = response >= 200 && response < 300 ? c.getInputStream() : c.getErrorStream();
                String raw = new java.io.BufferedReader(new java.io.InputStreamReader(in, StandardCharsets.UTF_8)).lines().reduce("", (a,b) -> a+b);
                JSONObject result = new JSONObject(raw);
                if (response == 200 && result.optBoolean("ok") && result.optString("token").length() > 20) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString(KEY_TOKEN, result.getString("token"))
                            .apply();
                    runOnUiThread(() -> { status.setText("STATUS: PAIRED SUCCESSFULLY"); refreshUi(); });
                } else {
                    final String msg = result.optString("error", "Pairing failed.");
                    runOnUiThread(() -> { status.setText("STATUS: " + msg.toUpperCase()); pairButton.setEnabled(true); });
                }
            } catch (Throwable t) {
                runOnUiThread(() -> { status.setText("STATUS: NETWORK ERROR"); pairButton.setEnabled(true); });
            } finally {
                if (c != null) c.disconnect();
            }
        }, "fbi-pair").start();
    }

    private void startGateway() {
        if (!isPaired()) {
            status.setText("STATUS: PAIR PHONE FIRST");
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.SEND_SMS}, SMS_PERMISSION);
            return;
        }
        startForegroundService(new Intent(this, GatewayService.class));
        status.setText("STATUS: RUNNING");
        startButton.setText("GATEWAY RUNNING");
    }

    @Override public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r,p,g);
        if (r == SMS_PERMISSION && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
            status.setText("STATUS: SMS PERMISSION READY");
        } else if (r == SMS_PERMISSION) {
            status.setText("STATUS: SMS PERMISSION REQUIRED");
        }
        refreshUi();
    }
}