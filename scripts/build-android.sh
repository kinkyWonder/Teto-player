#!/usr/bin/env sh
# Android release APK. Needs JDK 21 + Android SDK (ANDROID_HOME or android/local.properties).
set -e
cd "$(dirname "$0")/.."
sh scripts/build-web.sh
npx cap sync android
cd android && ./gradlew assembleRelease
echo "APK: android/app/build/outputs/apk/release/app-release.apk"
