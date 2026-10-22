// Busca letras sincronizadas en LRCLIB (https://lrclib.net/docs) y las convierte en líneas con tiempo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const API = 'https://lrclib.net/api/';
const MAX_DURATION_DIFF = 8; // segundos de diferencia aceptables entre versiones

// Quita sufijos que los reproductores agregan y LRCLIB no suele tener
export function cleanTitle(title) {
    return title
        .replace(/\s+[-–]\s+(from|remaster|remastered|live|radio edit|single|mono|stereo|feat\.?|ft\.?|with)\b.*$/i, '')
        .replace(/\s*[([](feat\.?|ft\.?|with|from|remaster|remastered|live)\b[^)\]]*[)\]]/gi, '')
        .trim();
}

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Para títulos de YouTube: quita (…), […], comillas y "feat. …"
export function stripExtras(text) {
    return text
        .replace(/\s*[([{【][^)\]}】]*[)\]}】]/g, '')
        .replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, '')
        .replace(/["“”«»]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Nombres de canal que no son el artista: "Artista - Topic", "ArtistaVEVO"
function cleanArtist(artist) {
    return artist.replace(/\s+-\s+topic$/i, '').replace(/\s*vevo$/i, '').replace(/\s+official$/i, '').trim();
}

// Combinaciones de título y artista para buscar, de la más confiable a la menos
export function guesses(track) {
    const out = [];
    const add = (title, artist) => {
        title = title?.trim();
        artist = artist?.trim() ?? '';
        if (title && !out.some(g => g.title === title && g.artist === artist))
            out.push({title, artist});
    };
    const artist = cleanArtist(track.artist ?? '');
    add(cleanTitle(track.title), artist);
    const parts = track.title.split(/\s+[-–—|]\s+/);
    if (parts.length >= 2) {
        const first = stripExtras(parts[0]);
        const rest = stripExtras(parts.slice(1).join(' '));
        add(rest, first); // "Artista - Canción", lo normal en YouTube
        add(first, rest); // "Canción - Artista"
    }
    add(stripExtras(track.title), artist);
    return out;
}

export function parseLrc(text) {
    let offsetMs = 0;
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
        if (off) {
            offsetMs = parseInt(off[1]);
            continue;
        }
        const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
        if (!tags.length)
            continue;
        const content = raw.replace(/\[[^\]]*\]/g, '').trim();
        for (const t of tags) {
            const sec = parseInt(t[1]) * 60 + parseFloat(t[2].replace(':', '.'));
            lines.push({time: Math.round(sec * 1e6) - offsetMs * 1000, text: content});
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}

// Índice de la última línea que ya empezó; -1 si todavía no empieza ninguna
export function indexAt(lines, posUs) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= posUs) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

export class LrcLib {
    constructor() {
        this._session = new Soup.Session({user_agent: 'Letras GNOME/1.0 (extensión personal)', timeout: 10});
        this._cancellable = new Gio.Cancellable();
        this._cache = new Map();
        this._retryIds = new Set();
    }

    destroy() {
        for (const id of this._retryIds)
            GLib.source_remove(id);
        this._retryIds.clear();
        this._cancellable.cancel();
        this._session.abort();
        this._cache.clear();
    }

    async _get(path, params, attempt = 1) {
        const query = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const msg = Soup.Message.new('GET', `${API}${path}?${query}`);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (s, r) => {
                try {
                    resolve(s.send_and_read_finish(r));
                } catch (e) {
                    reject(e);
                }
            });
        });
        // status_code es un número; get_status() truena con códigos que GJS no conoce, como 429
        const code = msg.status_code;
        if (code === 429 && attempt < 3) {
            // LRCLIB limita ráfagas de solicitudes: espera y reintenta
            const retry = parseInt(msg.get_response_headers().get_one('Retry-After') ?? '') || attempt * 2;
            await new Promise(resolve => {
                const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.min(retry, 10), () => {
                    this._retryIds.delete(id);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
                this._retryIds.add(id);
            });
            if (this._cancellable.is_cancelled())
                throw new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: 'cancelado'});
            return this._get(path, params, attempt + 1);
        }
        if (code !== 200)
            return null;
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    // Elige el mejor resultado con letra sincronizada para la canción buscada (guess.title)
    _pick(results, track, guess) {
        const secs = track.length / 1e6;
        const want = norm(guess.title);
        const sameTitle = r => {
            const got = norm(stripExtras(cleanTitle(r.trackName)));
            return got === want || (got.length > 2 && want.length > 2 && (got.includes(want) || want.includes(got)));
        };
        const candidates = (results ?? []).filter(r => r.syncedLyrics &&
            (secs ? Math.abs(r.duration - secs) <= MAX_DURATION_DIFF : sameTitle(r)));
        const score = r => (sameTitle(r) ? 0 : 100) + (secs ? Math.abs(r.duration - secs) : 0);
        return candidates.sort((a, b) => score(a) - score(b))[0] ?? null;
    }

    // Devuelve {lines, name} o null si no hay letra sincronizada
    async find(track) {
        if (!track?.title)
            return null;
        const key = track.trackKey;
        if (this._cache.has(key))
            return this._cache.get(key);

        const secs = track.length ? Math.round(track.length / 1e6) : undefined;
        const tries = guesses(track);
        let hit = null;
        try {
            if (secs) {
                const exact = await this._get('get', {
                    track_name: track.title, artist_name: track.artist, album_name: track.album, duration: secs,
                });
                if (exact?.syncedLyrics)
                    hit = exact;
            }
            for (const g of tries) {
                if (hit || !g.artist)
                    continue;
                hit = this._pick(await this._get('search', {track_name: g.title, artist_name: g.artist}), track, g);
            }
            for (const g of tries) {
                if (hit)
                    break;
                hit = this._pick(await this._get('search', {q: `${g.artist} ${g.title}`.trim()}), track, g);
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            console.debug(`letras: error buscando letra: ${e}`);
            return null; // error de red: no se guarda en caché para reintentar después
        }
        const result = hit ? {lines: parseLrc(hit.syncedLyrics), name: `${hit.trackName} — ${hit.artistName}`} : null;
        this._cache.set(key, result);
        return result;
    }
}
