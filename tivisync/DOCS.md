# TiviSync

Sync + parental controls server for the TiviSync Android TV app.

1. Set **admin_password** (min 8 characters) – used if you open the parent app directly on port 8080.
2. Set **api_token** to a long random string (16+ characters) – Home Assistant uses it to approve time requests from notifications.
3. Change the end of **ha_webhook_url** (`tivisync_CHANGE_ME`) to something random and use the same id in the automation.
4. Start the add-on and open **TiviSync** in the sidebar.

The TVs connect to `http://<your-HA-IP>:8080`.

## Doorbell and announcements

When the doorbell rings, every TV pauses and shows and reads out "Someone's at the door". Set **doorbell_entity** to your doorbell's press sensor (default `binary_sensor.doorbell_visitor`).

Any automation or script can also send a message to the TVs:

```yaml
event: tivisync_announce
event_data:
  message: "Dinner is ready"
```

## More TV time and checking extra jobs

When a child's TV time runs out they can ask for more on the TV. Adults get an alert on their phones (the Home Assistant app, set in **notify_services**, e.g. `mobile_app_home_47`) with +30 min / +1 hour / No, and a pop-up on any TV where an adult profile is signed in with +15 / +30 / +1 hour / No. The first answer wins and the other alerts disappear.

Family Planner uses the same alerts to check extra jobs, and adds TV time for chores that are done (event `tivisync_bonus` with `profile` and `minutes`).

## Want to watch, watched and scores (1.10.0, app build 30)

- **Want to watch:** on any film or series page press **＋ Want to watch**. Each profile has its own list, shown as a row on the Home screen on every TV. Films drop off the list once watched; series once every episode is watched.
- **Watched:** anything played past 92% is marked watched automatically. You can also use **✓ Mark watched / ↺ Mark unwatched** on a film, the season and series buttons on a series page, or press right on an episode for its own tick. Fully watched series get a ✓ on their poster.
- **Score:** film and series pages show the public TMDB score (out of 10, with the number of votes).
- **Age ratings:** the UK certificate is used first, then US / Ireland / Australia / Germany. If none of those exist, the age most other countries agree on is used (shown with its country, e.g. "Rated 12 (12 FR)"). Titles that had no rating are looked up again automatically after updating. Anything still missing can be set by hand in the panel's Ratings page.

## TV guide and channel icons every 24 hours (1.21.0, app build with patch 057)

Every night at 3am the add-on downloads the full TV guide (the source's EPG address, an uploaded guide file, or the Xtream provider's `xmltv.php`) and the latest channel icons. If a night is missed (Home Assistant was off), it catches up within the hour. The guide is stored for the channels at least one profile can see (up to 4,000), 8 days ahead, with a week of past programmes for catch-up channels. TVs read guide rows, now/next and guide search from Home Assistant and only ask the provider for channels the add-on doesn't keep. Channels without a logo get the icon from the guide, or from the tv-logos list (now rebuilt daily). Panel: Channels › 🗓 TV guide shows when it last ran and has an **Update now** button.

## EcoFlow power flow on Today (1.23.0, app build with patch 059)
The 📋 Today page shows a live power-flow box next to the weather: solar, the main battery (charge %), home use and the grid, with moving dots showing which way the power goes, plus the fridge battery's charge. TVs ask `GET /api/tv/energy` every 5 seconds.
The sensors default to the EcoFlow STREAM 5000, the STREAM Ultra X (fridge battery) and the EcoFlow smart meter. To use other sensors, `PUT /api/admin/energy-entities` with `{"entities": {"solar": "sensor.…", "home": …, "grid": …, "batterySoc": …, "batteryPower": …, "fridgeSoc": …, "fridgeCharge": …, "fridgeDischarge": …}}` (empty string = not used).
