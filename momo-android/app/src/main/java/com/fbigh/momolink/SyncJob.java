package com.fbigh.momolink;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Runs in the background: sends waiting payments and checks in with Invoice Studio. */
public class SyncJob extends JobService {
    @Override public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            String status = Link.sync(getApplicationContext());
            boolean failed = status.startsWith("Could not reach");
            jobFinished(params, failed && params.getJobId() == Link.JOB_NOW);
        }, "fbi-momo-sync").start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) { return true; }
}
