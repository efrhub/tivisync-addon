#!/bin/sh
# Family Planner add-on start-up: reads the add-on options, restores a backup if one is waiting, then starts the app.
set -e
OPT=/data/options.json
opt() { node -e "try{const o=require('$OPT');const v=o['$1'];process.stdout.write(v===undefined||v===null?'':String(v))}catch(e){}"; }

export DATA_DIR=/data/planner HOST=0.0.0.0 PORT=3100 UPDATER_DIR=/data/updater
export HOUSE_TZ="$(opt tz)"; [ -n "$HOUSE_TZ" ] || HOUSE_TZ=Europe/London
export TZ="$HOUSE_TZ"
[ "$(opt trust_proxy)" = "true" ] && export TRUST_PROXY=1
export SPEAKERS="$(node -e "try{const o=require('$OPT');process.stdout.write((o.speakers||[]).join('\\n'))}catch(e){}")"
export SPEAK_AFTER_MINUTES="$(opt speak_after_minutes)"; [ -n "$SPEAK_AFTER_MINUTES" ] || SPEAK_AFTER_MINUTES=60
export TTS_ENTITY="$(opt tts_entity)"; [ -n "$TTS_ENTITY" ] || TTS_ENTITY=tts.home_assistant_cloud
export TTS_LANGUAGE="$(opt tts_language)"
export TV_REMIND_MINUTES="$(opt tv_remind_minutes)"; [ -n "$TV_REMIND_MINUTES" ] || TV_REMIND_MINUTES=30
export TIVISYNC_URL="$(opt tivisync_url)"; [ -n "$TIVISYNC_URL" ] || TIVISYNC_URL=http://e53481c0-tivisync:8080
mkdir -p "$DATA_DIR" "$UPDATER_DIR" /share/family-planner
cd /app

# A backup downloaded from the old server (System tab › Download backup) can be dropped into
# the "share/family-planner" folder; it is loaded once, then renamed so it isn't loaded again.
for f in /share/family-planner/*.json; do
  [ -f "$f" ] || continue
  echo "Restoring backup $f"
  if node server.js restore "$f"; then mv "$f" "$f.restored"; else mv "$f" "$f.failed"; echo "That backup could not be restored."; fi
done

# Optional: create the first admin, or reset a lost admin password, from the add-on options.
EMAIL="$(opt admin_email)"; PASS="$(opt admin_password)"
if [ -n "$EMAIL" ] && [ -n "$PASS" ]; then
  ROTA_PASSWORD="$PASS" node server.js add-admin "$EMAIL" "Admin" || true
  echo "Admin password set for $EMAIL. You can clear admin_email and admin_password in the add-on Configuration now."
fi

exec node server.js
