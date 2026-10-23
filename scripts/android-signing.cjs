// Sign the Android app. Two ways:
//  1. PRIVATE RELEASE KEY (for selling): set four GitHub repository secrets —
//     ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.
//     The workflow writes the keystore to android-signing/release.keystore (never committed) and
//     builds a release APK signed with it. Keys come only from secrets; nothing secret is in this repo.
//  2. Otherwise the old TEST key in android-signing/debug.keystore (public — only for testing).
// Runs in CI after `cap add`. Prints which one it used.
const fs = require('fs');
const f = 'android/app/build.gradle';
let s = fs.readFileSync(f, 'utf8');
const release = !!(process.env.ANDROID_KEYSTORE_PASSWORD && process.env.ANDROID_KEY_ALIAS && fs.existsSync('android-signing/release.keystore'));
if (release && !s.includes('signingConfigs.release')) {
  s = s.replace(/android\s*\{/, m => `${m}
    signingConfigs {
        release {
            storeFile file("../../android-signing/release.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
        }
    }
`);
  s = s.replace(/buildTypes\s*\{\s*release\s*\{/, m => `${m}\n            signingConfig signingConfigs.release`);
} else if (!release && !s.includes('android-signing/debug.keystore')) {
  s = s.replace(/android\s*\{/, m => `${m}
    signingConfigs {
        debug {
            storeFile file("../../android-signing/debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
`);
}
// A higher version on every build, so Android installs it as an upgrade.
const n = Number(process.env.GITHUB_RUN_NUMBER || 1);
s = s.replace(/versionCode \d+/, `versionCode ${n}`).replace(/versionName "[^"]*"/, `versionName "1.0.${n}"`);
fs.writeFileSync(f, s);
fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null', `APK_KIND=${release ? 'release' : 'debug'}\n`);
console.log('signing:', release ? 'PRIVATE release key (from secrets)' : 'TEST key (public) — set the 4 ANDROID_* secrets before selling', '| version', n);
