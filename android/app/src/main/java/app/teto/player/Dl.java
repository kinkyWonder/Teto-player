package app.teto.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kotlin.Unit;

/**
 * "Download" — the same logic as Dot Player: yt-dlp + FFmpeg inside the app (youtubedl-android).
 *  - search: YouTube + SoundCloud (20 each, interleaved, duplicates dropped),
 *  - links: YouTube, SoundCloud and everything yt-dlp knows; Spotify track links → "artist - title" → YouTube,
 *  - result: the original AAC/MP3 stream without re-encoding ("Original", fast) or MP3 of the chosen quality,
 *    with a square cover and tags,
 *  - yt-dlp updates itself (stable channel, at most once a day) — the main cure when YouTube changes something.
 */
final class Dl {
    private static final String TAG = "TetoDl";
    private static final Object lock = new Object();
    private static boolean started;
    static volatile boolean ready;
    static volatile String error;
    static volatile String version;
    static volatile boolean updating;

    private static final Pattern SEP = Pattern.compile("\\s+(?:-{1,2}|–|—)\\s+");

    private Dl() {}

    /** Starts the engine in the background (unpacks python / ffmpeg on the first run, then updates yt-dlp). */
    static void init(final Context ctx) {
        synchronized (lock) { if (started) return; started = true; }
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                YoutubeDL.getInstance().init(app);
                FFmpeg.getInstance().init(app);
                SharedPreferences sp = app.getSharedPreferences("teto.dl", Context.MODE_PRIVATE);
                long last = sp.getLong("updated", 0);
                if (System.currentTimeMillis() - last > 24L * 3600 * 1000) {
                    updating = true;
                    try {
                        YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel._STABLE);
                        sp.edit().putLong("updated", System.currentTimeMillis()).apply();
                    } catch (Throwable e) {
                        Log.w(TAG, "yt-dlp update failed", e);
                    } finally { updating = false; }
                }
                try { version = YoutubeDL.getInstance().versionName(app); } catch (Throwable ignored) {}
                ready = true;
            } catch (Throwable e) {
                Log.e(TAG, "engine init failed", e);
                error = e.getMessage() != null ? e.getMessage() : e.toString();
            }
            synchronized (lock) { lock.notifyAll(); }
        }, "teto-dl-init").start();
    }

    static void await(Context ctx) throws Exception {
        init(ctx);
        synchronized (lock) { while (!ready && error == null) lock.wait(1000); }
        if (!ready) throw new Exception("Движок не запустился: " + error);
    }

    /** Settings → Download → "Update yt-dlp". */
    static String update(Context ctx) throws Exception {
        await(ctx);
        updating = true;
        try {
            YoutubeDL.getInstance().updateYoutubeDL(ctx.getApplicationContext(), YoutubeDL.UpdateChannel._STABLE);
            ctx.getSharedPreferences("teto.dl", Context.MODE_PRIVATE).edit().putLong("updated", System.currentTimeMillis()).apply();
        } finally { updating = false; }
        version = YoutubeDL.getInstance().versionName(ctx.getApplicationContext());
        return version;
    }

    // ------------------------------------------------------------------ names

    private static String cleanName(String s) {
        return (s == null ? "" : s).replaceAll("(?i)\\s*-\\s*Topic$", "").trim();
    }

    /** "Artist - Title" from a video title (like the bot / Dot Player), else uploader + title. */
    static String[] splitLabel(String title, String uploader) {
        String t = (title == null ? "" : title).replaceAll("\\s+", " ").trim();
        String[] parts = SEP.split(t, 2);
        if (parts.length == 2 && !parts[0].trim().isEmpty() && !parts[1].trim().isEmpty()) return new String[] { parts[0].trim(), parts[1].trim() };
        return new String[] { cleanName(uploader), t };
    }

    static String sourceOf(String url) {
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains("youtube.com") || u.contains("youtu.be") || u.startsWith("ytsearch")) return "youtube";
        if (u.contains("soundcloud.com") || u.startsWith("scsearch")) return "soundcloud";
        if (u.contains("spotify.com") || u.startsWith("spotify:")) return "spotify";
        return "link";
    }

    // ------------------------------------------------------------------ search

    static final class Item {
        String url, title, artist, thumb, source;
        int dur;
        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("url", url); o.put("title", title); o.put("artist", artist); o.put("dur", dur);
                o.put("thumb", thumb == null ? "" : thumb); o.put("source", source);
            } catch (Exception ignored) {}
            return o;
        }
    }

    static List<Item> search(Context ctx, final String q) throws Exception {
        await(ctx);
        ExecutorService ex = Executors.newFixedThreadPool(2);
        try {
            Future<List<Item>> yt = ex.submit(() -> searchOne("ytsearch20:" + q, "youtube"));
            Future<List<Item>> sc = ex.submit(() -> searchOne("scsearch20:" + q, "soundcloud"));
            List<Item> a = yt.get(), b = sc.get();
            List<Item> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < Math.max(a.size(), b.size()); i++) {
                for (List<Item> l : Arrays.asList(a, b)) {
                    if (i >= l.size()) continue;
                    Item it = l.get(i);
                    String key = (it.artist + it.title).toLowerCase(Locale.ROOT).replaceAll("\\W+", "") + (it.dur / 3);
                    if (seen.add(key)) out.add(it);
                }
            }
            return out;
        } finally { ex.shutdownNow(); }
    }

    private static List<Item> searchOne(String query, String source) {
        List<Item> out = new ArrayList<>();
        try {
            YoutubeDLRequest req = new YoutubeDLRequest(query);
            req.addOption("--flat-playlist");
            req.addOption("-J");
            req.addOption("--no-warnings");
            JSONObject json = new JSONObject(YoutubeDL.getInstance().execute(req, null, false, null).getOut());
            JSONArray entries = json.optJSONArray("entries");
            for (int i = 0; entries != null && i < entries.length(); i++) {
                JSONObject e = entries.optJSONObject(i);
                if (e == null) continue;
                String url = e.optString("url");
                if (url.isEmpty()) url = e.optString("webpage_url");
                if (url.isEmpty()) continue;
                if (!url.startsWith("http")) url = "https://www.youtube.com/watch?v=" + url;
                int dur = (int) e.optDouble("duration", 0);
                if (dur > 2 * 3600) continue;
                String up = e.optString("uploader");
                if (up.isEmpty()) up = e.optString("channel");
                String[] at = splitLabel(e.optString("title"), up);
                if (at[1].isEmpty()) continue;
                String thumb = null;
                JSONArray th = e.optJSONArray("thumbnails");
                for (int k = th == null ? -1 : th.length() - 1; k >= 0; k--) {
                    JSONObject t = th.optJSONObject(k);
                    if (t != null && !t.optString("url").isEmpty()) { thumb = t.optString("url"); break; }
                }
                Item it = new Item();
                it.url = url; it.artist = at[0]; it.title = at[1]; it.dur = dur; it.thumb = thumb; it.source = source;
                out.add(it);
            }
        } catch (Throwable e) {
            Log.w(TAG, "search " + query, e);
        }
        return out;
    }

    // ------------------------------------------------------------------ Spotify

    /** Spotify track link → "artist - title" (from the public embed page). */
    static String resolveSpotify(String url) throws Exception {
        Matcher m = Pattern.compile("track[/:]([A-Za-z0-9]{22})").matcher(url);
        if (!m.find()) throw new Exception("Нужна ссылка на конкретный трек Spotify (open.spotify.com/track/…)");
        HttpURLConnection c = (HttpURLConnection) new URL("https://open.spotify.com/embed/track/" + m.group(1)).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0");
        String html;
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            html = bo.toString("UTF-8");
        } finally { c.disconnect(); }
        Matcher nd = Pattern.compile("<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>", Pattern.DOTALL).matcher(html);
        if (!nd.find()) throw new Exception("Не удалось получить данные трека из Spotify");
        JSONObject entity = new JSONObject(nd.group(1)).getJSONObject("props").getJSONObject("pageProps")
            .getJSONObject("state").getJSONObject("data").getJSONObject("entity");
        String title = entity.optString("name");
        if (title.isEmpty()) title = entity.optString("title");
        JSONArray artists = entity.optJSONArray("artists");
        StringBuilder a = new StringBuilder();
        for (int i = 0; artists != null && i < artists.length(); i++) {
            if (a.length() > 0) a.append(", ");
            a.append(artists.getJSONObject(i).optString("name"));
        }
        return (a + " - " + title).replaceAll("^[\\s-]+|[\\s-]+$", "");
    }

    // ------------------------------------------------------------------ download

    interface Progress { void on(float frac, String message); }

    /** Result: the MP3 in a temporary folder + the final names. */
    static final class Result { File file; String artist, title; }

    static Result download(Context ctx, String id, String rawUrl, String title, String artist, int kbps, Progress cb) throws Exception {
        await(ctx);
        Result r = new Result();
        r.title = title; r.artist = artist;
        String url = rawUrl;
        if ("spotify".equals(sourceOf(url))) {
            cb.on(0, "Spotify: узнаю название…");
            String q = resolveSpotify(url);
            String[] at = splitLabel(q, null);
            r.artist = at[0]; r.title = at[1];
            cb.on(0, "Ищу на YouTube…");
            url = "ytsearch1:" + q;
        }
        File tmp = new File(ctx.getCacheDir(), "dl/" + id);
        deleteTree(tmp);
        tmp.mkdirs();
        final boolean fast = kbps <= 0;
        YoutubeDLRequest req = new YoutubeDLRequest(url);
        req.addOption("-x");
        if (fast) {
            // "Original": take the AAC / MP3 stream as it is — no re-encoding (the slowest step on a phone);
            // only an Opus-only source is converted (to M4A)
            req.addOption("-f", "ba[ext=m4a]/ba[acodec^=mp4a]/ba[acodec^=mp3]/ba/b");
            req.addOption("--audio-format", "mp3>mp3/m4a");
        } else {
            req.addOption("--audio-format", "mp3");
            req.addOption("--audio-quality", kbps + "K");
        }
        req.addOption("--concurrent-fragments", "4"); // HLS / DASH sources (SoundCloud): pieces in parallel
        req.addOption("--no-part");
        req.addOption("--no-playlist");
        req.addOption("--no-mtime");
        req.addOption("--embed-metadata");
        req.addOption("--embed-thumbnail");
        req.addOption("--convert-thumbnails", "jpg");
        // square cover
        req.addOption("--ppa", "ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\"");
        req.addOption("--parse-metadata", "%(artist,uploader)s:%(meta_artist)s");
        req.addOption("--parse-metadata", "title:%(meta_artist)s - %(meta_title)s");
        req.addCommands(Arrays.asList("--replace-in-metadata", "meta_artist", " - Topic$", ""));
        req.addOption("--max-filesize", "200M");
        req.addOption("-o", new File(tmp, "%(title).120B.%(ext)s").getAbsolutePath());
        YoutubeDL.getInstance().execute(req, id, false, (progress, eta, line) -> {
            float p = Math.max(0f, Math.min(100f, progress)) / 100f;
            cb.on(p, p >= 0.999f ? (fast ? "Сохраняю…" : "Конвертирую в MP3…") : "Скачиваю " + (int) (p * 100) + "%");
            return Unit.INSTANCE;
        });
        File[] fs = tmp.listFiles();
        if (fs != null) for (File f : fs) if (f.getName().toLowerCase(Locale.ROOT).matches(".+\\.(mp3|m4a)$")) { r.file = f; break; }
        if (r.file == null) throw new Exception("Не удалось сконвертировать файл");
        if (r.title == null || r.title.isEmpty()) {
            String n = r.file.getName().replaceAll("(?i)\\.(mp3|m4a)$", "");
            String[] at = splitLabel(n, r.artist);
            if (r.artist == null || r.artist.isEmpty()) r.artist = at[0];
            r.title = at[1];
        }
        return r;
    }

    static void cancel(String id) {
        try { YoutubeDL.getInstance().destroyProcessById(id); } catch (Throwable ignored) {}
    }

    static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File c : fs) deleteTree(c);
        f.delete();
    }

    static String friendly(Throwable e) {
        String raw = e.getMessage() == null ? "" : e.getMessage();
        String m = raw.toLowerCase(Locale.ROOT);
        if (m.contains("unsupported url")) return "Этот сайт не поддерживается";
        if (m.contains("private")) return "Контент приватный";
        if (m.contains("unavailable") || m.contains("not available")) return "Контент недоступен или удалён";
        if (m.contains("sign in") || m.contains("not a bot")) return "YouTube просит вход — обновите yt-dlp в настройках";
        if (m.contains("max-filesize") || m.contains("larger than max")) return "Слишком большой файл";
        if (m.contains("network") || m.contains("timed out") || m.contains("unable to download")) return "Проблема с сетью, попробуйте ещё раз";
        String last = "";
        for (String l : raw.split("\n")) if (!l.trim().isEmpty()) last = l.trim();
        return last.isEmpty() ? "Ошибка скачивания" : (last.length() > 140 ? last.substring(0, 140) : last);
    }
}
