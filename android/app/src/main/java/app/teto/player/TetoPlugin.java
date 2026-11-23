package app.teto.player;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.provider.MediaStore;
import android.content.ContentUris;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native side of Teto for Android:
 *  - importing audio (file picker + "Share" from other apps) into private storage,
 *  - reading tags / embedded covers,
 *  - media session + foreground playback service bridge,
 *  - Settings → Scan: finding audio on the phone (MediaStore) and copying it into the app.
 */
@CapacitorPlugin(
    name = "Teto",
    permissions = {
        @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
        @Permission(alias = "storage", strings = { "android.permission.READ_EXTERNAL_STORAGE" })
    }
)
public class TetoPlugin extends Plugin {
    private static TetoPlugin instance;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** network work ("Download") must not hold up imports */
    private final ExecutorService net = Executors.newFixedThreadPool(2);

    @Override
    public void load() {
        instance = this;
        Dl.init(getContext()); // unpack yt-dlp / ffmpeg early, so "Download" is ready when needed
        Activity a = getActivity();
        if (a != null) {
            Intent i = a.getIntent();
            if (isShare(i)) {
                handleShare(i);
                a.setIntent(new Intent(Intent.ACTION_MAIN)); // don't re-import on recreate
            }
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isShare(intent)) handleShare(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** Lets the playback service talk to JS. */
    static void emit(String event, JSObject data) {
        TetoPlugin p = instance;
        if (p != null) p.notifyListeners(event, data);
    }

    // ------------------------------------------------------------------ import

    private static boolean isShare(Intent i) {
        if (i == null || i.getAction() == null) return false;
        if (Intent.ACTION_SEND.equals(i.getAction()) && i.getStringExtra(Intent.EXTRA_TEXT) != null && i.getParcelableExtra(Intent.EXTRA_STREAM) == null) return true;
        return Intent.ACTION_SEND.equals(i.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(i.getAction())
            || (Intent.ACTION_VIEW.equals(i.getAction()) && i.getData() != null);
    }

    @SuppressWarnings("deprecation")
    private void handleShare(Intent i) {
        List<Uri> uris = new ArrayList<>();
        String act = i.getAction();
        if (Intent.ACTION_SEND.equals(act) && i.getParcelableExtra(Intent.EXTRA_STREAM) == null && i.getStringExtra(Intent.EXTRA_TEXT) != null) {
            // a link / "artist - title" shared from YouTube, SoundCloud, Spotify… → Download screen
            JSObject o = new JSObject();
            o.put("text", i.getStringExtra(Intent.EXTRA_TEXT));
            notifyListeners("sharedText", o, true);
            return;
        }
        if (Intent.ACTION_SEND.equals(act)) {
            Parcelable p = i.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uris.add((Uri) p);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(act)) {
            ArrayList<Parcelable> list = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
        } else if (i.getData() != null) {
            uris.add(i.getData());
        }
        if (uris.isEmpty() && i.getClipData() != null) {
            for (int k = 0; k < i.getClipData().getItemCount(); k++) {
                Uri u = i.getClipData().getItemAt(k).getUri();
                if (u != null) uris.add(u);
            }
        }
        if (!uris.isEmpty()) importUris(uris);
    }

    @PluginMethod
    public void pickAudio(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("audio/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "audio/*", "application/ogg", "application/x-flac" });
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) uris.add(data.getData());
        }
        call.resolve();
        if (!uris.isEmpty()) importUris(uris);
    }

    private File musicDir() { File d = new File(getContext().getFilesDir(), "music"); d.mkdirs(); return d; }
    private File coverDir() { File d = new File(getContext().getFilesDir(), "covers"); d.mkdirs(); return d; }

    private void importUris(final List<Uri> uris) {
        io.execute(() -> {
            ContentResolver cr = getContext().getContentResolver();
            JSONArray out = new JSONArray();
            int failed = 0, done = 0;
            progress(0, uris.size());
            for (Uri u : uris) {
                try {
                    String name = displayName(cr, u);
                    String mime = cr.getType(u);
                    name = withExtension(sanitize(name), mime);
                    long size = querySize(cr, u);
                    File dst = new File(musicDir(), name);
                    if (dst.exists() && size > 0 && dst.length() == size) {
                        // same file already imported — the library dedups by path
                    } else {
                        if (dst.exists()) dst = unique(dst);
                        File tmp = new File(dst.getPath() + ".part");
                        try (InputStream in = cr.openInputStream(u); OutputStream os = new FileOutputStream(tmp)) {
                            if (in == null) throw new Exception("no stream");
                            byte[] buf = new byte[256 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                        }
                        if (!tmp.renameTo(dst)) throw new Exception("rename");
                    }
                    JSObject t = probeFile(dst);
                    if (t == null) { dst.delete(); failed++; } else out.put(t);
                } catch (Exception e) {
                    failed++;
                }
                progress(++done, uris.size());
            }
            JSObject res = new JSObject();
            res.put("tracks", out);
            res.put("failed", failed);
            notifyListeners("imported", res, true); // retained until JS subscribes (cold start from Share)
        });
    }

    private void progress(int done, int total) {
        JSObject p = new JSObject();
        p.put("done", done);
        p.put("total", total);
        notifyListeners("importing", p);
    }

    private static String displayName(ContentResolver cr, Uri u) {
        String name = null;
        try (Cursor c = cr.query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {}
        if (name == null) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "track_" + System.currentTimeMillis();
        int slash = name.lastIndexOf('/');
        return slash >= 0 ? name.substring(slash + 1) : name;
    }

    private static long querySize(ContentResolver cr, Uri u) {
        try (Cursor c = cr.query(u, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    private static String sanitize(String s) {
        s = s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.length() > 120) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 6 ? s.substring(dot) : "";
            s = s.substring(0, 120 - ext.length()) + ext;
        }
        return s.isEmpty() || s.startsWith(".") ? "track" + s : s;
    }

    private static String withExtension(String name, String mime) {
        if (name.matches("(?i).+\\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wave|mp4|3gp|amr|mka|webm|wma|aiff?|alac)$")) return name;
        String ext = mime != null ? MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) : null;
        if ("application/x-flac".equals(mime) || "audio/x-flac".equals(mime)) ext = "flac";
        return ext != null ? name + "." + ext : name;
    }

    private static File unique(File f) {
        String n = f.getName();
        int dot = n.lastIndexOf('.');
        String base = dot > 0 ? n.substring(0, dot) : n, ext = dot > 0 ? n.substring(dot) : "";
        for (int k = 2; ; k++) {
            File c = new File(f.getParentFile(), base + " (" + k + ")" + ext);
            if (!c.exists()) return c;
        }
    }

    // ------------------------------------------------------------------ tags

    private static int num(String s) {
        if (s == null) return 0;
        s = s.trim();
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        StringBuilder b = new StringBuilder();
        for (char ch : s.toCharArray()) { if (Character.isDigit(ch)) b.append(ch); else if (b.length() > 0) break; }
        try { return b.length() > 0 && b.length() < 10 ? Integer.parseInt(b.toString()) : 0; } catch (Exception e) { return 0; }
    }

    private static String str(String s) { return s == null ? "" : s.trim(); }

    private static String md5(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes("UTF-8"));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.substring(0, 16);
        } catch (Exception e) { return Integer.toHexString(s.hashCode()); }
    }

    private JSObject probeFile(File f) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getAbsolutePath());
            String mime = str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE));
            String hasAudio = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO);
            long durMs = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            if (!"yes".equals(hasAudio) && durMs <= 0) return null;
            String base = f.getName();
            int dot = base.lastIndexOf('.');
            if (dot > 0) base = base.substring(0, dot);
            String title = str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            String artist = str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            String album = str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            String albumArtist = str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            if (title.isEmpty()) {
                // "Artist - Title.mp3" is the common shape of shared files
                int sep = base.indexOf(" - ");
                if (sep > 0 && artist.isEmpty()) { artist = base.substring(0, sep).trim(); title = base.substring(sep + 3).trim(); }
                else title = base;
            }
            int year = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR));
            if (year == 0) year = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE));
            if (year < 1000 || year > 3000) year = 0;
            JSObject t = new JSObject();
            t.put("path", f.getAbsolutePath());
            t.put("name", f.getName());
            t.put("size", f.length());
            t.put("title", title);
            t.put("artist", artist);
            t.put("album", album);
            t.put("albumArtist", albumArtist);
            t.put("genre", str(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_GENRE)));
            t.put("year", year);
            t.put("no", num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)));
            t.put("disc", num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)));
            t.put("dur", durMs / 1000.0);
            t.put("mime", mime);
            t.put("kbps", num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)) / 1000);
            int rate = 0, bits = 0;
            if (Build.VERSION.SDK_INT >= 31) {
                rate = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE));
                bits = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE));
            }
            t.put("rate", rate);
            t.put("bits", bits);
            String cover = "";
            byte[] pic = r.getEmbeddedPicture();
            if (pic != null && pic.length > 0) {
                String key = md5((albumArtist.isEmpty() ? artist : albumArtist).toLowerCase(Locale.ROOT) + "|" + album.toLowerCase(Locale.ROOT)
                    + (album.isEmpty() ? "|" + f.getName() : ""));
                File cf = new File(coverDir(), "emb_" + key + ".jpg");
                if (cf.exists() || saveScaled(pic, cf, 720)) cover = cf.getAbsolutePath();
            }
            t.put("cover", cover);
            return t;
        } catch (Exception e) {
            return null;
        } finally {
            try { r.release(); } catch (Exception ignored) {}
        }
    }

    private static boolean saveScaled(byte[] data, File dst, int max) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            int s = 1;
            while (o.outWidth / (s * 2) >= max && o.outHeight / (s * 2) >= max) s *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = s;
            Bitmap b = BitmapFactory.decodeByteArray(data, 0, data.length, o);
            if (b == null) return false;
            int w = b.getWidth(), h = b.getHeight();
            if (Math.max(w, h) > max) {
                float k = (float) max / Math.max(w, h);
                Bitmap sc = Bitmap.createScaledBitmap(b, Math.round(w * k), Math.round(h * k), true);
                if (sc != b) b.recycle();
                b = sc;
            }
            try (OutputStream os = new FileOutputStream(dst)) { b.compress(Bitmap.CompressFormat.JPEG, 88, os); }
            b.recycle();
            return true;
        } catch (Exception e) { return false; }
    }

    @PluginMethod
    public void probe(final PluginCall call) {
        final JSArray paths = call.getArray("paths", new JSArray());
        io.execute(() -> {
            JSONArray out = new JSONArray();
            for (int k = 0; k < paths.length(); k++) {
                String p = paths.optString(k, null);
                if (p == null) continue;
                File f = new File(p);
                if (!inside(f)) continue;
                JSObject t = probeFile(f);
                if (t != null) out.put(t);
            }
            JSObject res = new JSObject();
            res.put("tracks", out);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void listMusic(PluginCall call) {
        JSONArray out = new JSONArray();
        File[] fs = musicDir().listFiles();
        if (fs != null) for (File f : fs) {
            if (!f.isFile()) continue;
            if (f.getName().endsWith(".part")) { f.delete(); continue; }
            JSObject o = new JSObject();
            o.put("path", f.getAbsolutePath());
            o.put("size", f.length());
            out.put(o);
        }
        JSObject res = new JSObject();
        res.put("files", out);
        call.resolve(res);
    }

    private boolean inside(File f) {
        try {
            return f.getCanonicalPath().startsWith(getContext().getFilesDir().getCanonicalPath() + File.separator);
        } catch (Exception e) { return false; }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String p = call.getString("path", "");
        File f = new File(p);
        if (inside(f)) f.delete();
        call.resolve();
    }

    @PluginMethod
    public void saveImage(final PluginCall call) {
        final String name = sanitize(call.getString("name", "img_" + System.currentTimeMillis() + ".jpg"));
        final String data = call.getString("data", "");
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                File f = new File(coverDir(), name);
                try (OutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                JSObject res = new JSObject();
                res.put("path", f.getAbsolutePath());
                call.resolve(res);
            } catch (Exception e) {
                call.reject("save failed", e);
            }
        });
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject res = new JSObject();
        String v = "1.8.5";
        try { v = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; } catch (Exception ignored) {}
        res.put("version", v);
        res.put("storage", musicDir().getAbsolutePath());
        res.put("free", getContext().getFilesDir().getUsableSpace());
        call.resolve(res);
    }

    // ------------------------------------------------------------------ scan the phone

    private String audioAlias() { return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage"; }

    @PluginMethod
    public void scanDevice(PluginCall call) {
        if (getPermissionState(audioAlias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(audioAlias(), call, "scanPermission");
            return;
        }
        doScan(call);
    }

    @PermissionCallback
    private void scanPermission(PluginCall call) {
        if (getPermissionState(audioAlias()) == PermissionState.GRANTED) doScan(call);
        else call.reject("permission", "PERMISSION_DENIED");
    }

    private void doScan(final PluginCall call) {
        final long minMs = (long) (double) call.getDouble("minMs", 0.0);
        io.execute(() -> {
            JSArray items = new JSArray();
            Uri col = Build.VERSION.SDK_INT >= 29
                ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] proj = {
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.ARTIST, MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.DATA
            };
            String sel = MediaStore.Audio.Media.DURATION + " >= ?";
            String[] args = { String.valueOf(minMs) };
            String own = getContext().getFilesDir().getAbsolutePath();
            try (Cursor c = getContext().getContentResolver().query(col, proj, sel, args, MediaStore.Audio.Media.DATE_ADDED + " DESC")) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String data = str(c.getString(6));
                        if (data.startsWith(own)) continue;
                        long dur = c.getLong(3);
                        if (dur < minMs) continue;
                        JSObject o = new JSObject();
                        o.put("uri", ContentUris.withAppendedId(col, c.getLong(0)).toString());
                        o.put("name", str(c.getString(1)));
                        o.put("size", c.getLong(2));
                        o.put("dur", dur / 1000.0);
                        String ar = str(c.getString(4));
                        o.put("artist", "<unknown>".equals(ar) ? "" : ar);
                        o.put("title", str(c.getString(5)));
                        File pf = data.isEmpty() ? null : new File(data).getParentFile();
                        o.put("folder", pf == null ? "" : pf.getName());
                        items.put(o);
                    }
                }
                JSObject res = new JSObject();
                res.put("items", items);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("scan: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void importUris(PluginCall call) {
        JSArray arr = call.getArray("uris");
        List<Uri> uris = new ArrayList<>();
        try { for (int i = 0; i < arr.length(); i++) uris.add(Uri.parse(arr.getString(i))); } catch (Exception e) { call.reject("uris"); return; }
        if (!uris.isEmpty()) importUris(uris);
        call.resolve();
    }

    /** Monthly report: share a picture (PNG, base64) through the system share sheet. */
    @PluginMethod
    public void shareImage(PluginCall call) {
        String data = call.getString("data", "");
        String name = sanitize(call.getString("name", "teto.png"));
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            File f = new File(dir, name);
            try (OutputStream os = new FileOutputStream(f)) { os.write(Base64.decode(data, Base64.DEFAULT)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/png");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, call.getString("title", "Teto"));
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("share: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ "Download": yt-dlp + FFmpeg (as in Dot Player)

    /** Engine state for the Download screen. */
    @PluginMethod
    public void dlEngine(PluginCall call) {
        Dl.init(getContext());
        JSObject r = new JSObject();
        r.put("ready", Dl.ready);
        r.put("updating", Dl.updating);
        r.put("version", Dl.version == null ? "" : Dl.version);
        r.put("error", Dl.error == null ? "" : Dl.error);
        call.resolve(r);
    }

    @PluginMethod
    public void dlUpdate(final PluginCall call) {
        net.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("version", Dl.update(getContext()));
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(Dl.friendly(e));
            }
        });
    }

    /** YouTube + SoundCloud search (yt-dlp, flat). */
    @PluginMethod
    public void ytSearch(final PluginCall call) {
        final String q = call.getString("q", "");
        net.execute(() -> {
            try {
                JSArray arr = new JSArray();
                for (Dl.Item it : Dl.search(getContext(), q)) arr.put(it.json());
                JSObject r = new JSObject();
                r.put("items", arr);
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(Dl.friendly(e));
            }
        });
    }

    private final ExecutorService dl = Executors.newFixedThreadPool(3);
    private int dlRunning = 0;

    private void dlEvent(String id, String state, float progress, String message, JSObject extra) {
        JSObject o = extra != null ? extra : new JSObject();
        o.put("id", id);
        o.put("state", state);
        o.put("progress", progress);
        o.put("message", message);
        notifyListeners("dl", o);
    }

    private synchronized void dlService(int delta) {
        dlRunning += delta;
        Intent i = new Intent(getContext(), DownloadService.class);
        try {
            if (delta > 0 && dlRunning == 1) ContextCompat.startForegroundService(getContext(), i);
            else if (dlRunning <= 0) { dlRunning = 0; getContext().stopService(i); }
        } catch (Exception ignored) { /* background start not allowed: the download still runs */ }
    }

    /** Downloads a search result / link as MP3 into the app; progress → "dl" events, the file → "imported". */
    @PluginMethod
    public void ytDownload(final PluginCall call) {
        final String id = call.getString("id", "dl" + System.currentTimeMillis());
        final String url = call.getString("url", "");
        final String artist = call.getString("artist", "");
        final String title = call.getString("title", "");
        final int kbps = call.getInt("kbps", 320);
        // from an album page: the song goes into that album
        final String album = call.getString("album", "");
        final String albumArtist = call.getString("albumArtist", "");
        final int no = call.getInt("no", 0), disc = call.getInt("disc", 0), year = call.getInt("year", 0);
        // VK Music: native HLS download (see VkDl); the album name / cover come from the search result
        final String source = call.getString("source", "");
        final String thumb = call.getString("thumb", "");
        final String songAlbum = call.getString("songAlbum", "");
        dlService(1);
        dlEvent(id, "queued", 0, "В очереди", null);
        call.resolve();
        dl.execute(() -> {
            try {
                dlEvent(id, "running", 0, Dl.ready ? "Подготовка…" : "Запускаю движок…", null);
                Dl.Result r = VkDl.isVk(url, source)
                    ? VkDl.download(getContext(), id, url, title, artist, album.isEmpty() ? songAlbum : album, thumb, (p, m) -> dlEvent(id, "running", p, m, null))
                    : Dl.download(getContext(), id, url, title, artist, kbps, (p, m) -> dlEvent(id, "running", p, m, null));
                dlEvent(id, "running", 1, "Сохраняю в медиатеку…", null);
                String base = sanitize((r.artist == null || r.artist.isEmpty() ? "" : r.artist + " - ") + (r.title == null || r.title.isEmpty() ? "track" : r.title));
                String fn = r.file.getName();
                String ext = fn.lastIndexOf('.') > 0 ? fn.substring(fn.lastIndexOf('.')) : ".mp3";
                File dst = new File(musicDir(), base + ext);
                for (int n = 2; dst.exists(); n++) dst = new File(musicDir(), base + " (" + n + ")" + ext);
                if (!r.file.renameTo(dst)) {
                    try (InputStream in = new java.io.FileInputStream(r.file); OutputStream os = new FileOutputStream(dst)) {
                        byte[] buf = new byte[256 * 1024];
                        int k;
                        while ((k = in.read(buf)) > 0) os.write(buf, 0, k);
                    }
                }
                Dl.deleteTree(new File(getContext().getCacheDir(), "dl/" + id));
                JSObject t = probeFile(dst);
                if (t == null) { dst.delete(); throw new Exception("Файл не похож на музыку"); }
                if (r.title != null && !r.title.isEmpty()) t.put("title", r.title);
                if (r.artist != null && !r.artist.isEmpty()) t.put("artist", r.artist);
                if (!album.isEmpty()) {
                    t.put("album", album);
                    t.put("albumArtist", albumArtist.isEmpty() ? r.artist : albumArtist);
                    if (no > 0) t.put("no", no);
                    if (disc > 0) t.put("disc", disc);
                    if (year > 0) t.put("year", year);
                    t.put("force", true);
                }
                JSArray out = new JSArray();
                out.put(t);
                JSObject res = new JSObject();
                res.put("tracks", out);
                res.put("failed", 0);
                notifyListeners("imported", res, true);
                JSObject x = new JSObject();
                x.put("title", r.title == null ? "" : r.title);
                x.put("artist", r.artist == null ? "" : r.artist);
                dlEvent(id, "done", 1, "Готово · в медиатеке", x);
            } catch (Throwable e) {
                Dl.deleteTree(new File(getContext().getCacheDir(), "dl/" + id));
                dlEvent(id, "failed", 0, Dl.friendly(e), null);
            } finally {
                dlService(-1);
            }
        });
    }

    /**
     * "Connect VK": the official VK ID login page in a window (captcha / 2FA are handled by VK itself, the password
     * never reaches Teto); the result is a VK Music token of the Kate Mobile client, kept by the web layer.
     */
    @PluginMethod
    public void vkLogin(final PluginCall call) {
        final Activity act = getActivity();
        if (act == null) { call.reject("no activity"); return; }
        act.runOnUiThread(() -> {
            final android.app.Dialog d = new android.app.Dialog(act, android.R.style.Theme_DeviceDefault_NoActionBar);
            final android.webkit.WebView w = new android.webkit.WebView(act);
            final boolean[] finished = { false };
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            w.setWebViewClient(new android.webkit.WebViewClient() {
                private boolean check(String u) {
                    if (u == null || !u.startsWith("https://oauth.vk.com/blank.html")) return false;
                    int h = u.indexOf('#');
                    Uri q = Uri.parse("x://y?" + (h >= 0 ? u.substring(h + 1) : ""));
                    String token = q.getQueryParameter("access_token");
                    finished[0] = true;
                    if (token != null && !token.isEmpty()) {
                        JSObject r = new JSObject();
                        r.put("token", token);
                        r.put("user", q.getQueryParameter("user_id") == null ? "" : q.getQueryParameter("user_id"));
                        call.resolve(r);
                    } else call.reject(q.getQueryParameter("error_description") == null ? "Вход отменён" : q.getQueryParameter("error_description"));
                    d.dismiss();
                    return true;
                }
                @Override
                public boolean shouldOverrideUrlLoading(android.webkit.WebView v, android.webkit.WebResourceRequest req) { return check(req.getUrl().toString()); }
                @Override
                public void onPageStarted(android.webkit.WebView v, String u, Bitmap fav) { check(u); }
            });
            d.setContentView(w);
            d.setOnDismissListener((x) -> { if (!finished[0]) call.reject("Вход отменён"); w.destroy(); });
            d.show();
            w.loadUrl("https://oauth.vk.com/authorize?client_id=2685278&display=mobile&redirect_uri=https://oauth.vk.com/blank.html"
                + "&scope=audio,offline&response_type=token&revoke=1&v=5.131");
        });
    }

    @PluginMethod
    public void dlCancel(PluginCall call) {
        Dl.cancel(call.getString("id", ""));
        VkDl.cancel(call.getString("id", ""));
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("open: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ playback session

    @PluginMethod
    public void session(PluginCall call) {
        Intent i = new Intent(getContext(), PlaybackService.class);
        i.setAction(PlaybackService.ACTION_UPDATE);
        i.putExtra("title", call.getString("title", ""));
        i.putExtra("artist", call.getString("artist", ""));
        i.putExtra("album", call.getString("album", ""));
        i.putExtra("art", call.getString("art", ""));
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        i.putExtra("playing", playing);
        i.putExtra("pos", call.getDouble("pos", 0.0));
        i.putExtra("dur", call.getDouble("dur", 0.0));
        try {
            if (playing) ContextCompat.startForegroundService(getContext(), i);
            else getContext().startService(i);
            call.resolve();
        } catch (Exception e) {
            // e.g. ForegroundServiceStartNotAllowedException when the app is deep in background
            call.reject("service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopSession(PluginCall call) {
        if (PlaybackService.running) {
            Intent i = new Intent(getContext(), PlaybackService.class);
            i.setAction(PlaybackService.ACTION_STOP_SERVICE);
            try { getContext().startService(i); } catch (Exception ignored) {}
        }
        call.resolve();
    }
}
