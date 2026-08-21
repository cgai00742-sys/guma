#!/usr/bin/env bash
# Build and ship Guma to the live site.
#
#   ./deploy.sh
#
# Run it from this folder. Nothing else to remember.

set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

# The Pages project is named `guma`. The subdomain is guma-8jn.pages.dev because
# pages.dev subdomains are globally unique and `guma.pages.dev` was taken.
# Pointing wrangler at `guma-8jn` creates a SECOND, EMPTY project instead of
# deploying to this one — that already happened once.
PROJECT="guma"
SITE="https://guma-8jn.pages.dev"

say()  { printf "\n\033[36m==>\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
die()  { printf "\n\033[31m✗ %s\033[0m\n\n" "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node is not installed — https://nodejs.org"

say "Testing the pricing engine"
[ -d node_modules ] || npm install
npm test --silent || die "Pricing tests failed. Not shipping a quote calculator that does not add up."
ok "23 tests pass"

say "Building"
npm run build >/dev/null
[ -f dist/index.html ]  || die "No dist/index.html."
[ -f dist/_redirects ]  || die "dist/_redirects missing — deep links would 404."
ok "dist/ built"

say "Deploying to Cloudflare Pages project '$PROJECT'"
npx --yes wrangler@latest pages deploy dist --project-name "$PROJECT" --branch main

say "Checking the live site"
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/")
DEEP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/settings")
[ "$HOME_CODE" = "200" ] && ok "GET /          200" || printf "  \033[33m!\033[0m GET /          %s\n" "$HOME_CODE"
[ "$DEEP_CODE" = "200" ] && ok "GET /settings  200 (SPA fallback works)" \
                         || printf "  \033[33m!\033[0m GET /settings  %s — _redirects did not take\n" "$DEEP_CODE"

printf "\n  Live at %s\n\n" "$SITE"
