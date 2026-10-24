package com.fbigh.momolink;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int REQ_SMS = 7;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView statusTitle, statusText, permText, recentText, footText;
    private View permCard, linkCard, workingCard;
    private Button permButton, settingsButton, linkButton, syncButton, unlinkButton;
    private EditText codeInput;

    private static final int BG = Color.rgb(10, 10, 12), CARD = Color.rgb(23, 23, 27), GOLD = Color.rgb(212, 175, 55),
            WHITE = Color.rgb(245, 245, 247), MUTED = Color.rgb(170, 170, 178), OK = Color.rgb(79, 212, 155), BAD = Color.rgb(255, 132, 151);

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        buildUi();
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
        if (Link.linked(this) && hasSms()) { Link.schedulePeriodic(this); runSync(false); }
    }

    private boolean hasSms() {
        return checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    private void refresh() {
        boolean perm = hasSms(), linked = Link.linked(this);
        permCard.setVisibility(perm ? View.GONE : View.VISIBLE);
        linkCard.setVisibility(perm && !linked ? View.VISIBLE : View.GONE);
        workingCard.setVisibility(perm && linked ? View.VISIBLE : View.GONE);
        long last = Link.prefs(this).getLong("last_ok", 0);
        String err = Link.prefs(this).getString("last_error", "");
        if (!perm) { statusTitle.setText("Step 1 of 2"); statusTitle.setTextColor(GOLD); statusText.setText("Allow this app to read your MoMo messages."); }
        else if (!linked) { statusTitle.setText("Step 2 of 2"); statusTitle.setTextColor(GOLD); statusText.setText("Link this phone to Invoice Studio."); }
        else if (!err.isEmpty() && System.currentTimeMillis() - last > 30 * 60 * 1000L) { statusTitle.setText("Waiting for internet"); statusTitle.setTextColor(BAD); statusText.setText("Payments are saved on the phone and will be sent when it connects."); }
        else { statusTitle.setText("Working"); statusTitle.setTextColor(OK); statusText.setText("New MoMo payments go to Invoice Studio automatically. You can close this app."); }
        int q = Link.queued(this);
        footText.setText((last > 0 ? "Last sent: " + fmt(last) : "Not sent yet") + (q > 0 ? " · " + q + " waiting" : ""));
        StringBuilder r = new StringBuilder();
        try {
            JSONArray a = new JSONArray(Link.prefs(this).getString("recent", "[]"));
            for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); r.append("•  ").append(o.optString("amount")).append("   ").append(fmt(o.optLong("when"))).append("\n"); }
        } catch (Exception ignored) { }
        recentText.setText(r.length() == 0 ? "No MoMo payments seen yet." : r.toString().trim());
    }

    private String fmt(long ms) { return new SimpleDateFormat("d MMM, HH:mm", Locale.UK).format(new Date(ms)); }

    private void askSms() {
        if (hasSms()) { refresh(); return; }
        requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS}, REQ_SMS);
    }

    @Override public void onRequestPermissionsResult(int code, String[] p, int[] res) {
        super.onRequestPermissionsResult(code, p, res);
        if (!hasSms()) {
            permText.setText("Android blocked the SMS permission. This happens with apps installed outside the Play Store.\n\n"
                    + "1. Tap “Open app settings” below.\n2. Tap the ⋮ menu (top right) → “Allow restricted settings” and confirm.\n"
                    + "3. Go to Permissions → SMS → Allow.\n4. Come back to this app.");
            settingsButton.setVisibility(View.VISIBLE);
        }
        refresh();
    }

    private void doLink() {
        String code = codeInput.getText().toString().replaceAll("\\D", "");
        if (code.length() != 6) { toast("Type the 6-digit code from Invoice Studio"); return; }
        InputMethodManager im = getSystemService(InputMethodManager.class);
        if (im != null) im.hideSoftInputFromWindow(codeInput.getWindowToken(), 0);
        linkButton.setEnabled(false); linkButton.setText("Linking…");
        new Thread(() -> {
            String msg;
            try {
                String name = Link.pair(this, code);
                Link.schedulePeriodic(this);
                String s = Link.sync(this);
                msg = "Linked as " + name + ". " + s;
            } catch (Exception e) {
                msg = e.getMessage() == null ? "Linking failed" : e.getMessage();
            }
            String m = msg;
            ui.post(() -> { linkButton.setEnabled(true); linkButton.setText("Link phone"); codeInput.setText(""); toast(m); refresh(); });
        }, "fbi-momo-link").start();
    }

    private void runSync(boolean show) {
        if (show) { syncButton.setEnabled(false); syncButton.setText("Sending…"); }
        new Thread(() -> {
            String s = Link.sync(this);
            ui.post(() -> { syncButton.setEnabled(true); syncButton.setText("Send now"); if (show) toast(s); refresh(); });
        }, "fbi-momo-sync-now").start();
    }

    private void unlink() {
        new android.app.AlertDialog.Builder(this).setTitle("Unlink this phone?")
                .setMessage("MoMo payments will stop going to Invoice Studio until you link it again.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Unlink", (d, w) -> { Link.prefs(this).edit().remove("token").apply(); refresh(); })
                .show();
    }

    private void toast(String s) { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show(); }

    // ---------- layout ----------
    private GradientDrawable box(int fill, int stroke) { GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(dp(16)); d.setStroke(dp(1), stroke); return d; }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private TextView text(String s, int sp, int color, boolean bold) { TextView t = new TextView(this); t.setText(s); t.setTextSize(sp); t.setTextColor(color); if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD); t.setLineSpacing(0, 1.15f); return t; }
    private Button button(String s, boolean primary) {
        Button b = new Button(this); b.setText(s); b.setAllCaps(false); b.setTextSize(16); b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setTextColor(primary ? BG : WHITE); b.setBackground(box(primary ? GOLD : CARD, primary ? GOLD : Color.rgb(70, 70, 78)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(52)); lp.topMargin = dp(12); b.setLayoutParams(lp); return b;
    }
    private LinearLayout card(LinearLayout root) {
        LinearLayout c = new LinearLayout(this); c.setOrientation(LinearLayout.VERTICAL); c.setPadding(dp(18), dp(18), dp(18), dp(18));
        c.setBackground(box(CARD, Color.rgb(48, 48, 54)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.bottomMargin = dp(14); root.addView(c, lp); return c;
    }

    private void buildUi() {
        getWindow().setStatusBarColor(BG);
        ScrollView sv = new ScrollView(this); sv.setBackgroundColor(BG); sv.setFillViewport(true);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(18), dp(28), dp(18), dp(28));
        sv.addView(root);

        TextView brand = text("FILM BEYOND IMAGINATION", 12, GOLD, true); brand.setGravity(Gravity.CENTER); root.addView(brand);
        TextView title = text("FBI MoMo Link", 28, WHITE, true); title.setGravity(Gravity.CENTER); title.setPadding(0, dp(4), 0, dp(4)); root.addView(title);
        TextView sub = text("Sends MTN MoMo “Payment received” messages from this phone to Invoice Studio. Other messages never leave the phone.", 14, MUTED, false);
        sub.setGravity(Gravity.CENTER); sub.setPadding(0, 0, 0, dp(18)); root.addView(sub);

        LinearLayout st = card(root);
        statusTitle = text("", 22, OK, true); st.addView(statusTitle);
        statusText = text("", 15, WHITE, false); statusText.setPadding(0, dp(6), 0, 0); st.addView(statusText);

        LinearLayout pc = card(root); permCard = pc;
        pc.addView(text("Allow SMS access", 17, WHITE, true));
        permText = text("The app reads only MoMo payment messages from MTN. Tap the button and choose Allow.", 14, MUTED, false);
        permText.setPadding(0, dp(8), 0, 0); pc.addView(permText);
        permButton = button("Allow SMS access", true); permButton.setOnClickListener(v -> askSms()); pc.addView(permButton);
        settingsButton = button("Open app settings", false); settingsButton.setVisibility(View.GONE);
        settingsButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        pc.addView(settingsButton);

        LinearLayout lc = card(root); linkCard = lc;
        lc.addView(text("Link to Invoice Studio", 17, WHITE, true));
        TextView lh = text("On a computer, open Invoice Studio → MoMo payments → Link phone. Type the 6-digit code shown there.", 14, MUTED, false);
        lh.setPadding(0, dp(8), 0, dp(12)); lc.addView(lh);
        codeInput = new EditText(this); codeInput.setHint("6-digit code"); codeInput.setHintTextColor(Color.rgb(110, 110, 118)); codeInput.setTextColor(WHITE);
        codeInput.setTextSize(26); codeInput.setGravity(Gravity.CENTER); codeInput.setSingleLine(true); codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeInput.setLetterSpacing(0.3f); codeInput.setBackground(box(Color.rgb(13, 13, 16), Color.rgb(70, 70, 78)));
        lc.addView(codeInput, new LinearLayout.LayoutParams(-1, dp(64)));
        linkButton = button("Link phone", true); linkButton.setOnClickListener(v -> doLink()); lc.addView(linkButton);

        LinearLayout wc = card(root); workingCard = wc;
        wc.addView(text("Recent MoMo payments", 17, WHITE, true));
        recentText = text("", 15, WHITE, false); recentText.setPadding(0, dp(10), 0, 0); wc.addView(recentText);
        syncButton = button("Send now", true); syncButton.setOnClickListener(v -> runSync(true)); wc.addView(syncButton);
        Button battery = button("Keep running in the background", false);
        battery.setOnClickListener(v -> { try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception e) { toast("Open Settings → Apps → FBI MoMo Link → Battery → Unrestricted"); } });
        wc.addView(battery);
        TextView bh = text("Tip: set this app's battery use to “Unrestricted” so the phone doesn't pause it.", 13, MUTED, false); bh.setPadding(0, dp(8), 0, 0); wc.addView(bh);
        unlinkButton = button("Unlink this phone", false); unlinkButton.setOnClickListener(v -> unlink()); wc.addView(unlinkButton);

        footText = text("", 12, MUTED, false); footText.setGravity(Gravity.CENTER); root.addView(footText);
        TextView ver = text("Version " + Link.VERSION, 11, Color.rgb(110, 110, 118), false); ver.setGravity(Gravity.CENTER); ver.setPadding(0, dp(6), 0, 0); root.addView(ver);
        setContentView(sv);
    }
}
