; Tauri sets INSTALLERICON after including hooks. NSIS resolves this reference
; when MUI_INTERFACE initializes both icons at the first installer page.
!ifndef HELM_NSIS_BRANDING
!define HELM_NSIS_BRANDING
!ifndef MUI_UNICON
!define MUI_UNICON "${INSTALLERICON}"
!endif
!endif
