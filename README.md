# Autotune Tuner

GNOME Shell extension (top-bar indicator) for `intel-undervolt autotune`
from the [performancetweak](https://github.com/UHTHU/performancetweak)
fork. One click exposes a menu with:

- **live readouts**: package watts, temperature, PL1/PL2, thermal state
- **target watt** slider (1–115 W)
- **temperature ceiling** slider (40–120 °C)
- **boost** toggle (1× / 1.5× bursts)
- **profiles**: Battery (12 W/75 °C), Balanced (25 W/85 °C),
  Performance (60 W/90 °C)
- **power switch** to start/stop the autotune service

The indicator sits in the top bar to the left of the battery icon and
shows the current package draw (`⚡ 12.4W`), or `⚡ off` when the service
is not running.

## How it talks to the root service (no root in the UI)

| Channel | Path | Direction |
|---|---|---|
| status | `/run/intel-undervolt-autotune/status` | root → UI (`key=value`, updated each loop cycle) |
| control | `/dev/shm/intel-undervolt-autotune.controls` | UI → root (`watt`, `max-temp`, `min`, `max`, `boost`, `domain`) |
| start/stop | sudoers | UI → `sudo -n systemctl start/stop`, scoped to the unit in `/etc/sudoers.d/50-intel-undervolt-autotune` |

## Install

Prerequisites (the service side, in the performancetweak repo):

```bash
./configure --enable-systemd && make && sudo make install
sudo systemctl daemon-reload
# optional: sudo systemctl enable --now intel-undervolt-autotune
```

Then install and enable the extension:

```bash
./install-extension.sh
```

Remove with `./uninstall-extension.sh`.

## Notes

- The control file works while the service is stopped too: configure a
  profile, then flip the power switch on.
- Temperature ceiling is a hard constraint; the loop cuts power limits
  below the ceiling and only boosts toward the target watt while cool.
- On some platforms (Meteor Lake tested) PL2 is enforced sustained, so
  boost > 1 makes measured watts ride above the target under load.