// Sigue a los reproductores MPRIS (Spotify, Firefox, VLC…) y calcula la posición
// de la canción sin preguntarle al reproductor en cada cuadro.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJ_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DBUS = ['org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus'];

const nowUs = () => GLib.get_monotonic_time();

export class MprisWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._bus = Gio.DBus.session;
        this._players = new Map(); // nombre de bus -> estado
        this._active = null;
        this._cancellable = new Gio.Cancellable();

        this._subs = [
            this._bus.signal_subscribe(DBUS[0], DBUS[2], 'NameOwnerChanged', DBUS[1], null,
                Gio.DBusSignalFlags.NONE, (...a) => this._onNameOwner(a[5])),
            this._bus.signal_subscribe(null, PROPS_IFACE, 'PropertiesChanged', OBJ_PATH, null,
                Gio.DBusSignalFlags.NONE, (...a) => this._onProps(a[1], a[5])),
            this._bus.signal_subscribe(null, PLAYER_IFACE, 'Seeked', OBJ_PATH, null,
                Gio.DBusSignalFlags.NONE, (...a) => this._onSeeked(a[1], a[5])),
        ];

        this._call(...DBUS, 'ListNames', null).then(r => {
            const [names] = r.deepUnpack();
            for (const n of names.filter(x => x.startsWith(PREFIX)))
                this._addPlayer(n);
        }).catch(e => this._log(e));

        // Corrige la deriva cada 2 s
        this._resyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            if (this._active?.status === 'Playing')
                this._fetchPosition(this._active).catch(() => {});
            return GLib.SOURCE_CONTINUE;
        });
    }

    get active() {
        return this._active;
    }

    // Posición actual en microsegundos
    position(p = this._active) {
        if (!p)
            return 0;
        if (p.status !== 'Playing')
            return p.position;
        return p.position + (nowUs() - p.positionAt);
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._subs)
            this._bus.signal_unsubscribe(id);
        this._subs = [];
        if (this._resyncId)
            GLib.source_remove(this._resyncId);
        this._resyncId = 0;
        this._players.clear();
        this._active = null;
        this._onChange = null;
    }

    _log(e) {
        if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.debug(`letras: ${e}`);
    }

    _call(dest, path, iface, method, params) {
        return new Promise((resolve, reject) => {
            this._bus.call(dest, path, iface, method, params, null,
                Gio.DBusCallFlags.NONE, 2000, this._cancellable, (bus, res) => {
                    try {
                        resolve(bus.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _bySender(sender) {
        for (const p of this._players.values()) {
            if (p.owner === sender || p.busName === sender)
                return p;
        }
        return null;
    }

    _onNameOwner(params) {
        const [name, , newOwner] = params.deepUnpack();
        if (!name.startsWith(PREFIX))
            return;
        if (newOwner) {
            this._addPlayer(name);
        } else {
            this._players.delete(name);
            this._emit();
        }
    }

    async _addPlayer(name) {
        if (this._players.has(name))
            return;
        const p = {
            busName: name, owner: null, status: 'Stopped',
            title: '', artist: '', album: '', artUrl: '', length: 0, trackKey: '',
            position: 0, positionAt: nowUs(),
        };
        this._players.set(name, p);
        try {
            [p.owner] = (await this._call(...DBUS, 'GetNameOwner',
                new GLib.Variant('(s)', [name]))).deepUnpack();
            const [props] = (await this._call(name, OBJ_PATH, PROPS_IFACE, 'GetAll',
                new GLib.Variant('(s)', [PLAYER_IFACE]))).deepUnpack();
            this._apply(p, props);
            await this._fetchPosition(p);
        } catch (e) {
            this._log(e);
        }
        this._emit();
    }

    _apply(p, props) {
        let changed = false;
        if (props.Metadata) {
            const md = props.Metadata.recursiveUnpack();
            const artist = md['xesam:artist'];
            p.title = md['xesam:title'] ?? '';
            p.artist = Array.isArray(artist) ? artist.join(', ') : artist ?? '';
            p.album = md['xesam:album'] ?? '';
            p.artUrl = md['mpris:artUrl'] ?? '';
            p.length = Number(md['mpris:length'] ?? 0);
            const key = `${p.title}\u0000${p.artist}\u0000${p.length}`;
            if (key !== p.trackKey) {
                p.trackKey = key;
                p.position = 0;
                p.positionAt = nowUs();
                changed = true;
            }
        }
        if (props.PlaybackStatus) {
            const status = props.PlaybackStatus.unpack();
            if (status !== p.status) {
                // Congela la posición calculada antes de cambiar de estado
                p.position = this.position(p);
                p.positionAt = nowUs();
                p.status = status;
                changed = true;
            }
        }
        return changed;
    }

    async _fetchPosition(p) {
        const r = await this._call(p.busName, OBJ_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']));
        const pos = Number(r.deepUnpack()[0].unpack());
        // Algunos reproductores reportan 0 a media canción; en ese caso confiamos en el cálculo propio
        if (pos === 0 && this.position(p) > 3_000_000)
            return;
        p.position = pos;
        p.positionAt = nowUs();
    }

    _onProps(sender, params) {
        const [iface, changedProps] = params.deepUnpack();
        if (iface !== PLAYER_IFACE)
            return;
        const p = this._bySender(sender);
        if (!p)
            return;
        if (this._apply(p, changedProps))
            this._fetchPosition(p).catch(e => this._log(e)).finally(() => this._emit());
        else
            this._emit();
    }

    _onSeeked(sender, params) {
        const p = this._bySender(sender);
        if (!p)
            return;
        p.position = Number(params.deepUnpack()[0]);
        p.positionAt = nowUs();
        this._emit();
    }

    _emit() {
        const players = [...this._players.values()];
        const playing = players.filter(p => p.status === 'Playing');
        if (this._active?.status === 'Playing' && this._players.has(this._active.busName))
            ; // se queda el que ya estaba sonando
        else if (playing.length)
            this._active = playing[0];
        else if (!this._players.has(this._active?.busName))
            this._active = players.find(p => p.title) ?? null;
        this._onChange?.(this._active);
    }
}
