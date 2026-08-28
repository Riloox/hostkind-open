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
    // This local target deliberately skips Authenticode. The public release
    // workflow does not publish this installer.
    signExecutable: false,
    // The updater validates its Ed25519 manifest plus SHA-256 artifact hash;
    // that is separate from Windows Authenticode.
    verifyUpdateCodeSignature: false,
  },

  // Do not silently turn a local unsigned build into a release claim. A trusted
  // Authenticode certificate is unavailable in this project; publication of a
  // Windows installer is therefore intentionally kept out of CI.
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
