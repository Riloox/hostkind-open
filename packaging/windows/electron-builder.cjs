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
    'config/**',
    'lib/**',
    'public/**',
    'resources/**',
    'scripts/apply-application-update.cjs',
    'scripts/hostkind-bootstrap.cjs',
    'scripts/resolve-port.cjs',
    'i18n.cjs',
    'i18n.json',
    'config.example.json',
    'package.json',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    // better-sqlite3 ships its C sources and electron-rebuild leaves the whole
    // MSVC build tree behind (~46 MB). At runtime `bindings` only loads
    // build/Release/better_sqlite3.node.
    '!node_modules/better-sqlite3/{deps,src,bin}/**',
    '!node_modules/better-sqlite3/build/{deps,Release/obj}/**',
    '!node_modules/better-sqlite3/build/*.{vcxproj,filters,sln,gypi,mk}',
    '!node_modules/better-sqlite3/build/Release/*.{exp,iobj,ipdb,lib,pdb}',
    '!node_modules/better-sqlite3/build/Release/test_extension.*',
  ],

  asar: true,

  // Chromium's own UI strings (context menus, dialogs). The panel has its
  // own i18n (i18n.json: en, es); ship only the matching Chromium locales
  // instead of all 55 (~46 MB).
  electronLanguages: ['en-US', 'es', 'es-419'],

  // Smaller installer and portable zip at the cost of a slower NSIS build.
  compression: 'maximum',

  // App, installer and window icons come from the Hostkind logo
  // (resources/hostkind.svg). build/ is electron-builder's buildResources.
  icon: 'build/icon.png',

  win: {
    icon: 'build/icon.ico',
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
  // fallback for other distributions (chmod +x, then double-click).
  linux: {
    icon: 'build/icon.png',
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
    // Keep the profile by default; build/uninstaller.nsh prompts on a manual
    // uninstall and deletes %APPDATA%\Hostkind only when the user chooses to.
    deleteAppDataOnUninstall: false,
    include: 'build/uninstaller.nsh',
    artifactName: 'Hostkind-${version}-Setup.${ext}',
    shortcutName: 'Hostkind',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    uninstallDisplayName: 'Hostkind',
  },
};
