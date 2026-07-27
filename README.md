# UIU Aerial Robotics GCP — Custom ArduPilot Ground Station (Electron)

A from-scratch ground control station for **ArduPilot** running inside an
Electron desktop app. Connect your **RFD900x** long-range radio modem (or
any SiK/MAVLink-over-USB serial) to your computer, plug in the USB cable,
pick the COM port in the toolbar, and the app starts decoding MAVLink and
rendering every panel the user asked for.

> No ArduPilot fork, no Mission Planner, no QGroundControl dependency —
> everything you see is custom-built in `src/`.

## What you get

A dark, operations-grade console with the panels your spec called out:

1. **Flight Status** — flight mode, armed, vehicle status, EKF, GPS fix,
   system status, failsafe (battery / RC / GPS), mission running/completed.
2. **GPS & Navigation** — lat / lon / altitude MSL+rel, ground / air /
   vertical speed, heading, COG, sats, HDOP / VDOP, accuracy, home
   position, distance + bearing + ETA to home.
3. **Attitude** — animated artificial horizon + roll / pitch / yaw and
   their rates, plus a 3-minute attitude trail.
4. **Battery** — voltage, current, remaining %, consumed mAh, power,
   temperature, flight time remaining, health, with a 6S cell meter.
5. **Telemetry / Radio** — RFD900x RSSI, remote RSSI, noise, RX errors,
   latency and a real-time RSSI history chart.
6. **IMU** — accelerometer / gyro / magnetometer X·Y·Z, vibration flags,
   IMU temperature.
7. **Compass** — heading dial with home bearing overlay.
8. **Barometer** — pressure, temperature, derived altitude with history.
9. **Mission** — current / total waypoints, distance to next, ETA, mission
   progress bar + elapsed timer.

## Quick start

```bash
cd gcs_aerial
npm install
npm run mock      # try the GCS without hardware (simulated MAVLink)
# or
npm start         # connect to a real RFD900x / SiK modem
```

> The first `npm install` automatically runs `electron-rebuild` against the
> `serialport` native bindings so they match Electron's Node ABI. If
> `Rescan` shows zero devices, re-run it manually with:
>
> ```bash
> npx electron-rebuild -f -w serialport
> ```

When the window opens:

1. Click **Rescan** to list USB serial ports (your RFD900x should appear).
2. Pick the port and baud rate (RFD900x defaults to **57600**). You can
   also type the COM path (e.g. `COM3`) directly into the **"Or type"**
   field — useful if the device hasn't shown up in the dropdown yet.
3. Click **Connect**.

If you don't have hardware handy, choose **`MOCK — simulated MAVLink
stream`** in the port dropdown to see live panels immediately.

## Build and release

The package is configured for Windows, macOS, and Linux builds through
`electron-builder`.

```bash
npm run build:win      # Windows installer
npm run build:mac      # macOS dmg + zip
npm run build:linux    # Linux AppImage + deb + zip
npm run build:all      # run all configured targets on a suitable CI runner
npm run release        # publish the artifacts to GitHub Releases
```

`npm run release` uses the GitHub Releases publish target in
`package.json`. Set `GH_TOKEN` in the environment before publishing.
For macOS and Linux artifacts, run the matching build on macOS or Linux
CI runners.

## Real-time map

The **GPS & Navigation** panel now hosts a full moving map (like
Mission Planner / QGC):

- **Tile background** — OpenStreetMap by default; switch to satellite
  imagery (ArcGIS World Imagery) from the toolbar dropdown. Tiles are
  fetched via the main process so the renderer stays CORS-free. If
  you're offline, the map falls back to a vector grid.
- **Plane icon** — drawn at the drone's lat/lon, rotated to its current
  heading, with a heading vector and an accuracy ring.
- **Track** — fading tail of where the drone has been.
- **Home marker + safety circle** — yellow pin with a dotted safe-zone
  ring.
- **Mission waypoints** — all WPs from the active mission, with the
  current leg highlighted in amber. (The mock link publishes a 5-WP
  square survey so you can see this even without a flight controller.)
- **Other aircraft** — synthetic ADSB and friendly UAV icons with
  bearing, altitude, and speed tags.
- **Geofence** — red polygon for any no-fly zone you set.
- **Controls** — wheel = zoom, drag = pan, double-click = re-center
  and re-engage Follow. The toolbar has `+ / − / ⌖` shortcuts too.
- **HUD** — live lat/lon, zoom, WP count, and the active aircraft
  count in the corners; auto-scaling scale bar at the bottom.

## How it talks to your drone

```
[RFD900x modem] ──USB──► [COMx] ─► serialport (Node)
                                 │
                                 ▼
                          MAVLink parser
                                 │
                                 ▼
                       Telemetry store (10 Hz)
                                 │
                                 ▼
                          Electron IPC
                                 │
                                 ▼
                         Renderer (UI)
