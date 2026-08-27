#!/usr/bin/env python3
# Autotune Tuner — standalone controller for 'intel-undervolt autotune'.
#
# Talks to the root service over the exact same channels as the old
# GNOME Shell indicator:
#   status   /run/intel-undervolt-autotune/status   (root -> app)
#   control  /dev/shm/intel-undervolt-autotune.controls (app -> root)
#   start/stop  sudo -n systemctl (scoped by /etc/sudoers.d/50-...)
#
# Requires GTK4 + libadwaita:  sudo dnf install gtk4 python3-gobject libadwaita

import subprocess
import os
import sys
import threading

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Adw, Gtk, GLib

STATUS_FILE = '/run/intel-undervolt-autotune/status'
CONTROL_FILE = '/dev/shm/intel-undervolt-autotune.controls'
SERVICE = 'intel-undervolt-autotune.service'

WATT_MIN, WATT_MAX = 1, 115
TEMP_MIN, TEMP_MAX = 40, 120
STALE_MS = 4000


def read_file(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def parse_kv(text):
    out = {}
    if not text:
        return out
    for line in text.splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def file_is_fresh(path, max_age_ms):
    try:
        return os.path.getmtime(path) * 1000 > (GLib.get_monotonic_time()
                                                / 1000 - max_age_ms)
    except OSError:
        return False


class AutotuneWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title='Autotune Tuner',
                         default_width=400, default_height=460)

        self._control = {
            'watt': 25, 'maxTemp': 85, 'min': 5,
            'max': WATT_MAX, 'boost': 1.0, 'domain': 'package',
        }
        self._debounce = None
        self._toggle_wanted = None
        self._build_ui()
        self._poll()
        self._timer = GLib.timeout_add(1000, self._poll)

    # ----------------------------------------------------------- UI

    def _build_ui(self):
        toolbar = Adw.ToolbarView()
        self.set_content(toolbar)

        header = Adw.HeaderBar()
        title = Gtk.Label(label='Autotune Tuner')
        title.add_css_class('title')
        subtitle = Gtk.Label(label='intel-undervolt autotune')
        subtitle.add_css_class('dim-label')
        title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        title_box.append(title)
        title_box.append(subtitle)
        header.set_title_widget(title_box)
        toolbar.add_top_bar(header)

        self._toggle = Gtk.ToggleButton(label='Start')
        self._toggle.add_css_class('suggested-action')
        self._toggle.connect('clicked', self._on_toggle)
        header.pack_start(self._toggle)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                      spacing=10, margin_top=12, margin_bottom=12,
                      margin_start=16, margin_end=16, hexpand=True)
        toolbar.set_content(box)

        # status readouts
        self._row_service = Gtk.Label(label='Service: ○ stopped',
                                      xalign=0, halign=Gtk.Align.START)
        self._row_status = Gtk.Label(label='—',
                                     xalign=0, halign=Gtk.Align.START)
        self._row_status.add_css_class('dim-label')
        self._row_pl = Gtk.Label(label='PL —/— W',
                                 xalign=0, halign=Gtk.Align.START)
        self._row_pl.add_css_class('dim-label')
        box.append(self._row_service)
        box.append(self._row_status)
        box.append(self._row_pl)

        box.append(Gtk.Separator())

        # target watt
        self._watt_label = Gtk.Label(label='Target watt: 25 W',
                                     xalign=0, halign=Gtk.Align.START)
        box.append(self._watt_label)
        self._watt_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, WATT_MIN, WATT_MAX, 1)
        self._watt_scale.set_value(self._control['watt'])
        self._watt_scale.set_digits(0)
        self._watt_scale.connect('value-changed', self._on_watt)
        box.append(self._watt_scale)

        # temp ceiling
        self._temp_label = Gtk.Label(label='Temp ceiling: 85 °C',
                                     xalign=0, halign=Gtk.Align.START)
        box.append(self._temp_label)
        self._temp_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, TEMP_MIN, TEMP_MAX, 1)
        self._temp_scale.set_value(self._control['maxTemp'])
        self._temp_scale.set_digits(0)
        self._temp_scale.connect('value-changed', self._on_temp)
        box.append(self._temp_scale)

        # boost
        boost_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        boost_row.append(Gtk.Label(label='Boost bursts (1.5×)',
                                   hexpand=True, xalign=0))
        self._boost_switch = Gtk.Switch()
        boost_row.append(self._boost_switch)
        self._boost_switch.connect('notify::active', self._on_boost)
        box.append(boost_row)

        # presets
        presets = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=6, homogeneous=True)
        for name, cfg in [('Battery', (12, 75, 1.0)),
                          ('Balanced', (25, 85, 1.0)),
                          ('Performance', (60, 90, 1.5))]:
            btn = Gtk.Button(label=name)
            btn.connect('clicked', self._on_preset, name, cfg)
            presets.append(btn)
        box.append(presets)

        box.append(Gtk.Separator())
        note = Gtk.Label(
            label='Needs: intel-undervolt-autotune systemd service\n'
                  '(performancetweak repo) · limits restored on stop',
            halign=Gtk.Align.CENTER)
        note.add_css_class('dim-label')
        box.append(note)

    # ------------------------------------------------------- signals

    def _on_watt(self, scale):
        self._control['watt'] = int(scale.get_value())
        self._watt_label.set_text(f"Target watt: {self._control['watt']} W")
        self._schedule_write()

    def _on_temp(self, scale):
        self._control['maxTemp'] = int(scale.get_value())
        self._temp_label.set_text(
            f"Temp ceiling: {self._control['maxTemp']} °C")
        self._schedule_write()

    def _on_boost(self, switch, _pspec):
        self._control['boost'] = 1.5 if switch.get_active() else 1.0
        self._schedule_write()

    def _on_preset(self, _btn, name, cfg):
        watt, temp, boost = cfg
        self._control.update(watt=watt, maxTemp=temp, boost=boost)
        self._watt_scale.set_value(watt)
        self._temp_scale.set_value(temp)
        self._boost_switch.set_active(boost > 1.0)
        self._watt_label.set_text(f"Target watt: {watt} W")
        self._temp_label.set_text(f"Temp ceiling: {temp} °C")
        self._write_control()

    def _on_toggle(self, btn):
        # Button state mirrors the service state (synced by _poll()):
        # clicking it asks for the opposite — active now = wants running.
        action = 'start' if btn.get_active() else 'stop'
        self._toggle_wanted = action
        self._toggle.set_sensitive(False)
        self._row_status.set_text('Starting…' if action == 'start'
                                  else 'Stopping…')
        threading.Thread(target=self._run_systemctl, args=(action,),
                         daemon=True).start()

    def _run_systemctl(self, action):
        try:
            r = subprocess.run(['sudo', '-n', 'systemctl', action, SERVICE],
                               capture_output=True, text=True, timeout=30)
            ok = r.returncode == 0
            detail = (r.stderr or r.stdout).strip()
        except Exception as e:
            ok = False
            detail = str(e)
        GLib.idle_add(self._systemctl_done, action, ok, detail)

    def _systemctl_done(self, action, ok, detail):
        self._toggle.set_sensitive(True)
        self._toggle_wanted = None
        if not ok:
            # revert the visual toggle so it matches reality
            self._toggle.set_active(action == 'stop')
            self._row_status.set_text(f'failed: {detail[:80] or "unknown"}')
            self._row_service.set_text(f'Service: {action} failed')
        # on success, _poll() will pick up the new state within 1 s

    # ------------------------------------------------------- control

    def _schedule_write(self):
        if self._debounce:
            GLib.source_remove(self._debounce)
        self._debounce = GLib.timeout_add(300, self._write_control)

    def _write_control(self):
        self._debounce = None
        c = self._control
        text = (f"watt={c['watt']}\n"
                f"max-temp={c['maxTemp']}\n"
                f"min={c['min']}\n"
                f"max={c['max']}\n"
                f"boost={c['boost']}\n"
                f"domain={c['domain']}\n")
        try:
            with open(CONTROL_FILE, 'w') as f:
                f.write(text)
        except OSError as e:
            self._row_status.set_text(f'control write failed: {e}')

    # ------------------------------------------------------------ poll

    def _poll(self):
        running = file_is_fresh(STATUS_FILE, STALE_MS)
        st = parse_kv(read_file(STATUS_FILE)) if running else {}

        self._toggle.set_sensitive(True)
        if running:
            self._toggle.set_active(True)
            self._toggle.set_label('Stop')
        else:
            self._toggle.set_active(False)
            self._toggle.set_label('Start')
            self._row_status.set_text('—')
            self._row_pl.set_text('PL —/— W')
            self._row_service.set_text('Service: ○ stopped')
            return GLib.SOURCE_CONTINUE

        self._toggle_wanted = None
        measured = st.get('measured', '—')
        temp = st.get('temp', '—')
        thermal = st.get('thermal') == '1'
        pl1, pl2 = st.get('pl1', '—'), st.get('pl2', '—')
        target = st.get('target', '—')

        self._row_service.set_text('Service: ● running')
        self._row_status.set_text(
            f"{measured} W · {temp} °C{(' · THERMAL') if thermal else ''}")
        self._row_status.remove_css_class('red-label')
        self._row_status.remove_css_class('green-label')
        if thermal:
            self._row_status.add_css_class('red-label')
        else:
            self._row_status.add_css_class('green-label')
        self._row_pl.set_text(f"PL {pl1}/{pl2} W (target {target})")

        # adopt service-side settings into the UI (external changes)
        try:
            watt = int(st['target'])
        except (KeyError, ValueError):
            watt = None
        if watt is not None and watt != int(self._watt_scale.get_value()):
            self._watt_scale.set_value(watt)
        return GLib.SOURCE_CONTINUE


class AutotuneApp(Adw.Application):
    def __init__(self):
        super().__init__(
            application_id='io.github.uhthu.autotunetuner',
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.connect('activate', self._on_activate)

    def _on_activate(self, app):
        win = self.get_active_window() or AutotuneWindow(self)
        win.present()


if __name__ == '__main__':
    from gi.repository import Gio  # noqa: E402
    app = AutotuneApp()
    sys.exit(app.run(sys.argv))