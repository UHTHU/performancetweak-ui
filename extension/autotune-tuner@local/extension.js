// autotune-tuner@local
//
// Top-bar indicator for 'intel-undervolt autotune' (see the
// performancetweak fork). Shows live package power / temperature and a
// menu to set the target watt, temperature ceiling, boost factor,
// presets, and to start/stop the systemd service running the loop.
//
// Communication with the root service (no root needed from the UI):
//   status   /run/intel-undervolt-autotune/status   (root -> UI, key=value)
//   control  /dev/shm/intel-undervolt-autotune.controls (UI -> root, key=value)
//   start/stop  org.freedesktop.systemd1 (polkit rule allows this unit)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const STATUS_FILE = '/run/intel-undervolt-autotune/status';
const CONTROL_FILE = '/dev/shm/intel-undervolt-autotune.controls';
const SERVICE = 'intel-undervolt-autotune.service';

const POLL_MS = 1000;
const DEBOUNCE_MS = 300;
const STALE_MS = 4000; // status older than this => service not running

const WATT_MIN = 1;
const WATT_MAX = 115;

const PROFILES = {
    'Battery': {watt: 12, maxTemp: 75, boost: 1.0},
    'Balanced': {watt: 25, maxTemp: 85, boost: 1.0},
    'Performance': {watt: 60, maxTemp: 90, boost: 1.5},
};

// -------------------------------------------------------------- helpers

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (ok)
            return new TextDecoder().decode(bytes);
    } catch (e) {
        // ignore
    }
    return null;
}

function parseKV(text) {
    const out = {};
    if (text === null)
        return out;
    for (const line of text.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k)
            out[k] = v;
    }
    return out;
}

function mtimeNowOld(path, maxAgeMs) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info(
            Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
            Gio.FileQueryInfoFlags.NONE, null);
        const modified = info.get_attribute_uint64(
            Gio.FILE_ATTRIBUTE_TIME_MODIFIED) * 1000;
        return (Date.now() - modified) > maxAgeMs;
    } catch (e) {
        return true;
    }
}

// ---------------------------------------------------------------- widget

