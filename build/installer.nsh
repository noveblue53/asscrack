; P9B: the per-user installer (electron-builder nsis target, package.json "dist:installer").
; At uninstall, delete the start entry of "Start in the tray when I sign in" (src/application/start-at-sign-in.mjs,
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
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Choose a folder you can write to. Program Files and the Windows folder aren't allowed (no admin rights)."

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

; 1.0.1 (operator request 2026-11-22): the installer has the look of the app, as far as NSIS Modern UI 2 allows.
; - The font of the app (Segoe UI) for all pages, and the title font of the app (Trebuchet MS, bold, italic) for the
;   title of the Welcome page.
; - The colors of the Aero Classic theme (themes.css, the default theme): the surface-raised color for the header
;   and the Welcome and Finish pages, the ink color for their text, and the accent color for the Welcome title.
; - The art: build/installerSidebar.bmp (Welcome and Finish pages, also of the uninstaller) and
;   build/installerHeader.bmp (the header of the other pages). build/make-installer-art.cjs makes them from
;   src/application/img/logo.svg. electron-builder finds them by their names in build/.
; The page bodies, the buttons, the fields and the progress bar are standard Windows controls. NSIS cannot give them
; the glass, the gradients or the dark themes of the app, and the installer cannot follow the theme of the View menu.
SetFont "Segoe UI" 9
!define MUI_BGCOLOR "F1FAF5"
!define MUI_TEXTCOLOR "182F28"

!ifndef BUILD_UNINSTALLER
  ; The Welcome page comes first. An update (--updated) does not show it.
  !macro customWelcomePage
    !insertmacro skipPageIfUpdated
    !define MUI_WELCOMEPAGE_TITLE "Welcome to ASSCRACK"
    !define MUI_WELCOMEPAGE_TEXT "Chat, talk, share files and screens with friends on your network or over the internet. No central server.$\r$\n$\r$\nInstalls for your account only. No admin rights needed.$\r$\n$\r$\nClick Next to continue."
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW asscrackWelcomeShow
    !insertmacro MUI_PAGE_WELCOME

    ; Here, after MUI2.nsh and the page: the page variables and WM_SETFONT are known.
    Function asscrackWelcomeShow
      Push $0
      CreateFont $0 "Trebuchet MS" "15" "700" /ITALIC
      SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $0 0
      SetCtlColors $mui.WelcomePage.Title "12634D" "${MUI_BGCOLOR}"
      Pop $0
    FunctionEnd
  !macroend

  !define MUI_FINISHPAGE_TITLE "ASSCRACK is installed"
  !define MUI_FINISHPAGE_TEXT "Start it from the Start menu or the desktop shortcut.$\r$\n$\r$\nClick Finish to close."
!endif
