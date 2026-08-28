# Windows distribution

Hostkind's public tag release currently ships the source/web distribution only. It does not publish a Windows installer because no trusted Authenticode signing material is available.

## Local desktop builds

The Electron entry points are `electron/main.cjs` and `electron/runtime.cjs`. The packager configuration is `packaging/windows/electron-builder.cjs`.

Build the source desktop smoke test:

```text
npm run desktop:smoke
```

Build the unpacked Windows application:

```text
npm run desktop:pack
```

Build a local NSIS installer:

```text
npm run desktop:dist
```

On a host with Smart App Control enforcing, electron-builder may fail with
`spawn UNKNOWN` while it tries to launch the unsigned generated NSIS artifact to
extract the uninstaller. Do not disable security controls to bypass that step;
use `desktop:pack` and the packaged-ASAR smoke test instead, and do not treat a
partial `dist-electron` output as a distributable release.

All local Windows outputs are explicitly unsigned development artifacts. They
are useful for packaging and updater tests, but they are not Smart App
Control-compatible releases and must not be presented as trusted installers.
Do not disable Smart App Control, Defender, or other Windows security controls
to run them.

The packaged archive can still be exercised through the installed Electron runtime:

```text
npm run desktop:smoke:packaged-asar
```

The direct packaged executable smoke test may be blocked by Smart App Control when the local executable is unsigned:

```text
npm run desktop:smoke:packaged
```

That block is expected protection behavior, not a reason to weaken the host policy.

## Update validation

The application updater validates its Ed25519 release manifest and SHA-256 artifact hash. That protects update integrity, but it is separate from Windows Authenticode and does not make an unsigned installer trusted by Smart App Control.

## Public CI release contract

`.github/workflows/ci.yml` runs the tested source/web release path. It publishes the source package, its checksum, and the signed update manifest only when the corresponding update artifacts exist. It intentionally has no Windows installer publication job or cloud signing login.

A future Windows installer must not be added to the public release until the exact setup executable and installed uninstaller have been signed and verified with a trusted Authenticode chain. No such signing path is configured here.
