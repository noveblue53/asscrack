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

; One data folder (src/application/data-folder.mjs): the installed build keeps its data in $INSTDIR\data. The stock
; uninstaller of electron-builder removes all of $INSTDIR, also at the silent update (--updated) before the new files
; come. This macro removes the program files and keeps the data folder. A normal uninstall also keeps it (package.json
; nsis deleteAppDataOnUninstall false, as the old %APPDATA% data stayed). Then $INSTDIR stays with the data folder only.
!macro customRemoveFiles
  SetOutPath $TEMP
  FindFirst $R1 $R2 "$INSTDIR\*.*"
  asscrackRemoveLoop:
    StrCmp $R2 "" asscrackRemoveDone
    StrCmp $R2 "." asscrackRemoveNext
    StrCmp $R2 ".." asscrackRemoveNext
    StrCmp $R2 "data" asscrackRemoveNext
    IfFileExists "$INSTDIR\$R2\*.*" 0 asscrackRemoveFile
      RMDir /r "$INSTDIR\$R2"
      Goto asscrackRemoveNext
    asscrackRemoveFile:
      Delete "$INSTDIR\$R2"
  asscrackRemoveNext:
    FindNext $R1 $R2
    Goto asscrackRemoveLoop
  asscrackRemoveDone:
  FindClose $R1
  ; Removes $INSTDIR only when it is empty (no data folder).
  RMDir $INSTDIR
!macroend

; The assisted installer (package.json nsis: oneClick false, allowToChangeInstallationDirectory true) shows a folder
; page. The install stays per user: no install mode page, no elevation (allowElevation false). The silent update
; (src/application/updater.mjs) runs "--updated /S /D=<folder of the running exe>" without elevation. An upgrade
; reads the folder of the last install from HKCU InstallLocation.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Select a folder that your user account can write to, for example a folder in your user folder. This installer does not use administrator rights. Thus the Next button stays off for Program Files and the Windows folder."

  ; Push the folder, then the root. Pushes "1" if the folder is the root or is in the root, else "0".
  Function asscrackInRoot
    Exch $1 ; root
    Exch
    Exch $0 ; folder
    Push $2
    Push $3
    StrCpy $3 "0"
    StrCmp $1 "" done
    StrLen $2 $1
    StrCpy $3 $0 $2
    StrCmp $3 $1 0 notIn
      StrCpy $3 $0 1 $2
      StrCmp $3 "" isIn
      StrCmp $3 "\" isIn
    notIn:
      StrCpy $3 "0"
      Goto done
    isIn:
      StrCpy $3 "1"
    done:
    StrCpy $0 $3
    Pop $3
    Pop $2
    Exch $0 ; restore $0, the result is on the stack
    Exch
    Pop $1
  FunctionEnd

  ; The folder page calls this function at each change. Abort turns off the Next button.
  Function .onVerifyInstDir
    Push $0
    Push $INSTDIR
    Push $PROGRAMFILES32
    Call asscrackInRoot
    Pop $0
    StrCmp $0 "1" refuse
    Push $INSTDIR
    Push $PROGRAMFILES64
    Call asscrackInRoot
    Pop $0
    StrCmp $0 "1" refuse
    Push $INSTDIR
    Push $WINDIR
    Call asscrackInRoot
    Pop $0
    StrCmp $0 "1" refuse
    Pop $0
    Return
    refuse:
      Pop $0
      Abort
  FunctionEnd
!endif
