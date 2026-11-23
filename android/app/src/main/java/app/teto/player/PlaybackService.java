package app.teto.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

/**
 * Keeps the process alive while music plays (foreground "mediaPlayback" service),
 * publishes a MediaSession (lock screen, headset buttons, Bluetooth, quick settings player),
 * and manages audio focus / "becoming noisy".
 *
 * Battery: the service holds a partial wake lock only while playing (so the next track can start
 * with the screen off), drops it on pause, leaves foreground state after a while of being paused,
 * and the session is updated only on state changes — the system extrapolates the position itself.
 */
public class PlaybackService extends Service {
    static final String ACTION_UPDATE = "app.teto.player.UPDATE";
    static final String ACTION_STOP_SERVICE = "app.teto.player.STOP_SERVICE";
    private static final String ACTION_CMD = "app.teto.player.CMD";
    private static final String CHANNEL = "playback";
    private static final int NOTIF_ID = 7;
    private static final long PAUSED_FG_MS = 10 * 60 * 1000L;   // keep controls "sticky" this long after pause
    private static final long PAUSED_STOP_MS = 45 * 60 * 1000L; // then let the process go

    static volatile boolean running = false;

    private MediaSessionCompat session;
    private AudioManager am;
    private AudioFocusRequest focusReq;
    private boolean hasFocus = false;
    private PowerManager.WakeLock wake;
    private boolean noisyRegistered = false;
    private boolean foreground = false;
    private final Handler h = new Handler(Looper.getMainLooper());

    private String title = "", artist = "", album = "", art = "", loadedArt = null;
    private Bitmap artBmp;
    private boolean playing = false;
    private double pos = 0, dur = 0;

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) focus("noisy");
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS: hasFocus = false; focus("loss"); break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: focus("transient"); break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: focus("duck"); break;
            case AudioManager.AUDIOFOCUS_GAIN: hasFocus = true; focus("gain"); break;
            default: break;
        }
    };

    private final Runnable leaveForeground = () -> {
        if (!playing && foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
            foreground = false;
        }
    };
    private final Runnable stopIdle = () -> { if (!playing) shutdown(); };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        am = (AudioManager) getSystemService(AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "teto:playback");
        wake.setReferenceCounted(false);

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Воспроизведение", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }

        session = new MediaSessionCompat(this, "Teto");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { media("play", null); }
            @Override public void onPause() { media("pause", null); }
            @Override public void onSkipToNext() { media("next", null); }
            @Override public void onSkipToPrevious() { media("prev", null); }
            @Override public void onStop() { media("pause", null); }
            @Override public void onSeekTo(long ms) { media("seek", ms / 1000.0); }
        });
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP_SERVICE.equals(action)) { shutdown(); return START_NOT_STICKY; }
        if (ACTION_CMD.equals(action)) {
            media(intent.getStringExtra("cmd"), null);
            return START_NOT_STICKY;
        }
        if (ACTION_UPDATE.equals(action)) {
            title = s(intent.getStringExtra("title"));
            artist = s(intent.getStringExtra("artist"));
            album = s(intent.getStringExtra("album"));
            art = s(intent.getStringExtra("art"));
            playing = intent.getBooleanExtra("playing", false);
            pos = intent.getDoubleExtra("pos", 0);
            dur = intent.getDoubleExtra("dur", 0);
            apply();
        }
        return START_NOT_STICKY;
    }

    private static String s(String v) { return v == null ? "" : v; }

    private void apply() {
        h.removeCallbacks(leaveForeground);
        h.removeCallbacks(stopIdle);
        if (playing) {
            // Audio focus is NOT requested here: the WebView's media player already holds it and pauses
            // itself on calls / other players. A second request from the same app made Android take focus
            // away from the WebView, which paused the music right after it started (v1.2–1.3 bug).
            if (!wake.isHeld()) wake.acquire(4 * 60 * 60 * 1000L); // safety timeout
            if (!noisyRegistered) {
                ContextCompat.registerReceiver(this, noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED);
                noisyRegistered = true;
            }
        } else {
            if (wake.isHeld()) wake.release();
            if (noisyRegistered) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} noisyRegistered = false; }
            h.postDelayed(leaveForeground, PAUSED_FG_MS);
            h.postDelayed(stopIdle, PAUSED_STOP_MS);
        }

        if (!art.equals(loadedArt)) {
            loadedArt = art;
            if (artBmp != null) { artBmp = null; }
            if (!art.isEmpty()) {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(art, o);
                int sm = 1;
                while (o.outWidth / (sm * 2) >= 512) sm *= 2;
                o = new BitmapFactory.Options();
                o.inSampleSize = sm;
                artBmp = BitmapFactory.decodeFile(art, o);
            }
        }
        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (dur * 1000));
        if (artBmp != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artBmp);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_STOP)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                (long) (pos * 1000), playing ? 1f : 0f, SystemClock.elapsedRealtime())
            .build());
        post(playing);
    }

    private PendingIntent cmd(String c, int req) {
        Intent i = new Intent(this, PlaybackService.class).setAction(ACTION_CMD).putExtra("cmd", c);
        return PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_teto)
            .setContentTitle(title.isEmpty() ? "Teto" : title)
            .setContentText(artist)
            .setSubText(album.isEmpty() ? null : album)
            .setLargeIcon(artBmp)
            .setContentIntent(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .setDeleteIntent(cmd("dismiss", 9))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOngoing(playing)
            .addAction(R.drawable.ic_n_prev, "Назад", cmd("prev", 2))
            .addAction(playing ? R.drawable.ic_n_pause : R.drawable.ic_n_play, playing ? "Пауза" : "Играть", cmd("toggle", 3))
            .addAction(R.drawable.ic_n_next, "Вперёд", cmd("next", 4))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void post(boolean wantForeground) {
        Notification n = build();
        if (wantForeground || foreground) {
            try {
                ServiceCompat.startForeground(this, NOTIF_ID, n,
                    Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);
                foreground = true;
                return;
            } catch (Exception e) {
                // not allowed right now (background start restrictions) — fall back to a plain notification
            }
        }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, n);
        } catch (Exception ignored) {}
    }

    private void requestFocus() {
        if (hasFocus) return;
        int r;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusReq == null) {
                focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(focusListener, h)
                    .build();
            }
            r = am.requestAudioFocus(focusReq);
        } else {
            r = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (!hasFocus) return;
        if (Build.VERSION.SDK_INT >= 26) { if (focusReq != null) am.abandonAudioFocusRequest(focusReq); }
        else am.abandonAudioFocus(focusListener);
        hasFocus = false;
    }

    private void media(String action, Double p) {
        if (action == null) return;
        if ("dismiss".equals(action)) { if (!playing) shutdown(); return; }
        JSObject o = new JSObject();
        o.put("action", action);
        if (p != null) o.put("pos", p);
        TetoPlugin.emit("media", o);
    }

    private void focus(String type) {
        JSObject o = new JSObject();
        o.put("type", type);
        TetoPlugin.emit("focus", o);
    }

    private void shutdown() {
        h.removeCallbacksAndMessages(null);
        if (wake.isHeld()) wake.release();
        if (noisyRegistered) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} noisyRegistered = false; }
        abandonFocus();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        foreground = false;
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // swiped away from recents: stop the music like most players do
        media("pause", null);
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        h.removeCallbacksAndMessages(null);
        if (wake != null && wake.isHeld()) wake.release();
        if (noisyRegistered) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} }
        abandonFocus();
        if (session != null) { session.setActive(false); session.release(); }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
