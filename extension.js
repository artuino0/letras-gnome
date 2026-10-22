// Letras: tarjeta flotante con la línea anterior, la actual y la siguiente de la canción que suena.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {MprisWatcher} from './mpris.js';
import {LrcLib, indexAt} from './lrclib.js';
import {ArtCache} from './art.js';

const BASE_WIDTH = 720; // ancho con el que se diseñaron los tamaños de letra
const MIN_WIDTH = 300;
const MAX_WIDTH = 1400;
const EDGE = 16; // px del borde que sirven para cambiar el ancho
const TICK_MS = 100;
const NOTE = '♪';
// Tamaños de letra (pt) a BASE_WIDTH; se escalan con el ancho
const FONT = {title: 9.5, side: 14, current: 23};

// Margen transparente alrededor de la tarjeta: ahí se dibuja la sombra sin dejar rastros (igual en CSS)
const MARGIN = 14;
const PAD_X = 28; // padding horizontal de .letras-content
const MARQUEE_SPEED = 35; // px/s del riel del título
const MARQUEE_PAUSE = 1800; // ms quieto al inicio y al final
const ART_OPACITY = 140; // 0-255: la portada deja ver el escritorio detrás

class LyricCard {
    constructor(settings) {
        this._settings = settings;
        this._drag = null;
        this._grab = null;
        this._showing = false;
        this._marqueeId = 0;
        this._destroyed = false;

        this.actor = new St.Widget({
            style_class: 'letras-outer',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
        });
        this._panel = new St.Widget({
            style_class: 'letras-card',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._panel);

        // Capas: portada, oscurecido, contenido y agarraderas de los lados
        this._art = new St.Widget({style_class: 'letras-art', x_expand: true, y_expand: true, visible: false, opacity: ART_OPACITY});
        this._shade = new St.Widget({style_class: 'letras-shade', x_expand: true, y_expand: true});
        this._content = new St.BoxLayout({
            style_class: 'letras-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._grips = [Clutter.ActorAlign.START, Clutter.ActorAlign.END].map(align => new St.Widget({
            style_class: 'letras-grip', x_align: align, y_align: Clutter.ActorAlign.CENTER, opacity: 0,
        }));
        for (const a of [this._art, this._shade, this._content, ...this._grips])
            this._panel.add_child(a);

        // Título en un riel: si no cabe se desliza, se detiene y vuelve a empezar
        this._titleClip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_expand: true,
        });
        this._title = new St.Label({style_class: 'letras-title'});
        this._title.clutter_text.set({line_wrap: false, ellipsize: Pango.EllipsizeMode.NONE});
        this._titleClip.add_child(this._title);
        this._content.add_child(this._titleClip);

        this._prev = this._sideLabel('letras-prev');
        // La línea actual tiene alto fijo de 2 renglones para que la tarjeta no brinque
        this._curBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
        });
        this._cur = new St.Label({
            style_class: 'letras-current',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cur.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
            line_alignment: Pango.Alignment.CENTER,
        });
        this._curBox.add_child(this._cur);
        this._content.add_child(this._curBox);
        this._next = this._sideLabel('letras-next');

        // Al apagarse GNOME la tarjeta puede destruirse antes que disable()
        this.actor.connect('destroy', () => {
            this._destroyed = true;
        });
        this.actor.connect('notify::hover', () => {
            this._showGrips(this.actor.hover);
            if (!this.actor.hover && !this._drag)
                this.actor.set_cursor_type(Clutter.Cursor.INHERIT);
        });
        this.actor.connect('button-press-event', (a, e) => this._dragStart(a, e));
        this.actor.connect('motion-event', (a, e) => this._dragMove(a, e));
        this.actor.connect('button-release-event', () => this._dragEnd());

        // Encima de todo, incluso de apps en pantalla completa
        Main.layoutManager.addTopChrome(this.actor);
        this._scaleId = St.ThemeContext.get_for_stage(global.stage)
            .connect('notify::scale-factor', () => this.place());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this.place());
        this.place();
    }

    // Líneas anterior y siguiente: un solo renglón, siempre presentes para no cambiar el alto
    _sideLabel(style) {
        const l = new St.Label({style_class: style, x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.set({
            line_wrap: false,
            ellipsize: Pango.EllipsizeMode.END,
            line_alignment: Pango.Alignment.CENTER,
        });
        this._content.add_child(l);
        return l;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    get _width() {
        return Math.min(Math.max(this._settings.get_int('width'), MIN_WIDTH), MAX_WIDTH);
    }

    _showGrips(on) {
        for (const g of this._grips)
            g.ease({opacity: on || this._drag ? 255 : 0, duration: 150});
    }

    // Ajusta el ancho (lógico) y escala la letra en proporción
    _applyWidth(width) {
        const s = this._scale;
        this.actor.set_width(Math.round(width * s));
        const f = Math.min(Math.max(width / BASE_WIDTH, 0.55), 1.5);
        this._title.style = `font-size: ${(FONT.title * Math.max(f, 0.85)).toFixed(1)}pt;`;
        this._prev.style = this._next.style = `font-size: ${(FONT.side * f).toFixed(1)}pt;`;
        this._cur.style = `font-size: ${(FONT.current * f).toFixed(1)}pt;`;
        this._titleClip.width = Math.max(Math.round((width - 2 * (MARGIN + PAD_X)) * s), 1);
        this._fixCurrentHeight();
        this._restartMarquee();
    }

    _fixCurrentHeight() {
        // Solo se puede medir con el estilo aplicado, es decir, ya en pantalla
        if (!this.actor.mapped)
            return;
        const text = this._cur.text;
        this._cur.text = 'Ág\nÁg';
        const [, h] = this._cur.get_preferred_height(-1);
        this._cur.text = text;
        this._curBox.height = h;
    }

    // Coloca la tarjeta donde la dejó el usuario, o abajo al centro la primera vez
    place() {
        if (this._destroyed)
            return;
        this._applyWidth(this._width);
        const w = this.actor.width;
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        let x = this._settings.get_int('pos-x');
        let y = this._settings.get_int('pos-y');
        const [, h] = this.actor.get_preferred_height(w);
        if (x < 0 || y < 0) {
            x = m.x + (m.width - w) / 2;
            y = m.y + m.height - h - 130 * this._scale;
        }
        // Que nunca quede fuera de la pantalla
        const area = Main.layoutManager.monitors.find(mon =>
            x >= mon.x && x < mon.x + mon.width && y >= mon.y && y < mon.y + mon.height) ?? m;
        x = Math.min(Math.max(x, area.x), area.x + area.width - w);
        y = Math.min(Math.max(y, area.y), area.y + area.height - Math.max(h, 60));
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    setTrack(text) {
        if (this._destroyed)
            return;
        this._title.text = text;
        this._restartMarquee();
    }

    _stopMarquee() {
        if (this._marqueeId)
            GLib.source_remove(this._marqueeId);
        this._marqueeId = 0;
        this._title.remove_all_transitions();
        this._title.translation_x = 0;
        this._title.opacity = 255;
    }

    _restartMarquee() {
        this._stopMarquee();
        // Espera a que el estilo y el tamaño se apliquen antes de medir
        this._marqueeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._marqueeId = 0;
            this._runMarquee();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runMarquee() {
        // Oculta no se puede medir; show() lo vuelve a lanzar
        if (this._destroyed || !this.actor.mapped)
            return;
        // Quita el ancho fijo anterior para medir el texto nuevo
        this._title.set_width(-1);
        const [, natural] = this._title.get_preferred_width(-1);
        const clipW = this._titleClip.width;
        this._title.set_width(natural);
        const overflow = natural - clipW;
        if (overflow <= 0) {
            this._title.x = Math.round((clipW - natural) / 2);
            return;
        }
        this._title.x = 0;
        this._title.ease({
            translation_x: -overflow,
            delay: MARQUEE_PAUSE,
            duration: Math.round(overflow / (MARQUEE_SPEED * this._scale) * 1000),
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
                this._marqueeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MARQUEE_PAUSE, () => {
                    this._marqueeId = 0;
                    this._title.ease({
                        opacity: 0,
                        duration: 250,
                        onComplete: () => {
                            this._title.translation_x = 0;
                            this._title.ease({opacity: 255, duration: 250, onComplete: () => this._runMarquee()});
                        },
                    });
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    // uri: file:// de la portada, o null para fondo liso
    setArt(uri) {
        if (this._destroyed)
            return;
        if (!uri) {
            this._art.hide();
            this._panel.remove_style_class_name('letras-has-art');
            return;
        }
        this._art.style = `background-image: url("${uri}");`;
        this._art.show();
        this._panel.add_style_class_name('letras-has-art');
    }

    setLines(prev, cur, next, animate) {
        if (this._destroyed)
            return;
        // Espacio duro en vez de vacío para que el renglón conserve su alto
        this._prev.text = prev || ' ';
        this._cur.text = cur;
        this._next.text = next || ' ';
        if (!animate)
            return;
        for (const [l, dy] of [[this._prev, 6], [this._cur, 10], [this._next, 14]]) {
            l.remove_all_transitions();
            l.opacity = 0;
            l.translation_y = dy;
            l.ease({opacity: 255, translation_y: 0, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    show() {
        if (this._showing || this._destroyed)
            return;
        this._showing = true;
        this.actor.show();
        this.place();
        this.actor.remove_all_transitions();
        this.actor.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    hide() {
        if (!this._showing || this._drag || this._destroyed)
            return;
        this._showing = false;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._showing)
                    this.actor.hide();
            },
        });
    }

    // Zona bajo el puntero: bordes izquierdo/derecho cambian el ancho, el resto mueve
    _zone(actor, sx) {
        const localX = sx - actor.x;
        const edge = (MARGIN + EDGE) * this._scale;
        if (localX >= actor.width - edge)
            return 'right';
        if (localX <= edge)
            return 'left';
        return 'move';
    }

    _dragStart(actor, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        this._drag = {mode: this._zone(actor, sx), sx, sy, x: actor.x, y: actor.y, w: actor.width};
        this._grab = global.stage.grab(actor);
        if (this._drag.mode === 'move')
            actor.set_cursor_type(Clutter.Cursor.GRABBING);
        return Clutter.EVENT_STOP;
    }

    _dragMove(actor, event) {
        const d = this._drag;
        const [sx, sy] = event.get_coords();
        if (!d) {
            actor.set_cursor_type(this._zone(actor, sx) === 'move' ? Clutter.Cursor.GRAB : Clutter.Cursor.EW_RESIZE);
            return Clutter.EVENT_PROPAGATE;
        }
        const s = this._scale;
        const clampW = w => Math.min(Math.max(w, MIN_WIDTH * s), MAX_WIDTH * s);
        if (d.mode === 'move') {
            actor.set_position(Math.round(d.x + sx - d.sx), Math.round(d.y + sy - d.sy));
        } else if (d.mode === 'right') {
            this._applyWidth(clampW(d.w + sx - d.sx) / s);
        } else {
            const w = clampW(d.w - (sx - d.sx));
            this._applyWidth(w / s);
            actor.set_position(Math.round(d.x + d.w - w), Math.round(d.y));
        }
        return Clutter.EVENT_STOP;
    }

    _dragEnd() {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        this.actor.set_cursor_type(Clutter.Cursor.INHERIT);
        this._showGrips(this.actor.hover);
        this._settings.set_int('width', Math.round(this.actor.width / this._scale));
        this._settings.set_int('pos-x', Math.round(this.actor.x));
        this._settings.set_int('pos-y', Math.round(this.actor.y));
        return Clutter.EVENT_STOP;
    }

    destroy() {
        const alive = !this._destroyed;
        this._destroyed = true;
        if (this._marqueeId)
            GLib.source_remove(this._marqueeId);
        this._marqueeId = 0;
        this._grab?.dismiss();
        St.ThemeContext.get_for_stage(global.stage).disconnect(this._scaleId);
        Main.layoutManager.disconnect(this._monitorsId);
        if (!alive)
            return;
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

class LetrasIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(settings, onReset) {
        super(0.5, 'Letras');
        this.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'system-status-icon'}));

        this._status = new PopupMenu.PopupMenuItem('Sin música', {reactive: false});
        this._status.label.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const toggle = new PopupMenu.PopupSwitchMenuItem('Mostrar letra', settings.get_boolean('visible'));
        toggle.connect('toggled', (_i, state) => settings.set_boolean('visible', state));
        const artToggle = new PopupMenu.PopupSwitchMenuItem('Portada de fondo', settings.get_boolean('show-art'));
        artToggle.connect('toggled', (_i, state) => settings.set_boolean('show-art', state));
        this._settingsIds = [
            settings.connect('changed::visible', () => toggle.setToggleState(settings.get_boolean('visible'))),
            settings.connect('changed::show-art', () => artToggle.setToggleState(settings.get_boolean('show-art'))),
        ];
        this._settings = settings;
        this.menu.addMenuItem(toggle);
        this.menu.addMenuItem(artToggle);

        const reset = new PopupMenu.PopupMenuItem('Regresar a tamaño y posición iniciales');
        reset.connect('activate', onReset);
        this.menu.addMenuItem(reset);
        this.connect('destroy', () => {
            this._destroyed = true;
        });
    }

    setStatus(text) {
        // Al cerrar sesión GNOME puede destruir el menú antes que disable()
        if (this._destroyed)
            return;
        this._status.label.text = text;
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        super.destroy();
    }
}

export default class LetrasExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._lrclib = new LrcLib();
        this._artCache = new ArtCache();
        this._card = new LyricCard(this._settings);
        this._indicator = new LetrasIndicator(this._settings, () => {
            for (const k of ['pos-x', 'pos-y', 'width'])
                this._settings.reset(k);
            this._card.place();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._artId = this._settings.connect('changed::show-art', () => this._loadArt(this._watcher?.active));

        this._trackKey = null;
        this._artUrl = null;
        this._lines = null;
        this._idx = -2;
        this._watcher = new MprisWatcher(p => this._onPlayer(p));
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._settings?.disconnect(this._artId);
        this._watcher?.destroy();
        this._lrclib?.destroy();
        this._artCache?.destroy();
        this._card?.destroy();
        this._indicator?.destroy();
        this._watcher = this._lrclib = this._artCache = this._card = this._indicator = this._settings = null;
        this._lines = null;
    }

    _loadArt(p) {
        const url = this._settings.get_boolean('show-art') ? p?.artUrl ?? '' : '';
        this._artUrl = url;
        if (!url) {
            this._card.setArt(null);
            return;
        }
        this._artCache.get(url).then(uri => {
            if (this._artUrl === url && this._card)
                this._card.setArt(uri);
        }).catch(() => this._card?.setArt(null));
    }

    _onPlayer(p) {
        if (!p?.title) {
            this._trackKey = null;
            this._lines = null;
            this._indicator.setStatus('Sin música');
            return;
        }
        // La portada a veces llega después que el título
        if ((p.artUrl ?? '') !== this._artUrl)
            this._loadArt(p);
        if (p.trackKey === this._trackKey)
            return;
        const key = this._trackKey = p.trackKey;
        this._lines = null;
        this._idx = -2;
        this._card.setTrack(`${p.title} — ${p.artist}`);
        this._indicator.setStatus(`Buscando letra…\n${p.title} — ${p.artist}`);
        this._lrclib.find(p).then(res => {
            if (this._trackKey !== key || !this._indicator)
                return;
            this._lines = res?.lines?.length ? res.lines : null;
            this._indicator.setStatus(this._lines
                ? `${p.title} — ${p.artist}`
                : `Sin letra sincronizada\n${p.title} — ${p.artist}`);
        }).catch(() => {});
    }

    _tick() {
        const p = this._watcher.active;
        if (!p || !this._lines || p.status !== 'Playing' || !this._settings.get_boolean('visible')) {
            this._card.hide();
            return;
        }
        const i = indexAt(this._lines, this._watcher.position(p));
        if (i !== this._idx) {
            const t = k => {
                if (k < 0 || k >= this._lines.length)
                    return '';
                return this._lines[k].text || NOTE;
            };
            const first = this._idx === -2;
            this._idx = i;
            if (i < 0)
                this._card.setLines('', NOTE, t(0), !first);
            else
                this._card.setLines(t(i - 1), t(i), t(i + 1), !first);
        }
        this._card.show();
    }
}
