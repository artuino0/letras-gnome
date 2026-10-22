// Descarga las portadas (Spotify las da como https://) a ~/.cache/letras/art para usarlas como fondo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export class ArtCache {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'letras', 'art']);
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._session = new Soup.Session({user_agent: 'Letras GNOME/1.0', timeout: 10});
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }

    // Devuelve una URI file:// local o null
    async get(url) {
        if (!url)
            return null;
        if (url.startsWith('file://'))
            return url;
        if (!url.startsWith('http'))
            return null;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]));
        if (file.query_exists(null))
            return file.get_uri();

        const msg = Soup.Message.new('GET', url);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (s, r) => {
                try {
                    resolve(s.send_and_read_finish(r));
                } catch (e) {
                    reject(e);
                }
            });
        });
        // status_code en vez de get_status(): este truena con códigos que GJS no conoce
        if (msg.status_code !== 200 || !bytes.get_size())
            return null;
        await new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE,
                this._cancellable, (f, r) => {
                    try {
                        resolve(f.replace_contents_finish(r));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        return file.get_uri();
    }
}