const TunerIndicator = GObject.registerClass(
class TunerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Autotune Tuner', false);

        this._label = new St.Label({
            text: '⚡ —',
            y_expand: true,
            y_align: 1 /* Clutter.ActorAlign.CENTER */,
        });
        this._label.style = 'font-size: 11px; font-weight: 600;';
        this.add_child(this._label);

        this._state = null;        // parsed status file
        this._control = {          // values we drive
            watt: 20,
            maxTemp: 85,
            min: 5,
            max: WATT_MAX,
            boost: 1.0,
            domain: 'package',
        };
        this._pendingWrite = false;
        this._valueLabels = [];

        this._buildMenu();
        this._poll();
        this._timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, POLL_MS, () => this._poll());
    }

    _buildMenu() {
        this._rowService = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._rowStatus = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._rowPl = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._rowService);
        this.menu.addMenuItem(this._rowStatus);
        this.menu.addMenuItem(this._rowPl);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._wattSlider = this._addSlider('Target watt', 20, WATT_MIN,
            WATT_MAX, (v) => {
                this._control.watt = v;
                this._scheduleWrite();
            });
        this._tempSlider = this._addSlider('Temp ceiling', 85, 40, 120,
            (v) => {
                this._control.maxTemp = v;
                this._scheduleWrite();
            });

        this._boostSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Boost bursts (1.5×)', false);
        this.menu.addMenuItem(this._boostSwitch);
        this._boostSwitch.connect('notify::state', (sw) => {
            this._control.boost = sw.state ? 1.5 : 1.0;
            this._scheduleWrite();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const [name, p] of Object.entries(PROFILES)) {
            const item = new PopupMenu.PopupMenuItem(`Apply: ${name}`);
            item.connect('activate', () => {
                Object.assign(this._control, {
                    watt: p.watt,
                    maxTemp: p.maxTemp,
                    boost: p.boost,
                });
                this._syncSliders();
                this._writeControl();
            });
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._powerSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Autotune service', false);
        this.menu.addMenuItem(this._powerSwitch);
        this._powerSwitch.connect('notify::state', (sw) => {
            const action = sw.state ? 'start' : 'stop';
            this._systemctl(action, (err) => {
                if (err) {
                    this._rowService.label.text =
                        `Service: ${action} failed`;
                    sw.setToggleState(!sw.state);
                }
            });
        });
    }

    _addSlider(title, initial, min, max, onValue) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const titleLabel = new St.Label({text: title, y_expand: true});
        const valueLabel = new St.Label({text: `${initial}`});
        const slider = new Slider((initial - min) / (max - min));

        slider.style = 'min-width: 160px;';
        item.add_child(titleLabel);
        item.add_child(slider);
        item.add_child(valueLabel);

        slider.connect('notify::value', () => {
            const v = Math.round(min + slider.value * (max - min));
            valueLabel.text = `${v}`;
            onValue(v);
        });
        slider.connect('drag-end', () => this._scheduleWrite());

        this.menu.addMenuItem(item);
        this._valueLabels.push(valueLabel);
        return slider;
    }

    // ------------------------------------------------------------ wiring

    _syncSliders() {
        const c = this._control;
        const w = (c.watt - WATT_MIN) / (WATT_MAX - WATT_MIN);
        const t = (c.maxTemp - 40) / (120 - 40);
        this._wattSlider.value = w;
        this._tempSlider.value = t;
        this._valueLabels[0].text = `${c.watt}`;
        this._valueLabels[1].text = `${c.maxTemp}`;
        this._boostSwitch.setToggleState(c.boost > 1.0);
    }

    _scheduleWrite() {
        this._pendingWrite = true;
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._debounce = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                this._debounce = null;
                this._writeControl();
                return GLib.SOURCE_REMOVE;
            });
    }

    _writeControl() {
        const c = this._control;
        const text = `watt=${c.watt}\n` +
            `max-temp=${c.maxTemp}\n` +
            `min=${c.min}\n` +
            `max=${c.max}\n` +
            `boost=${c.boost}\n` +
            `domain=${c.domain}\n`;
        try {
            const file = Gio.File.new_for_path(CONTROL_FILE);
            file.replace_contents(new TextEncoder().encode(text),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`autotune-tuner: control write failed: ${e}`);
        }
    }

    _systemctl(action, cb) {
        // Passwordless via /etc/sudoers.d/50-intel-undervolt-autotune,
        // right scoped to exactly start/stop of this unit.
        const argv = ['sudo', '-n', 'systemctl', action,
            'intel-undervolt-autotune.service'];
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.NONE, null);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                    cb(null);
                } catch (e) {
                    cb(e);
                }
            });
        } catch (e) {
            cb(e);
        }
    }

    _poll() {
        if (this._pendingWrite && this._debounce === null) {
            this._pendingWrite = false;
            this._writeControl();
        }

        const stale = mtimeNowOld(STATUS_FILE, STALE_MS);
        const text = readFile(STATUS_FILE);
        const state = stale ? null : parseKV(text);
        this._state = state;

        // First status after boot also initializes the sliders.
        if (state && !this._initialized) {
            this._control.watt = parseInt(state.target, 10) || 20;
            this._control.maxTemp = parseFloat(state['max-temp']) || 85;
            this._control.boost = parseFloat(state.boost) || 1.0;
            this._control.domain = state.domain || 'package';
            this._initialized = true;
            this._syncSliders();
        }

        this._render(state);
        return GLib.SOURCE_CONTINUE;
    }

    _render(state) {
        const running = state !== null;
        this._powerSwitch.setToggleState(running);

        if (running) {
            const measured = parseFloat(state.measured);
            const temp = parseFloat(state.temp);
            const pl1 = parseInt(state.pl1, 10);
            const pl2 = parseInt(state.pl2, 10);
            const thermal = state.thermal === '1';

            const w = Number.isFinite(measured) ? measured.toFixed(1) : '—';
            const t = Number.isFinite(temp) ? `${temp.toFixed(0)}°C` : '—';
            this._label.text = `⚡ ${w}W`;
            this._rowService.label.text = 'Service: ● running';
            this._rowStatus.label.text =
                `${w} W · ${t}${thermal ? ' · thermal' : ''}`;
            this._rowPl.label.text = `PL ${pl1}/${pl2} W`;
            this._rowStatus.label.style =
                thermal ? 'color: #f66151;' : 'color: #8ff0a4;';
        } else {
            this._label.text = '⚡ off';
            this._rowService.label.text = 'Service: ○ stopped';
            this._rowStatus.label.text = '—';
            this._rowPl.label.text = '—';
            this._rowStatus.label.style = '';
        }
    }

    destroy() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        if (this._debounce) {
            GLib.source_remove(this._debounce);
            this._debounce = null;
        }
        super.destroy();
    }
});

// ---------------------------------------------------------------- extension

export default class AutotuneTunerExtension extends Extension {
    enable() {
        this._inserted = false;
        this._retry = null;
        this._indicator = new TunerIndicator();
        this._insert();
    }

    _insert() {
        if (this._inserted)
            return;

        const qs = Main.panel.statusArea?.quickSettings;

        if (!qs || !qs._system || !qs._indicators) {
            this._retry = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 100, () => {
                    this._retry = null;
                    this._insert();
                    // stop retrying once we got in, keep trying while not
                    return this._inserted
                        ? GLib.SOURCE_REMOVE
                        : GLib.SOURCE_CONTINUE;
                });
            return;
        }

        qs._indicators.insert_child_below(this._indicator, qs._system);
        this._indicator.show();
        this._inserted = true;
    }

    disable() {
        if (this._retry) {
            GLib.source_remove(this._retry);
            this._retry = null;
        }
        if (this._indicator && this._inserted) {
            this._indicator.destroy();
        }
        this._indicator = null;
        this._inserted = false;
    }
}