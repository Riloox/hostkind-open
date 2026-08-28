# Windows desktop build

Hostkind's Windows desktop entry points are `electron/main.cjs` and
`electron/runtime.cjs`. The private checkout keeps `server.js` as its normal
Node entry point; `packaging/windows/electron-builder.cjs` overrides the
Electron application entry to `electron/main.cjs`.

See [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md) for the release policy.

## Local checks

Run the source desktop smoke test:

```text
npm run desktop:smoke
```

Build the unpacked Windows application:

```text
npm run desktop:pack
```

Build the local NSIS installer:

```text
npm run desktop:dist
```

The local NSIS output is intentionally unsigned. It is a development artifact,
not a Smart App Control-compatible release. Do not disable Smart App Control or
Defender to force it to run.

The exact packaged archive can still be exercised through the installed
Electron runtime:

```text
npm run desktop:smoke:packaged-asar
```

The real packaged executable smoke test is:

```text
npm run desktop:smoke:packaged
```

It can be refused by Smart App Control because the local executable is unsigned.
That is expected security behavior. The public tag release does not publish
this installer.
