plugins {
    id("com.android.application")
}

android {
    namespace = "dev.phi.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.phi.android"
        minSdk = 29
        targetSdk = 37
        versionCode = 3
        versionName = "0.6"
    }

    buildTypes {
        debug {
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("com.google.android.material:material:1.14.0")
    testImplementation("junit:junit:4.13.2")
}

/**
 * Shared vendoring: the ONLY sidecar is desktop's vendor-web.mjs, which
 * already produces a verbatim repo-root web/ copy at
 * desktop/electron/embedded/ (gitignored build artifact). This task
 * re-runs that script and syncs its output into the APK's assets, so the
 * phone serves the same bytes the desktop embeds — one script, one
 * source of truth, no parallel pipeline. Runs on every build via
 * preBuild, so the APK can never go stale against web/ silently.
 */
val repoRoot = rootDir.parentFile // repo root (settings root is android/)
val vendorWeb = tasks.register<Exec>("vendorWeb") {
    commandLine("node", "${repoRoot}/desktop/electron/scripts/vendor-web.mjs")
    inputs.dir("${repoRoot}/web")
    outputs.dir("${repoRoot}/desktop/electron/embedded")
}
val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    dependsOn(vendorWeb)
    from("${repoRoot}/desktop/electron/embedded")
    into(layout.buildDirectory.dir("vendor-web/www"))
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }

android {
    sourceSets {
        named("main") {
            assets.srcDir(layout.buildDirectory.dir("vendor-web/www"))
        }
    }
}
