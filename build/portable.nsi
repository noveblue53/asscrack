!include "common.nsh"
!include "extractAppPackage.nsh"

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

# ASSCRACK (F1, goal 7): this file is the portable.nsi template of app-builder-lib 26.18.0 with a check for a
# running copy. build/portable-launcher.cjs gives it to electron-builder in place of the stock template.
# Result 1: the exe in $INSTDIR exists and an open for write fails, because Windows locks the image file of a
# running process. Result 0: no exe, or the open succeeds (no copy runs). Mode "a" (OPEN_ALWAYS) does not
# truncate, and the file exists, so the open does not create a file.
!macro asscrackIsRunning RESULT
  StrCpy ${RESULT} 0
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    FileOpen $R3 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    ${if} ${Errors}
      StrCpy ${RESULT} 1
    ${else}
      FileClose $R3
    ${endIf}
  ${endIf}
!macroend

Function .onInit
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  !endif
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
  !endif

  # ASSCRACK: when a copy of the app runs from $INSTDIR (the same or an other build), do not delete or unpack.
  # Start the existing exe with the same arguments and exit. The single instance lock of the app then shows the
  # window of the running copy.
  !insertmacro asscrackIsRunning $R1
  ${if} $R1 == 1
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
    ${StdUtils.GetAllParameters} $R0 0
    SetOutPath $EXEDIR
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0'
    SetErrorLevel 0
    Quit
  ${endIf}

  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        {endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif

  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

	ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
  # ASSCRACK: delete the unpack folder only when no copy of the app runs from it. A copy that a second launcher
  # started, or a child process that did not stop yet, keeps the exe locked. Try for 5 s, then keep the folder.
  # The next launcher deletes it before it unpacks.
  StrCpy $R2 0
  ${do}
    !insertmacro asscrackIsRunning $R1
    ${if} $R1 == 0
      RMDir /r $INSTDIR
      ${break}
    ${endIf}
    IntOp $R2 $R2 + 1
    ${if} $R2 >= 5
      ${break}
    ${endIf}
    Sleep 1000
  ${loop}
SectionEnd
