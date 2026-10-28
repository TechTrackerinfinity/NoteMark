!macro customInstall
  DetailPrint "Closing older portable NoteMark copies in this Windows session..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\desktop\close-older-copies.ps1" -InstalledProgram "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  DetailPrint "Enabling NoteMark Wi-Fi sync for devices on the local subnet..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\desktop\repair-wifi.ps1" -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "NoteMark was installed, but Windows could not enable Wi-Fi access. In the app, open Settings & sync and choose Repair Wi-Fi access."
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\desktop\repair-wifi.ps1" -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Remove'
  Pop $0
  Pop $1
!macroend
