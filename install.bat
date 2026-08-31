@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Guma - setting up your shop
echo ============================

echo.
echo === Checking for Node.js ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed.
  echo Get the free LTS version at https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   found %%v

echo.
echo === Installing Guma's own pieces ^(first run only - a minute or two^) ===
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Scroll up for the actual error - it's usually a network
  echo problem or a Node version that's too old ^(Guma needs 18+^).
  pause
  exit /b 1
)
echo   done

if not exist ".env" (
  echo.
  echo === Guma needs its own database - Supabase's free tier is plenty, and it's yours, not shared with anyone else's shop ===
  echo.
  echo   1. Go to https://supabase.com and sign up ^(free^).
  echo   2. Click "New project" and give it any name.
  echo   3. Wait about two minutes for it to finish setting up.
  echo   4. In the project, open Project Settings -^> API.
  echo   5. You'll see "Project URL" and an "anon" / "publishable" key - copy each one below when asked.
  echo.
  set /p SUPA_URL="Paste your Project URL: "
  set /p SUPA_KEY="Paste your anon/publishable key: "
  if "!SUPA_URL!"=="" (
    echo Both values are needed. Run this again once you have them.
    pause
    exit /b 1
  )
  if "!SUPA_KEY!"=="" (
    echo Both values are needed. Run this again once you have them.
    pause
    exit /b 1
  )
  (
    echo VITE_SUPABASE_URL=!SUPA_URL!
    echo VITE_SUPABASE_ANON_KEY=!SUPA_KEY!
  ) > .env
  echo   saved to .env

  echo.
  echo   ! One manual step left - Supabase doesn't let outside scripts touch your
  echo     database automatically, on purpose.
  echo   In your Supabase project, open the SQL Editor ^(left sidebar^), and run each
  echo   file in supabase\migrations\ , in order: 0001, then 0002, then 0003, then 0004.
  echo   Paste each file's contents in, click Run, then move to the next file.
  echo.
  pause
) else (
  echo   .env already set up from a previous run
)

echo.
echo === Starting Guma ===
echo   Opening http://localhost:5173 in your browser in a few seconds...
echo   Leave this window open while you use Guma - closing it stops the shop.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5173"
call npm run dev