```

- The serial bridge lives in `src/main/serial-link.js`. It wraps
  [`serialport`](https://serialport.io/), enumerates ports, and forwards
  raw bytes.
- The decoder in `src/main/mavlink.js` does lightweight **MAVLink v1
  + v2** framing (magic, length, header, payload) and decodes the
  message IDs you care about:
  - `0` HEARTBEAT
  - `1` SYS_STATUS
  - `24` GPS_RAW_INT
  - `27` RAW_IMU
  - `29` SCALED_PRESSURE
  - `30` ATTITUDE
  - `33` GLOBAL_POSITION_INT
  - `42` MISSION_CURRENT
  - `74` VFR_HUD
  - `109` RADIO_STATUS
  - `147` BATTERY_STATUS
  - `242` HOME_POSITION
- Decoded messages are folded into the telemetry store in
  `src/main/telemetry-store.js`, which derives distance/bearing/ETA to
  home, battery power, link quality, mission progress, etc., and emits a
  throttled snapshot (~10 Hz) to the renderer over Electron IPC.
- The renderer in `src/renderer/js/` paints the panels, including a
  custom canvas artificial horizon, map track, compass, and rolling
  history charts. No external charting dependency — everything is plain
  ESM + canvas.

## Hardware notes

- **RFD900x / SiK modems** show up as USB-CDC ACM serial devices. Pick
  the modem's port in the toolbar; if you're using a SiK modem that
  relays a flight controller's MAVLink stream, no further setup is
  needed — the GCS reads whatever the modem forwards.
- **Baud rate** is selectable in the toolbar. The RFD900x USB bridge
  defaults to 57600 (or whatever ATBD you've set); ArduPilot over USB
  usually uses 115200. Adjust accordingly.
- **USB vs UART**: For RFD900x on USB, the FTDI / CP210x driver must be
  installed; Windows automatically creates a COM port that shows up in
  the dropdown. If it doesn't appear, run `npm run mock` first to
  confirm the app is wired up correctly.

## Smoke test the decoder

```bash
node test/parser.test.js
```

This boots the mock link, runs the MAVLink decoder through ~1.2 s of
packets, and asserts every panel value. Use it as a regression check
when you tweak the parser.

## Project layout

```
src/
  main/
    main.js            Electron main process, IPC handlers
    mavlink.js         Lightweight MAVLink v1/v2 decoder
    mock-link.js       Simulated MAVLink source for offline demos
    serial-link.js     USB / serial port bridge (RFD900x, SiK, FC USB)
    telemetry-store.js Normalizes MAVLink messages → UI snapshot
  preload/preload.js   contextBridge → window.aerogcs
  renderer/
    index.html         Panel layout
    styles/app.css     Dark operations-console design tokens
    js/
      app.js           Renderer entry point, IPC wiring
      horizon.js       Canvas artificial horizon
      map.js           Canvas map + track + home + scale bar
      compass.js       Canvas heading dial + home bearing
      charts.js        Streaming line / attitude-trail charts
      format.js        Number / unit formatters
test/
  parser.test.js       Decoder smoke test (no hardware required)
```

## Extending it

- **Add a new MAVLink field**: add a case to `_decode` in
  `src/main/mavlink.js`, fold it into the snapshot in
  `src/main/telemetry-store.js`, and bind it in `src/renderer/js/app.js`.
- **Add a new panel**: drop a `<section class="panel">` block in
  `index.html`, style it in `styles/app.css`, render it in `app.js`.
- **Send commands**: the `aerogcs.write(bytes)` bridge is already exposed
  on `window`. Encode MAVLink COMMAND_INT / SET_MODE / etc., send via
  `window.aerogcs.write(...)`.

## License

MIT.
