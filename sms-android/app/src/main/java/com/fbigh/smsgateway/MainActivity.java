package com.fbigh.smsgateway;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int SMS_PERMISSION = 1001;
    private TextView status;
    private Button startButton;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        buildUi();
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.SEND_SMS}, SMS_PERMISSION);
        }
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
        sp.setMargins(0,12,0,24);
        root.addView(sub, sp);

        status = new TextView(this);
        status.setText("STATUS: READY");
        status.setTextColor(Color.WHITE);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        root.addView(status, new LinearLayout.LayoutParams(-1, 70));

        startButton = new Button(this);
        startButton.setText("START GATEWAY");
        startButton.setOnClickListener(v -> startGateway());
        root.addView(startButton, new LinearLayout.LayoutParams(-1, 58));

        TextView info = new TextView(this);
        info.setText("\nKeep this phone connected to mobile data and charging.\nThe gateway checks the Invoice Studio queue and sends approved SMS jobs through the active SIM.");
        info.setTextColor(Color.GRAY);
        info.setTextSize(12);
        info.setGravity(Gravity.CENTER);
        root.addView(info, new LinearLayout.LayoutParams(-1,-2));

        setContentView(root);
    }

    private void startGateway() {
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
    }
}