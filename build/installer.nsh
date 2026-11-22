; P9B: the per-user installer (electron-builder nsis target, package.json "dist:installer").
; At uninstall, delete the start entry of "Start as Idle Peer when I sign in" (src/application/start-at-sign-in.mjs,
; RUN_VALUE_NAME) and its Startup apps state. An upgrade runs the old uninstaller with --updated: then the entry stays,
; because the installed path and the arguments do not change.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ASSCRACK"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ASSCRACK"
  ${endIf}
!macroend
