@echo off
setlocal
if "%~2"=="" (
  echo Usage: win-local-build.cmd TAG BUNDLE
  exit /b 1
)
set "bundle=%~f2"
if not exist "%bundle%" set "bundle=%USERPROFILE%\%~2"
if not exist "%bundle%" (
  echo Bundle not found.
  exit /b 1
)

rem Each run owns a new checkout. Keep older checkouts and their installers intact.
:choose_directory
set "build_dir=%TEMP%\hopline-build-%RANDOM%-%RANDOM%"
if exist "%build_dir%" goto choose_directory
mkdir "%build_dir%" || exit /b 1
echo Building in "%build_dir%"
git clone -q -b "%~1" -- "%bundle%" "%build_dir%" || exit /b 1
cd /d "%build_dir%" || exit /b 1
call npx -y npm@11.6.2 ci --ignore-scripts --no-audit --no-fund || exit /b 2
call npm run dist:win -w @hopline/desktop || exit /b 3
start "" /b /wait apps\desktop\release\win-unpacked\hopline.exe --smoke || exit /b 4
node.exe apps\desktop\scripts\check-fuses.mjs apps\desktop\release\win-unpacked\hopline.exe win32 || exit /b 5
echo Verified installer:
dir /b /s "apps\desktop\release\Hopline-*-win-x64.exe"
