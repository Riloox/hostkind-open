; Hostkind NSIS uninstaller customisation (wired through `nsis.include` in
; packaging/windows/electron-builder.cjs).
;
; The one-click uninstaller runs its section silently after the initial
; "are you sure to uninstall" dialog. A MessageBox that omits the silent
; default still shows while the silent flag is set, so it is the only way to
; ask the user something during a manual uninstall. This macro therefore:
;
;   * never prompts on an update/reinstall (${isUpdated}); the installer
;     passes --updated to the old uninstaller and the profile must survive;
;   * never prompts on a truly silent uninstall (/S, used by the
;     QuietUninstallString and unattended removals), detected from the raw
;     command line before SetSilent takes effect;
;   * otherwise offers to delete %APPDATA%\Hostkind (config.json, data/,
;     running.json, logs/), which is what makes a reinstall prompt for a
;     login again.
;
; Server files, worlds, mods and backups live in Documents\Hostkind and are
; never touched here.

!include "LogicLib.nsh"

!macro customUnInstall
  ; Updates and reinstalls must keep the existing profile.
  ${If} ${isUpdated}
    Goto hostkindKeepUserData
  ${EndIf}

  ; Respect an explicit /S (quiet uninstall) instead of showing a dialog.
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    Goto hostkindKeepUserData
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Delete Hostkind configuration and application data?$\r$\n$\r$\nThis removes the panel configuration, accounts, database, running state and logs from %APPDATA%\Hostkind.$\r$\n$\r$\nServer files, worlds, mods and backups in Documents\Hostkind are kept." \
    IDYES hostkindDeleteUserData IDNO hostkindKeepUserData
  Goto hostkindKeepUserData

  hostkindDeleteUserData:
    ; Electron user data is always per-user, even for a per-machine install.
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Goto hostkindKeepUserData

  hostkindKeepUserData:
!macroend
