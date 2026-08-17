#!/usr/bin/env bash
set -Eeuo pipefail

app_username="${APP_USERNAME:-admin}"
app_password="${APP_PASSWORD:-}"

if [[ ! "$app_username" =~ ^[a-zA-Z0-9_-]{1,32}$ ]]; then
  echo "APP_USERNAME must contain only letters, numbers, underscores, or dashes." >&2
  exit 1
fi

if (( ${#app_password} < 16 || ${#app_password} > 72 )); then
  echo "APP_PASSWORD must be between 16 and 72 characters." >&2
  exit 1
fi

if [[ "$app_password" == *$'\n'* || "$app_password" == *$'\r'* ]]; then
  echo "APP_PASSWORD must not contain line breaks." >&2
  exit 1
fi

umask 077
printf '%s\n' "$app_password" | htpasswd -ciB -C 12 /etc/nginx/.htpasswd "$app_username" >/dev/null 2>&1
unset app_password APP_PASSWORD

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/nursing-register.conf
