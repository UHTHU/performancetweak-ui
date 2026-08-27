# Autotune Tuner

Standalone GTK4 / libadwaita app that controls **`intel-undervolt
autotune`** (the [performancetweak](https://github.com/UHTHU/performancetweak)
fork): set a target watt and temperature ceiling, get live power and
temperature readouts, apply presets, and start/stop the autotune
service.

![no screenshot]

## Features

- **Live readouts**: package watts, temperature, PL1/PL2 and target,
  thermal-state highlighting (green/red)
- **Target watt** slider (1–115 W) — applied in real time, no restarts
- **Temperature ceiling** slider (40–120 °C) — hard thermal constraint
- **Boost bursts** toggle (1× / 1.5×)

> Note: some platforms (Meteor Lake tested) enforce PL2 sustained, so
> boost > 1 makes measured watts ride above the target under load.

- **Presets**: Battery (12 W/75 °C), Balanced (25 W/85 °C), Performance
  (60 W/90 °C)
- **Start / Stop** the service from the header bar, passwordless
  (scoped sudoers)

## How it talks to the root service (no root in the app)

| Channel | Path | Direction |
|---|---|---|
| status | `/run/intel-undervolt-autotune/status` | root → app (`key=value`, updated every loop cycle) |
| control | `/dev/shm/intel-undervolt-autotune.controls` | app → root (`watt`, `max-temp`, `min`, `max`, `boost`, `domain`) |
| start/stop | sudoers | app → `sudo -n systemctl start/stop intel-undervolt-autotune.service`, scoped in `/etc/sudoers.d/50-intel-undervolt-autotune` |

## Install

Prerequisites (service side, in the performancetweak repo):

```bash
./configure --enable-systemd && make && sudo make install
sudo systemctl daemon-reload
# optional: sudo systemctl enable --now intel-undervolt-autotune
```

App itself (needs GTK4 + libadwaita + python3-gobject):

```bash
sudo dnf install gtk4 libadwaita python3-gobject
./install.sh
```

Launch with `autotune-tuner` or from the app grid.

## Notes

- The control file works while the service is stopped too: configure a
  profile, then press Start.
- The temperature ceiling is a hard constraint; the loop only raises
  power toward the target while cool, and cuts below the ceiling when
  hot.
- Both files are untrusted-input by design: the loop validates and
  clamps every control value.