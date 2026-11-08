# Family Planner

Chores, school and work schedules, dinners, shopping list and chat for the household.

Open it from **Family Planner** in the Home Assistant sidebar, or at `http://<your-HA-IP>:3100`.

## Moving from the old server
1. On the old site, sign in as a system user and use **System › Download backup**.
2. Copy that file into the **share** folder on Home Assistant, inside a folder called `family-planner` (with Samba: `\\homeassistant\share\family-planner\`).
3. Restart this add-on. The log says "Restoring backup…" and the file is renamed to `.restored`. Everyone signs in again with their usual passwords.

## Signing in with Home Assistant
Opened from the Home Assistant sidebar, Family Planner signs people in with their Home Assistant login:
- If the Home Assistant user's name matches a Family Planner name exactly (e.g. "Joshua"), they're signed in straight away.
- Otherwise they sign in once with their Family Planner email and password, and their Home Assistant login is remembered from then on.
- Signing out inside Family Planner forgets that link, so a shared Home Assistant login can switch person.
Roles (admin, cleaner, system user) still come from Family Planner. Email and password still work at `http://<your-HA-IP>:3100`.

## Spoken reminders
When someone's chore is an hour late (or still not done from an earlier day), it is read out once on their speaker, between 08:00 and 21:00, e.g. "Joshua, your job "Hoover the lounge" is over an hour late."
Set the speakers in **speakers**, one per line as `Name=media_player.entity`, using the person's name exactly as in Family Planner. A line `Everyone else=media_player.kitchen_display` covers anyone without their own speaker. Chores without a time count from 16:00.

## TiviSync reminders
In **People**, open someone's sign-in and choose their **TiviSync profile**. While they have chores to do (08:00–21:00), a pop-up appears on the TV where they're signed in to TiviSync, repeated every **tv_remind_minutes** (default 30; 0 turns it off). Programmes don't pause. Needs TiviSync add-on 1.8.3 or newer.

Today's **Reminders** (their reminders, nights, takeaway or eating out, dinner jobs for their group, and for admins everyone's outings and nights away) also pop up once, on their first TiviSync sign-in of the day. Earlier days are never shown. Needs TiviSync 1.8.4 or newer.

## TV time for chores
Every chore ticked off adds its minutes to that person's TiviSync time for today (1:1), if they're linked to a TiviSync profile. Extra jobs added by someone who isn't an admin wait for an adult to check them: an alert goes to the adults' phones and to any TV where an adult is signed in to TiviSync (set up in the TiviSync add-on, option notify_services), and admins also see **Approve** / **Reject** under Done today. Undo or "Not done properly" takes the time back. Needs TiviSync 1.9.0 or newer.

## Options
- **tz** – the house time zone (default Europe/London).
- **trust_proxy** – turn on only when the app is reached through a reverse proxy or tunnel (for example the Cloudflared add-on), so sign-in limits and secure cookies use the real visitor address.
- **admin_email / admin_password** – fill in to create the first admin or reset a lost password, restart, then clear them again.

## Notes
- Your data lives in the add-on and is included in Home Assistant backups.
- Phone notifications and the iPhone home-screen app need HTTPS, so they only work through your web address (e.g. https://hometask.eventfirstresponders.co.uk), not `http://…:3100`.
- Updates come from the TiviSync add-on repository (Settings › Add-ons › Family Planner › Update); the in-app System › Update button isn't used here.
