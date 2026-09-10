'use strict';

module.exports = {
  // The private Node package keeps server.js as its normal entry point; the
  // desktop build overrides it with electron/main.cjs below.
  appId: 'io.github.riloox.hostkind',
  productName: 'Hostkind',
  executableName: 'Hostkind',

  directories: {
    output: 'dist-electron',
    buildResources: 'build',
  },

  extraMetadata: {
    main: 'electron/main.cjs',
  },

  // Explicit allow-list: do not ship tests, source JSX, CI files, or private
  // planning material. The updater helper scripts are runtime dependencies.
  files: [
    'server.js',
    'electron/**',
    'lib/**',
    'public/**',
    'resources/**',
    'scripts/apply-application-update.cjs',
    'scripts/hostkind-bootstrap.cjs',
    'i18n.cjs',
    'i18n.json',
    'config.example.json',
    'package.json',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
  ],

  asar: true,

  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    // 0.1.2.3: the public release publishes this installer unsigned, with a
    // portable-zip fallback for hosts where Smart App Control blocks it. The
    // in-app updater still validates its Ed25519 manifest plus SHA-256
    // artifact hash; that is separate from Windows Authenticode and does not
    // make the installer trusted by Smart App Control. Never instruct users
    // to disable Smart App Control or Defender to run it.
    signExecutable: false,
    // The updater validates its Ed25519 manifest plus SHA-256 artifact hash;
    // that is separate from Windows Authenticode.
    verifyUpdateCodeSignature: false,
  },

  // 0.1.2.3: Linux desktop targets for non-technical users. The .deb covers
  // Ubuntu/Debian double-click installs; the AppImage is the portable
  // fallback for other distributions (chmod +x, then double-click). No custom
  // icon is referenced so a missing build/ directory never breaks the build;
  // packaging falls back to the default Electron icons.
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
      {
        target: 'deb',
        arch: ['x64'],
      },
    ],
    category: 'Utility',
    maintainer: 'Federico Prunell Alza',
    description: 'Self-hosted web panel for managing servers and long-running processes',
  },

  appImage: {
    artifactName: 'Hostkind-${version}.AppImage',
  },

  deb: {
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
  },

  // The portable fallback for Windows is not a second electron-builder
  // target: scripts/collect-installer-artifacts.cjs zips dist-electron's
  // win-unpacked directory into Hostkind-<version>-Portable.zip, so blocked
  // users can run Hostkind.exe without going through the NSIS installer.

  // Do not silently turn a local unsigned build into a trusted-release claim.
  // A trusted Authenticode certificate is unavailable in this project, so the
  // 0.1.2.3 Windows installer ships unsigned with a documented Smart App
  // Control / SmartScreen warning plus a portable-zip fallback.
  forceCodeSigning: false,

  nsis: {
    oneClick: true,
    perMachine: true,
    allowElevation: true,
    deleteAppDataOnUninstall: false,
    artifactName: 'Hostkind-${version}-Setup.${ext}',
    shortcutName: 'Hostkind',
    uninstallDisplayName: 'Hostkind',
  },
};
