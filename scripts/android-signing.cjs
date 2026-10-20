// Sign the Android app with the repo's fixed key (android-signing/debug.keystore), so a new
// APK installs over the old one without losing the phone's setup. Runs in CI after `cap add`.
const fs = require('fs');
const f = 'android/app/build.gradle';
let s = fs.readFileSync(f, 'utf8');
if (!s.includes('android-signing/debug.keystore')) {
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
console.log('signing config:', s.includes('android-signing/debug.keystore') ? 'set' : 'MISSING', '| version', n);
