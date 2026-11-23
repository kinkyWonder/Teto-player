package app.teto.player;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * VK Music downloads without yt-dlp (no Python start, all pieces in parallel):
 *  - direct MP3 links are just fetched,
 *  - HLS (index.m3u8): segments are fetched 6 at a time, AES-128 segments decrypted, the MPEG-TS demuxed into the
 *    plain MP3 (or AAC) stream — no re-encoding;
 *  - an ID3v2 tag with title, artist, album and the album cover is written in front of MP3 files.
 */
final class VkDl {
    static final String UA = "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)";
    private static final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();

    private VkDl() {}

    static void cancel(String id) { cancelled.put(id, true); }

    static boolean isVk(String url, String source) {
        if ("vk".equals(source)) return true;
        String u = url.toLowerCase();
        return u.contains("vkuseraudio.") || u.contains("vk-cdn.") || (u.contains(".m3u8") && u.contains("vk"));
    }

    private static byte[] get(String url) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(20000);
            c.setRequestProperty("User-Agent", UA);
            try {
                int code = c.getResponseCode();
                if (code >= 400) throw new Exception("HTTP " + code);
                try (InputStream in = c.getInputStream()) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream(1 << 18);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                    return bo.toByteArray();
                }
            } catch (Exception e) {
                last = e;
                Thread.sleep(400L * (attempt + 1));
            } finally { c.disconnect(); }
        }
        throw last;
    }

    private static final class Seg { String url; String keyUrl; byte[] iv; }

    static Dl.Result download(Context ctx, String id, String url, String title, String artist, String album, String cover, Dl.Progress cb) throws Exception {
        cancelled.remove(id);
        File tmp = new File(ctx.getCacheDir(), "dl/" + id);
        Dl.deleteTree(tmp);
        tmp.mkdirs();
        cb.on(0, "ВК: получаю трек…");
        byte[] audio;
        if (url.contains(".m3u8")) audio = hls(id, url, cb);
        else { audio = get(url); cb.on(1, "Скачано"); }
        if (cancelled.remove(id) != null) throw new Exception("Отменено");
        boolean aac = isAdts(audio);
        Dl.Result r = new Dl.Result();
        r.title = title; r.artist = artist;
        String base = (artist == null || artist.isEmpty() ? "" : artist + " - ") + (title == null || title.isEmpty() ? "track" : title);
        base = base.replaceAll("[\\\\/:*?\"<>|]+", "_");
        if (base.length() > 120) base = base.substring(0, 120);
        r.file = new File(tmp, base + (aac ? ".aac" : ".mp3"));
        try (OutputStream os = new FileOutputStream(r.file)) {
            if (!aac) {
                byte[] pic = null;
                if (cover != null && !cover.isEmpty()) { try { pic = get(cover); } catch (Exception ignored) {} }
                os.write(id3(title, artist, album, pic));
            }
            os.write(audio);
        }
        return r;
    }

    /** HLS: playlist → segments (parallel) → decrypted → demuxed elementary stream. */
    private static byte[] hls(final String id, String url, final Dl.Progress cb) throws Exception {
        String pl = new String(get(url), StandardCharsets.UTF_8);
        if (pl.contains("#EXT-X-STREAM-INF")) { // master playlist: take the first variant
            for (String l : pl.split("\n")) { l = l.trim(); if (!l.isEmpty() && !l.startsWith("#")) { url = resolve(url, l); break; } }
            pl = new String(get(url), StandardCharsets.UTF_8);
        }
        final List<Seg> segs = new ArrayList<>();
        String keyUrl = null; byte[] iv = null;
        long seq = 0;
        Pattern attr = Pattern.compile("([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)");
        for (String l : pl.split("\n")) {
            l = l.trim();
            if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Long.parseLong(l.substring(22).trim());
            else if (l.startsWith("#EXT-X-KEY:")) {
                Map<String, String> a = new HashMap<>();
                Matcher m = attr.matcher(l.substring(11));
                while (m.find()) a.put(m.group(1), m.group(2).replace("\"", ""));
                if ("AES-128".equals(a.get("METHOD"))) { keyUrl = resolve(url, a.get("URI")); iv = a.containsKey("IV") ? hex(a.get("IV")) : null; }
                else { keyUrl = null; iv = null; }
            } else if (!l.isEmpty() && !l.startsWith("#")) {
                Seg s = new Seg();
                s.url = resolve(url, l);
                s.keyUrl = keyUrl;
                if (keyUrl != null) {
                    if (iv != null) s.iv = iv;
                    else { s.iv = new byte[16]; long n = seq; for (int i = 15; i >= 8; i--) { s.iv[i] = (byte) n; n >>>= 8; } }
                }
                segs.add(s);
                seq++;
            }
        }
        if (segs.isEmpty()) throw new Exception("ВК: пустой плейлист");
        final Map<String, byte[]> keys = new ConcurrentHashMap<>();
        final byte[][] parts = new byte[segs.size()][];
        final AtomicInteger done = new AtomicInteger();
        ExecutorService ex = Executors.newFixedThreadPool(6);
        try {
            List<Future<?>> fs = new ArrayList<>();
            for (int i = 0; i < segs.size(); i++) {
                final int k = i;
                fs.add(ex.submit(() -> {
                    if (cancelled.containsKey(id)) throw new Exception("Отменено");
                    Seg s = segs.get(k);
                    byte[] b = get(s.url);
                    if (s.keyUrl != null) {
                        byte[] key = keys.get(s.keyUrl);
                        if (key == null) { key = get(s.keyUrl); keys.put(s.keyUrl, key); }
                        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
                        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(s.iv));
                        b = c.doFinal(b);
                    }
                    parts[k] = b;
                    float p = done.incrementAndGet() / (float) segs.size();
                    cb.on(p, "Скачиваю " + (int) (p * 100) + "%");
                    return null;
                }));
            }
            for (Future<?> f : fs) f.get();
        } finally { ex.shutdownNow(); }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] b : parts) out.write(demux(b));
        return out.toByteArray();
    }

    /** MPEG-TS → the payload of the first audio PES stream; anything that is not TS is returned as is. */
    static byte[] demux(byte[] ts) {
        if (ts.length < 188 || ts[0] != 0x47) return ts;
        ByteArrayOutputStream out = new ByteArrayOutputStream(ts.length);
        int audioPid = -1;
        for (int o = 0; o + 188 <= ts.length; o += 188) {
            if (ts[o] != 0x47) { // lost sync: find the next packet start
                int n = o + 1;
                while (n + 188 <= ts.length && !(ts[n] == 0x47 && (n + 188 >= ts.length || ts[n + 188] == 0x47))) n++;
                o = n - 188;
                continue;
            }
            int pid = ((ts[o + 1] & 0x1F) << 8) | (ts[o + 2] & 0xFF);
            boolean start = (ts[o + 1] & 0x40) != 0;
            int afc = (ts[o + 3] >> 4) & 3;
            int p = o + 4;
            if ((afc & 2) != 0) p += 1 + (ts[p] & 0xFF);
            if ((afc & 1) == 0 || p >= o + 188) continue;
            if (start && p + 9 <= o + 188 && ts[p] == 0 && ts[p + 1] == 0 && ts[p + 2] == 1) {
                int sid = ts[p + 3] & 0xFF;
                if (audioPid < 0 && sid >= 0xC0 && sid <= 0xDF) audioPid = pid;
                if (pid != audioPid) continue;
                p += 9 + (ts[p + 8] & 0xFF);
            } else if (pid != audioPid) continue;
            if (p < o + 188) out.write(ts, p, o + 188 - p);
        }
        return audioPid < 0 ? ts : out.toByteArray();
    }

    private static boolean isAdts(byte[] b) {
        // ADTS: 0xFFF sync with layer bits 00; MP3 frames have layer != 00
        int i = 0;
        if (b.length > 10 && b[0] == 'I' && b[1] == 'D' && b[2] == '3') return false;
        return b.length > 2 && (b[i] & 0xFF) == 0xFF && (b[i + 1] & 0xF6) == 0xF0;
    }

    private static String resolve(String base, String rel) {
        try { return new URL(new URL(base), rel).toString(); } catch (Exception e) { return rel; }
    }

    private static byte[] hex(String s) {
        s = s.startsWith("0x") || s.startsWith("0X") ? s.substring(2) : s;
        byte[] b = new byte[16];
        for (int i = 0; i < 16 && i * 2 + 1 < s.length(); i++) b[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return b;
    }

    /* ---------------- ID3v2.3 ---------------- */
    private static void frame(ByteArrayOutputStream o, String id, byte[] body) {
        int n = body.length;
        o.write(id.getBytes(StandardCharsets.US_ASCII), 0, 4);
        o.write((n >>> 24) & 0xFF); o.write((n >>> 16) & 0xFF); o.write((n >>> 8) & 0xFF); o.write(n & 0xFF);
        o.write(0); o.write(0);
        o.write(body, 0, n);
    }
    private static void text(ByteArrayOutputStream o, String id, String v) {
        if (v == null || v.isEmpty()) return;
        byte[] s = v.getBytes(StandardCharsets.UTF_16); // with BOM
        byte[] b = new byte[s.length + 3];
        b[0] = 1; // UTF-16
        System.arraycopy(s, 0, b, 1, s.length);
        frame(o, id, b);
    }
    static byte[] id3(String title, String artist, String album, byte[] pic) {
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        text(f, "TIT2", title);
        text(f, "TPE1", artist);
        text(f, "TALB", album);
        if (pic != null && pic.length > 0) {
            boolean png = pic.length > 4 && (pic[0] & 0xFF) == 0x89 && pic[1] == 'P';
            byte[] mime = (png ? "image/png" : "image/jpeg").getBytes(StandardCharsets.US_ASCII);
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            b.write(0); b.write(mime, 0, mime.length); b.write(0); b.write(3); b.write(0); // latin1, mime, front cover, empty description
            b.write(pic, 0, pic.length);
            frame(f, "APIC", b.toByteArray());
        }
        byte[] frames = f.toByteArray();
        int n = frames.length;
        ByteArrayOutputStream o = new ByteArrayOutputStream(n + 10);
        o.write('I'); o.write('D'); o.write('3'); o.write(3); o.write(0); o.write(0);
        o.write((n >>> 21) & 0x7F); o.write((n >>> 14) & 0x7F); o.write((n >>> 7) & 0x7F); o.write(n & 0x7F); // syncsafe size
        o.write(frames, 0, n);
        return o.toByteArray();
    }
}
