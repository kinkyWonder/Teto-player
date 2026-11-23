package app.teto.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Keeps the process alive while downloads run (otherwise Android may kill them in the background). */
public class DownloadService extends Service {
    static final String CHANNEL = "downloads";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Скачивание", NotificationManager.IMPORTANCE_LOW));
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Песни появятся в медиатеке Teto";
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_teto)
            .setContentTitle("Скачиваю музыку")
            .setContentText(text)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .build();
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        try { ServiceCompat.startForeground(this, 7, n, type); } catch (Exception ignored) {}
        return START_NOT_STICKY;
    }
}
