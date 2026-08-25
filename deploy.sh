#!/usr/bin/env bash
# Build and deploy Guma to Cloudflare Pages.
#
#   ./deploy.sh
#
# Instance-specific settings live in .deploy.env, which is NOT committed —
# your Pages project name is yours, not the project's. Create it once:
#
#   PROJECT=my-guma
#   SITE=https://my-guma.pages.dev
#
# Note the Pages project name and the *.pages.dev subdomain can differ:
# subdomains are globally unique, so a taken name gets a suffix while the
# project keeps the name you asked for. Deploying to the subdomain instead of
# the project name creates a second, empty project.

set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

[ -f .deploy.env ] && . ./.deploy.env
PROJECT="${PROJECT:-}"
SITE="${SITE:-}"

say() { printf "\n\033[36m==>\033[0m %s\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
die() { printf "\n\033[31m✗ %s\033[0m\n\n" "$1" >&2; exit 1; }

[ -n "$PROJECT" ] || die "No PROJECT set. Create .deploy.env with PROJECT=your-pages-project"
command -v node >/dev/null 2>&1 || die "Node is not installed — https://nodejs.org"

say "Testing the pricing engine"
if [ ! -x node_modules/.bin/vitest ] || [ ! -x node_modules/.bin/vite ]; then npm install; fi
npm test --silent || die "Pricing tests failed. Not shipping a quote calculator that does not add up."
ok "tests pass"

say "Building"
npm run build >/dev/null
[ -f dist/index.html ] || die "No dist/index.html."
[ -f dist/_redirects ] || die "dist/_redirects missing — deep links would 404."
ok "dist/ built"

say "Deploying to Pages project '$PROJECT'"
npx --yes wrangler@latest pages deploy dist --project-name "$PROJECT" --branch main

if [ -n "$SITE" ]; then
  say "Checking the live site"
  H=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/")
  D=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/settings")
  [ "$H" = "200" ] && ok "GET /          200" || printf "  \033[33m!\033[0m GET /          %s\n" "$H"
  [ "$D" = "200" ] && ok "GET /settings  200 (SPA fallback works)" \
                   || printf "  \033[33m!\033[0m GET /settings  %s — _redirects did not take\n" "$D"
  printf "\n  Live at %s\n\n" "$SITE"
fi
