package com.fbigh.momolink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Makes sure the 15-minute check-in is scheduled again after the phone restarts or the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Link.linked(context)) { Link.schedulePeriodic(context); Link.syncSoon(context); }
    }
}
