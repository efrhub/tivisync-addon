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
