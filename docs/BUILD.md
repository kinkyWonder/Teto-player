# Сборка

Всё собирается из одного дерева. Сначала всегда собирается веб-интерфейс (`dist/`), потом нужная оболочка.

| Цель | Команда | Результат |
|---|---|---|
| Веб-интерфейс | `npm ci && npm run build` (= `scripts/build-web.sh`) | `dist/` |
| Android APK | `scripts/build-android.sh` | `android/app/build/outputs/apk/release/app-release.apk` |
| Windows (на Windows) | `npm run tauri build` | exe + установщик NSIS в `src-tauri/target/release/` |
| Windows (из Linux) | `scripts/build-windows.sh` | `src-tauri/target/x86_64-pc-windows-msvc/release/teto-player.exe` |
| iPhone | GitHub Actions → «Сборка для iPhone» (`.github/workflows/ios.yml`; можно загрузить в репозиторий только zip исходников) | артефакт `Teto.ipa` (без подписи) |
| WASM namefix | `scripts/build-wasm.sh` | `src/mobile/backend/namefix.wasm` |

Предпросмотр без сборки оболочек: `npm run dev` → `http://localhost:1420/` (ПК) и `/?mobile` (телефон), бэкенд заменяется демо-данными (`src/app/mock.ts`).
Месячный отчёт в предпросмотре: в консоли `__report('2026-09', true)`.

## Требования
- Node.js 20+.
- Windows: Rust (MSVC), Visual Studio Build Tools (C++). Из Linux: `rustup target add x86_64-pc-windows-msvc`, `cargo install cargo-xwin`, clang, lld, llvm.
  Без `--features custom-protocol` exe пытается открыть dev-сервер `localhost:1420`.
- Android: JDK 21, Android SDK (platform 36, build-tools 36). Путь к SDK — `ANDROID_HOME` или `android/local.properties` (`sdk.dir=...`).
  «Скачать» — `io.github.junkfood02.youtubedl-android` (library + ffmpeg, Maven Central): yt-dlp и FFmpeg внутри APK, только `arm64-v8a`, нужна распакованная упаковка native-библиотек (`useLegacyPackaging`, `extractNativeLibs`). yt-dlp сам обновляется раз в день.
- iPhone, скачивание: без yt-dlp (Apple не разрешает Python/FFmpeg) — чистый HTTPS в веб-слое `src/mobile/backend/netdl.ts`, файлы пишет плагин (`writeChunk` / `finishFile` в `ios/App/App/AppDelegate.swift`).
- Windows, «Скачать»: `yt-dlp.exe` не входит в сборку — программа сама скачивает его с GitHub при первом нажатии в `%LOCALAPPDATA%\Teto Player\bin` и обновляет раз в 2 недели.
- WASM: `rustup target add wasm32-unknown-unknown`.

## Подпись Android
Ключ релиза: `android/keystore/teto-release.jks`, пароли — в `android/keystore.properties`:
```
storeFile=keystore/teto-release.jks
storePassword=...
keyAlias=teto
keyPassword=...
```
Оба файла в `.gitignore`, их нельзя публиковать. Если файла нет, `assembleRelease` подписывает debug-ключом (для проверки).
Все обновления должны подписываться **тем же** ключом, иначе Android не установит APK поверх старого.
Новый ключ: `keytool -genkeypair -keystore android/keystore/teto-release.jks -storetype PKCS12 -alias teto -keyalg RSA -keysize 4096 -validity 36500`.

## Тесты
- Rust: `cd src-tauri && cargo test --lib --no-default-features` (на Linux нужен `alsa-lib-devel`).
- TypeScript: `npx tsc --noEmit`. Непереведённые строки: каждая строка `t('…')` должна быть в `src/i18n/en.ts`.

## Сгенерированные файлы (не хранить в репозитории)
`dist/`, `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `namefix-wasm/target/`, `android/app/build/`, `android/.gradle/`,
`android/app/src/main/assets/public/`, `android/app/src/main/assets/capacitor.*.json`, `android/capacitor-cordova-android-plugins/`,
`ios/capacitor-cordova-ios-plugins/`, `ios/App/App/public/`, `ios/App/App/capacitor.config.json`, `ios/App/App/config.xml`.
Capacitor-файлы заново создаёт `npx cap sync android|ios`.
