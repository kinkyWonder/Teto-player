import UIKit
import Capacitor
import AVFoundation
import UniformTypeIdentifiers
import CryptoKit
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}


// MARK: - Teto native side for iOS
// Kept in this file on purpose (no Xcode project edits needed). Mirrors the Android TetoPlugin:
// importing audio into the app's Documents (file picker, "Share → Teto", Files app), reading tags
// and covers with AVFoundation, background audio session, headphones / interruptions.
// Lock-screen controls come from the Media Session API in the web layer.

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TetoPlugin())
    }
}

@objc(TetoPlugin)
public class TetoPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "TetoPlugin"
    public let jsName = "Teto"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listMusic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "session", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importUris", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ytSearch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ytDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ytAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ytLogin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ytLogout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dlEngine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dlUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dlCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vkLogin", returnType: CAPPluginReturnPromise)
    ]

    static weak var shared: TetoPlugin?
    static var pending: [URL] = []
    private let io = DispatchQueue(label: "app.teto.io")
    static let audioExt: Set<String> = ["mp3", "m4a", "aac", "flac", "wav", "wave", "aif", "aiff", "aifc", "caf", "alac", "mp4", "m4b", "ogg", "oga", "opus", "webm", "mka", "amr", "3gp"]

    // MARK: lifecycle
    override public func load() {
        TetoPlugin.shared = self
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [])
        try? s.setActive(true)
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        if !TetoPlugin.pending.isEmpty {
            let u = TetoPlugin.pending
            TetoPlugin.pending = []
            importURLs(u, scoped: true)
        }
    }

    /// Files opened with "Share → Teto" / "Open in Teto".
    static func open(_ urls: [URL]) {
        let files = urls.filter { $0.isFileURL }
        if files.isEmpty { return }
        if let p = shared { p.importURLs(files, scoped: true) } else { pending.append(contentsOf: files) }
    }

    @objc func routeChanged(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
        notifyListeners("focus", data: ["type": "noisy"]) // headphones unplugged / Bluetooth gone
    }

    @objc func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            notifyListeners("focus", data: ["type": "transient"])
        } else {
            let o = n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: o).contains(.shouldResume) {
                try? AVAudioSession.sharedInstance().setActive(true)
                notifyListeners("focus", data: ["type": "gain"])
            }
        }
    }

    // MARK: storage
    var musicDir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    var coverDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("covers", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// Same file expressed with the canonical Documents prefix (opened-in-place URLs may use /private/var/...).
    func insideMusic(_ u: URL) -> URL? {
        let root = musicDir.resolvingSymlinksInPath().path + "/"
        let p = u.resolvingSymlinksInPath().path
        guard p.hasPrefix(root) else { return nil }
        return musicDir.appendingPathComponent(String(p.dropFirst(root.count)))
    }

    static func sanitize(_ name: String) -> String {
        var s = name.components(separatedBy: CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)).joined(separator: "_")
        s = s.trimmingCharacters(in: .whitespaces)
        if s.count > 120 {
            let ext = (s as NSString).pathExtension
            s = String(s.prefix(110)) + (ext.isEmpty ? "" : "." + ext)
        }
        if s.isEmpty || s.hasPrefix(".") { s = "track" + s }
        return s
    }

    static func unique(_ u: URL) -> URL {
        let dir = u.deletingLastPathComponent()
        let ext = u.pathExtension
        let base = u.deletingPathExtension().lastPathComponent
        var k = 2
        while true {
            let c = dir.appendingPathComponent("\(base) (\(k))" + (ext.isEmpty ? "" : "." + ext))
            if !FileManager.default.fileExists(atPath: c.path) { return c }
            k += 1
        }
    }

    func progress(_ done: Int, _ total: Int) {
        notifyListeners("importing", data: ["done": done, "total": total])
    }

    func importURLs(_ urls: [URL], scoped: Bool) {
        io.async {
            let fm = FileManager.default
            var out: [[String: Any]] = []
            var failed = 0, done = 0
            self.progress(0, urls.count)
            for u in urls {
                let access = scoped && u.startAccessingSecurityScopedResource()
                defer { if access { u.stopAccessingSecurityScopedResource() } }
                var copied = false
                var dst: URL
                if let inside = self.insideMusic(u), !inside.path.contains("/Documents/Inbox/") {
                    dst = inside // already ours (e.g. opened from Files → On My iPhone → Teto)
                } else {
                    dst = self.musicDir.appendingPathComponent(TetoPlugin.sanitize(u.lastPathComponent))
                    let size = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
                    let have = (try? dst.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -2
                    if !(fm.fileExists(atPath: dst.path) && size > 0 && size == have) {
                        if fm.fileExists(atPath: dst.path) { dst = TetoPlugin.unique(dst) }
                        do {
                            if u.path.contains("/Inbox/") || u.path.contains("-Inbox/") { try fm.moveItem(at: u, to: dst) }
                            else { try fm.copyItem(at: u, to: dst) }
                            copied = true
                        } catch {
                            failed += 1; done += 1; self.progress(done, urls.count); continue
                        }
                    }
                }
                if let t = self.probeFile(dst) { out.append(t) } else {
                    if copied { try? fm.removeItem(at: dst) }
                    failed += 1
                }
                done += 1
                self.progress(done, urls.count)
            }
            self.notifyListeners("imported", data: ["tracks": out, "failed": failed], retainUntilConsumed: true)
        }
    }

    // MARK: file picker
    @objc func pickAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var types: [UTType] = [.audio]
            for e in ["mp3", "m4a", "flac", "ogg", "opus", "wav", "aiff"] { if let t = UTType(filenameExtension: e) { types.append(t) } }
            let p = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            p.allowsMultipleSelection = true
            p.delegate = self
            self.bridge?.viewController?.present(p, animated: true)
            call.resolve()
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        importURLs(urls, scoped: false)
    }

    // MARK: tags
    static func num(_ s: String?) -> Int {
        guard let s = s else { return 0 }
        var digits = ""
        for ch in s.trimmingCharacters(in: .whitespaces) {
            if ch.isASCII && ch.isNumber { digits.append(ch) } else if !digits.isEmpty { break } else if ch == "/" { break }
        }
        return digits.count > 0 && digits.count < 10 ? (Int(digits) ?? 0) : 0
    }

    static func md5(_ s: String) -> String {
        let d = Insecure.MD5.hash(data: Data(s.utf8))
        return String(d.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    /// iTunes-style number atoms: 8 bytes, number in bytes 2-3.
    static func atomNum(_ d: Data?) -> Int {
        guard let d = d, d.count >= 4 else { return 0 }
        let b = [UInt8](d)
        return Int(b[2]) << 8 | Int(b[3])
    }

    func probeFile(_ f: URL) -> [String: Any]? {
        let asset = AVURLAsset(url: f)
        let dur = CMTimeGetSeconds(asset.duration)
        let audio = asset.tracks(withMediaType: .audio)
        if audio.isEmpty && !(dur > 0) { return nil }

        var title = "", artist = "", album = "", albumArtist = "", genre = ""
        var year = 0, no = 0, disc = 0
        var art: Data? = nil
        var items = asset.commonMetadata
        for fmt in asset.availableMetadataFormats { items.append(contentsOf: asset.metadata(forFormat: fmt)) }
        for i in items {
            let v = (i.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let id = i.identifier
            let key = ((i.key as? String) ?? "").uppercased()
            if let ck = i.commonKey {
                switch ck {
                case .commonKeyTitle: if title.isEmpty { title = v }
                case .commonKeyArtist: if artist.isEmpty { artist = v }
                case .commonKeyAlbumName: if album.isEmpty { album = v }
                case .commonKeyArtwork: if art == nil { art = i.dataValue }
                case .commonKeyCreationDate: if year == 0 { year = TetoPlugin.num(v) }
                default: break
                }
            }
            if id == .id3MetadataBand || id == .iTunesMetadataAlbumArtist || key == "ALBUMARTIST" || key == "ALBUM ARTIST" {
                if albumArtist.isEmpty { albumArtist = v }
            } else if id == .id3MetadataContentType || id == .iTunesMetadataUserGenre || id == .quickTimeMetadataGenre || key == "GENRE" {
                if genre.isEmpty { genre = v }
            } else if id == .id3MetadataYear || id == .id3MetadataRecordingTime || id == .iTunesMetadataReleaseDate || id == .quickTimeMetadataYear || key == "DATE" || key == "YEAR" {
                if year == 0 { year = TetoPlugin.num(v) }
            } else if id == .id3MetadataTrackNumber || key == "TRACKNUMBER" {
                if no == 0 { no = TetoPlugin.num(v) }
            } else if id == .iTunesMetadataTrackNumber {
                if no == 0 { no = TetoPlugin.atomNum(i.dataValue) }
            } else if id == .id3MetadataPartOfASet || key == "DISCNUMBER" {
                if disc == 0 { disc = TetoPlugin.num(v) }
            } else if id == .iTunesMetadataDiscNumber {
                if disc == 0 { disc = TetoPlugin.atomNum(i.dataValue) }
            } else if key == "TITLE" { if title.isEmpty { title = v } }
            else if key == "ARTIST" { if artist.isEmpty { artist = v } }
            else if key == "ALBUM" { if album.isEmpty { album = v } }
        }
        let base = f.deletingPathExtension().lastPathComponent
        if title.isEmpty {
            // "Artist - Title.mp3" is the common shape of shared files
            if artist.isEmpty, let r = base.range(of: " - ") {
                artist = String(base[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                title = String(base[r.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else { title = base }
        }
        if year < 1000 || year > 3000 { year = 0 }

        let size = (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        var rate = 0, bits = 0
        if let first = audio.first?.formatDescriptions.first {
            let fd = first as! CMFormatDescription
            if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                rate = Int(asbd.mSampleRate)
                bits = Int(asbd.mBitsPerChannel)
            }
        }
        let kbps = dur.isFinite && dur > 0 ? Int(Double(size) * 8 / dur / 1000) : 0
        let ext = f.pathExtension.lowercased()
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? ""

        var cover = ""
        if let data = art, !data.isEmpty {
            let who = (albumArtist.isEmpty ? artist : albumArtist).lowercased()
            let key = TetoPlugin.md5(who + "|" + album.lowercased() + (album.isEmpty ? "|" + f.lastPathComponent : ""))
            let cf = coverDir.appendingPathComponent("emb_" + key + ".jpg")
            if FileManager.default.fileExists(atPath: cf.path) || TetoPlugin.saveScaled(data, cf, 720) { cover = cf.path }
        }
        return [
            "path": f.path, "name": f.lastPathComponent, "size": size,
            "title": title, "artist": artist, "album": album, "albumArtist": albumArtist, "genre": genre,
            "year": year, "no": no, "disc": disc, "dur": dur.isFinite ? dur : 0, "mime": mime,
            "kbps": kbps, "rate": rate, "bits": bits, "cover": cover
        ]
    }

    static func saveScaled(_ data: Data, _ dst: URL, _ maxSide: CGFloat) -> Bool {
        guard let img = UIImage(data: data) else { return false }
        let w = img.size.width, h = img.size.height
        guard w > 0, h > 0 else { return false }
        let k = min(1, maxSide / max(w, h))
        let size = CGSize(width: floor(w * k), height: floor(h * k))
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpg = out.jpegData(compressionQuality: 0.88) else { return false }
        return (try? jpg.write(to: dst)) != nil
    }

    // MARK: methods
    @objc func probe(_ call: CAPPluginCall) {
        let paths = call.getArray("paths", String.self) ?? []
        io.async {
            var out: [[String: Any]] = []
            for p in paths {
                guard let u = self.insideMusic(URL(fileURLWithPath: p)) else { continue }
                if let t = self.probeFile(u) { out.append(t) }
            }
            call.resolve(["tracks": out])
        }
    }

    /// iOS apps can't read other apps' files: "Scan" only picks up songs put into Files → On My iPhone → Teto.
    @objc func scanDevice(_ call: CAPPluginCall) {
        call.resolve(["items": [], "unsupported": true])
    }

    @objc func importUris(_ call: CAPPluginCall) {
        let urls = (call.getArray("uris", String.self) ?? []).compactMap { URL(string: $0) }
        if !urls.isEmpty { importURLs(urls, scoped: true) }
        call.resolve()
    }

    @objc func openUrl(_ call: CAPPluginCall) {
        guard let u = URL(string: call.getString("url") ?? "") else { call.reject("url"); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(u, options: [:]) { ok in ok ? call.resolve() : call.reject("open") }
        }
    }

    /// Monthly report: share a PNG (base64) through the share sheet.
    @objc func shareImage(_ call: CAPPluginCall) {
        guard let data = Data(base64Encoded: call.getString("data") ?? "") else { call.reject("data"); return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(TetoPlugin.sanitize(call.getString("name") ?? "teto.png"))
        do { try data.write(to: url) } catch { call.reject("write"); return }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("no view"); return }
            let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            av.popoverPresentationController?.sourceView = vc.view
            av.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
            vc.present(av, animated: true) { call.resolve() }
        }
    }

    /// "Download" (YouTube Music): no in-app extractor on iOS — the UI opens the YouTube Music search instead.
    @objc func ytSearch(_ call: CAPPluginCall) { call.reject("YouTube Music download is not available on iOS") }
    @objc func ytDownload(_ call: CAPPluginCall) { call.reject("YouTube Music download is not available on iOS") }
    @objc func ytAccount(_ call: CAPPluginCall) { call.resolve(["signedIn": false]) }
    @objc func ytLogin(_ call: CAPPluginCall) { call.resolve(["signedIn": false]) }
    @objc func ytLogout(_ call: CAPPluginCall) { call.resolve() }
    // iPhone downloads run in the web layer (src/mobile/backend/netdl.ts): plain HTTPS, no yt-dlp
    @objc func dlEngine(_ call: CAPPluginCall) { call.resolve(["ready": true, "updating": false, "version": "iOS", "error": ""]) }

    /// Downloads: temporary files in Caches/dl (never seen by the library scan), written in base64 pieces.
    var dlDir: URL {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("dl", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    @objc func writeChunk(_ call: CAPPluginCall) {
        let name = TetoPlugin.sanitize(call.getString("name") ?? "dl.part")
        let b64 = call.getString("data") ?? ""
        let append = call.getBool("append") ?? false
        io.async {
            guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { call.reject("bad data"); return }
            let f = self.dlDir.appendingPathComponent(name)
            do {
                if append, FileManager.default.fileExists(atPath: f.path), let h = try? FileHandle(forWritingTo: f) {
                    try h.seekToEnd()
                    try h.write(contentsOf: data)
                    try h.close()
                } else {
                    try data.write(to: f, options: .atomic)
                }
                call.resolve(["path": f.path])
            } catch { call.reject("write failed: \(error.localizedDescription)") }
        }
    }
    /// Moves a finished download into the library (Documents) under a clean, unique name.
    @objc func finishFile(_ call: CAPPluginCall) {
        let tmp = URL(fileURLWithPath: call.getString("tmp") ?? "")
        let name = TetoPlugin.sanitize(call.getString("name") ?? "track.mp3")
        io.async {
            let root = self.dlDir.resolvingSymlinksInPath().path + "/"
            guard tmp.resolvingSymlinksInPath().path.hasPrefix(root), FileManager.default.fileExists(atPath: tmp.path) else { call.reject("no file"); return }
            let want = self.musicDir.appendingPathComponent(name)
            let dst = FileManager.default.fileExists(atPath: want.path) ? TetoPlugin.unique(want) : want
            do { try FileManager.default.moveItem(at: tmp, to: dst); call.resolve(["path": dst.path]) }
            catch { call.reject("move failed: \(error.localizedDescription)") }
        }
    }

    /// VK Music: the official VK sign-in page in a sheet; the token comes back in the redirect (Teto never sees the password).
    private var vkCall: CAPPluginCall?
    private var vkVC: UIViewController?
    @objc func vkLogin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("no view"); return }
            self.vkCall = call
            let vc = UIViewController()
            let cfg = WKWebViewConfiguration()
            cfg.websiteDataStore = .nonPersistent()
            let web = WKWebView(frame: .zero, configuration: cfg)
            web.navigationDelegate = self
            web.translatesAutoresizingMaskIntoConstraints = false
            vc.view.backgroundColor = .systemBackground
            vc.view.addSubview(web)
            let bar = UINavigationBar()
            bar.translatesAutoresizingMaskIntoConstraints = false
            let item = UINavigationItem(title: "ВКонтакте")
            item.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.vkFinish(nil, "Отменено") })
            bar.setItems([item], animated: false)
            vc.view.addSubview(bar)
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor),
                bar.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor), bar.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
                web.topAnchor.constraint(equalTo: bar.bottomAnchor), web.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
                web.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor), web.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
            ])
            vc.isModalInPresentation = true
            self.vkVC = vc
            host.present(vc, animated: true)
            let url = "https://oauth.vk.com/authorize?client_id=2685278&display=mobile&redirect_uri=https://oauth.vk.com/blank.html&scope=audio,offline&response_type=token&revoke=1&v=5.131"
            web.load(URLRequest(url: URL(string: url)!))
        }
    }
    func vkFinish(_ r: [String: Any]?, _ err: String?) {
        guard let call = vkCall else { return }
        vkCall = nil
        let vc = vkVC; vkVC = nil
        vc?.dismiss(animated: true)
        if let r = r { call.resolve(r) } else { call.reject(err ?? "Отменено") }
    }
    @objc func dlUpdate(_ call: CAPPluginCall) { call.reject("Download is not available on iOS") }
    @objc func dlCancel(_ call: CAPPluginCall) { call.resolve() }

    @objc func listMusic(_ call: CAPPluginCall) {
        let fm = FileManager.default
        let root = musicDir
        var out: [[String: Any]] = []
        if let en = fm.enumerator(atPath: root.path) {
            while let rel = en.nextObject() as? String {
                if rel == "Inbox" || rel.hasPrefix("Inbox/") || rel.hasPrefix(".") || rel.contains("/.") { continue }
                let u = root.appendingPathComponent(rel)
                var dir: ObjCBool = false
                guard fm.fileExists(atPath: u.path, isDirectory: &dir), !dir.boolValue else { continue }
                if rel.hasSuffix(".part") { try? fm.removeItem(at: u); continue }
                guard TetoPlugin.audioExt.contains(u.pathExtension.lowercased()) else { continue }
                let size = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                out.append(["path": u.path, "size": size])
            }
        }
        call.resolve(["files": out])
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        let p = call.getString("path") ?? ""
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
        let u = URL(fileURLWithPath: p)
        if !p.isEmpty && u.resolvingSymlinksInPath().path.hasPrefix(home) { try? FileManager.default.removeItem(at: u) }
        call.resolve()
    }

    @objc func saveImage(_ call: CAPPluginCall) {
        let name = TetoPlugin.sanitize(call.getString("name") ?? "img_\(Int(Date().timeIntervalSince1970)).jpg")
        let b64 = call.getString("data") ?? ""
        io.async {
            guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { call.reject("bad image"); return }
            let f = self.coverDir.appendingPathComponent(name)
            do { try data.write(to: f); call.resolve(["path": f.path]) } catch { call.reject("save failed") }
        }
    }

    @objc func session(_ call: CAPPluginCall) { call.resolve() } // lock screen: Media Session API in JS
    @objc func stopSession(_ call: CAPPluginCall) { call.resolve() }

    @objc func info(_ call: CAPPluginCall) {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.9.0"
        var free: Int64 = 0
        if let r = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let c = r.volumeAvailableCapacityForImportantUsage { free = c }
        call.resolve(["version": v, "storage": musicDir.path, "free": free, "home": NSHomeDirectory()])
    }
}

extension TetoPlugin: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url, u.absoluteString.hasPrefix("https://oauth.vk.com/blank.html") else { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        var q: [String: String] = [:]
        for part in (u.fragment ?? u.query ?? "").split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { q[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        if let token = q["access_token"], !token.isEmpty { vkFinish(["token": token, "user": q["user_id"] ?? ""], nil) }
        else { vkFinish(nil, q["error_description"] ?? q["error"] ?? "Вход не выполнен") }
    }
}
