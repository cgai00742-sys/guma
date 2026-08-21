#!/usr/bin/env bash
# Guma — go live from the terminal.
#
#   ./golive.sh
#
# Builds the app, deploys it to Cloudflare Pages, then points Supabase auth at
# the URL Cloudflare just handed back. Safe to re-run: creating the Pages
# project is skipped if it exists, and the Supabase config is overwritten with
# the same values.
#
# Written for macOS's stock bash 3.2, so no fancy shell features.

set -euo pipefail

PROJECT="guma"                          # Cloudflare Pages project name
SUPA_REF="lvizayqnnvvruajjjldn"         # Supabase project ref
APP_DIR="$(cd "$(dirname "$0")" && pwd)/guma"

say()  { printf "\n\033[36m==>\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "\n\033[31m✗ %s\033[0m\n\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 0. prereqs
say "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node is not installed. Get it from https://nodejs.org (LTS), then re-run."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR is too old; wrangler needs 18 or newer."
ok "node $(node -v)"

[ -d "$APP_DIR" ] || die "Can't find the app at $APP_DIR — run this script from the folder that contains guma/."
ok "app at $APP_DIR"

# The Supabase personal access token. Create one at:
#   https://supabase.com/dashboard/account/tokens
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  printf "\n  Supabase access token (sbp_...) — https://supabase.com/dashboard/account/tokens\n"
  printf "  Paste it here (input hidden): "
  stty -echo 2>/dev/null || true
  read -r SUPABASE_ACCESS_TOKEN
  stty echo 2>/dev/null || true
  printf "\n"
fi
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "No Supabase token given. Step 3 can't run without it."
case "$SUPABASE_ACCESS_TOKEN" in
  sbp_*) ok "supabase token looks right" ;;
  *) warn "that doesn't start with sbp_ — carrying on, but step 3 may fail" ;;
esac

# ------------------------------------------------------------------ 1. build
say "Building"
cd "$APP_DIR"
[ -d node_modules ] || npm install
npm run build
[ -f dist/index.html ] || die "Build produced no dist/index.html."
[ -f dist/_redirects ] || die "dist/_redirects is missing — deep links would 404. Check public/_redirects exists."
ok "dist/ built, _headers and _redirects present"

# ------------------------------------------------- 2. deploy to Cloudflare
say "Deploying to Cloudflare Pages"
# Opens a browser once for OAuth, then remembers you.
npx --yes wrangler@latest whoami >/dev/null 2>&1 || npx --yes wrangler@latest login

# Creating an existing project is an error; that's fine on a re-run.
npx --yes wrangler@latest pages project create "$PROJECT" \
    --production-branch main >/dev/null 2>&1 \
  && ok "created Pages project '$PROJECT'" \
  || ok "Pages project '$PROJECT' already exists"

DEPLOY_LOG=$(mktemp)
npx --yes wrangler@latest pages deploy dist \
    --project-name "$PROJECT" \
    --branch main 2>&1 | tee "$DEPLOY_LOG"

SITE_URL=$(grep -Eo 'https://[a-z0-9.-]*\.pages\.dev' "$DEPLOY_LOG" | tail -1)
rm -f "$DEPLOY_LOG"
[ -n "$SITE_URL" ] || die "Deploy finished but no *.pages.dev URL came back. Read the output above."

# The deploy prints the per-deployment URL (abc123.guma.pages.dev). The stable
# production alias is the bare project subdomain — that's what auth points at.
PROD_URL="https://${PROJECT}.pages.dev"
ok "deployed: $SITE_URL"
ok "production alias: $PROD_URL"

# ------------------------------------------------- 3. point Supabase at it
say "Configuring Supabase auth"

ALLOW="${PROD_URL}/**,https://*.${PROJECT}.pages.dev/**,http://localhost:5173/**"

curl -sS -X PATCH "https://api.supabase.com/v1/projects/${SUPA_REF}/config/auth" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"site_url\":\"${PROD_URL}\",\"uri_allow_list\":\"${ALLOW}\"}" \
  >/dev/null || die "Supabase PATCH failed. Check the token has access to this project."

# Read it back rather than trusting the write — if the field names ever change,
# this is where you find out, not three magic links later.
say "Verifying"
CONF=$(curl -sS "https://api.supabase.com/v1/projects/${SUPA_REF}/config/auth" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}")

GOT_SITE=$(printf '%s' "$CONF" | sed -n 's/.*"site_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
GOT_LIST=$(printf '%s' "$CONF" | sed -n 's/.*"uri_allow_list"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ "$GOT_SITE" = "$PROD_URL" ]; then
  ok "site_url        = $GOT_SITE"
else
  warn "site_url came back as '${GOT_SITE:-empty}', expected '$PROD_URL'"
  warn "set it by hand: https://supabase.com/dashboard/project/${SUPA_REF}/auth/url-configuration"
fi

case "$GOT_LIST" in
  *localhost:5173*) ok "uri_allow_list  = $GOT_LIST" ;;
  *) warn "redirect allowlist came back as '${GOT_LIST:-empty}' — check the URL configuration page" ;;
esac

# Is the site actually serving, and does the SPA fallback work?
say "Checking the deployed site"
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$PROD_URL/")
DEEP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$PROD_URL/settings")
[ "$HOME_CODE" = "200" ] && ok "GET /          $HOME_CODE" || warn "GET /          $HOME_CODE (DNS can take a minute on a brand-new project)"
[ "$DEEP_CODE" = "200" ] && ok "GET /settings  $DEEP_CODE (SPA fallback works)" || warn "GET /settings  $DEEP_CODE — _redirects didn't take effect"

# --------------------------------------------------------------- 4. done
cat <<EOF

  ────────────────────────────────────────────────────────────
  Live at  $PROD_URL

  Now, in this order:

  1. Open it and sign in with  cgai00742@gmail.com
     It MUST be that address. Until custom SMTP is set up, Supabase
     refuses to mail any address that isn't a member of your org, and
     the failure reads "Email address not authorized".

     It must also be YOU first — a trigger makes the first account to
     sign in the shop owner, and only owners can change rates.

  2. Shop settings → Rates. Type in the design rate and watch the
     sample total move. Hit Save. If it saves, you're the owner.

  3. Job intake → enter a real job → Send quote as PDF → Cmd-P.

  To ship a change later, just re-run this script.
  ────────────────────────────────────────────────────────────

EOF
