#!/usr/bin/env bash
#
# Guma — double-click installer for macOS.
#
# This is the whole point of this file: someone who downloaded Guma from
# GitHub and has never opened a terminal in their life should be able to
# double-click this and end up with a running shop. It checks for what it
# needs, explains in plain language what's missing when something is, and
# never silently fails.

set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

say()  { printf "\n\033[36m==>\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  {
  printf "\n\033[31m✗ %s\033[0m\n\n" "$1" >&2
  read -r -p "Press Enter to close this window..." _
  exit 1
}

echo "Guma — setting up your shop"
echo "============================"

say "Checking for Node.js"
if ! command -v node >/dev/null 2>&1; then
  die "Node.js isn't installed. Get the free LTS version at https://nodejs.org, then double-click this file again."
fi
ok "found $(node -v)"

say "Installing Guma's own pieces (first run only — a minute or two)"
if ! npm install; then
  die "npm install failed. Scroll up for the actual error — it's usually a network problem or a Node version that's too old (Guma needs 18+)."
fi
ok "done"

if [ ! -f .env ]; then
  say "Guma needs its own database — Supabase's free tier is plenty, and it's yours, not shared with anyone else's shop"
  echo ""
  echo "  1. Go to https://supabase.com and sign up (free)."
  echo "  2. Click 'New project' and give it any name."
  echo "  3. Wait about two minutes for it to finish setting up."
  echo "  4. In the project, open Project Settings -> API."
  echo "  5. You'll see 'Project URL' and an 'anon' / 'publishable' key — copy each one below when asked."
  echo ""
  read -r -p "Paste your Project URL: " SUPA_URL
  read -r -p "Paste your anon/publishable key: " SUPA_KEY
  if [ -z "$SUPA_URL" ] || [ -z "$SUPA_KEY" ]; then
    die "Both values are needed. Run this again once you have them."
  fi
  {
    echo "VITE_SUPABASE_URL=$SUPA_URL"
    echo "VITE_SUPABASE_ANON_KEY=$SUPA_KEY"
  } > .env
  ok "saved to .env"

  echo ""
  warn "One manual step left — Supabase doesn't let outside scripts touch your database automatically, on purpose."
  echo "  In your Supabase project, open the SQL Editor (left sidebar), and run each file in"
  echo "  supabase/migrations/ , in order: 0001, then 0002, then 0003, then 0004."
  echo "  Paste each file's contents in, click Run, then move to the next file."
  echo ""
  read -r -p "Press Enter once all four have run successfully..." _
else
  ok ".env already set up from a previous run"
fi

say "Starting Guma"
echo "  Opening http://localhost:5173 in your browser in a few seconds..."
echo "  Leave this window open while you use Guma — closing it stops the shop."
( sleep 3 && open "http://localhost:5173" >/dev/null 2>&1 ) &
npm run dev
