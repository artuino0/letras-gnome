# Letras

Extensión de GNOME Shell que muestra la letra sincronizada de la canción que suena en una tarjeta flotante, siempre encima de todo: línea anterior, actual y siguiente.

- Funciona con cualquier reproductor MPRIS: Spotify, YouTube en Firefox o Chrome, VLC, Rhythmbox…
- Las letras salen de [LRCLIB](https://lrclib.net), gratis y sin cuenta.
- La portada del álbum se usa como fondo translúcido (se puede apagar).
- Se arrastra para moverla; arrastrando los lados cambia el ancho y la letra se escala.
- Si el título no cabe, se desliza como riel.
- Desde el ícono del panel se oculta, se quita la portada o se regresa a su tamaño y posición iniciales.

Requiere GNOME Shell 50.

## Instalar desde el código

```sh
git clone https://github.com/artuino0/letras-gnome.git
cd letras-gnome
glib-compile-schemas schemas/
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/letras@artuino0.github.io
```

Cierra sesión, vuelve a entrar y actívala:

```sh
gnome-extensions enable letras@artuino0.github.io
```

## Empaquetar

```sh
gnome-extensions pack --force --extra-source=art.js --extra-source=lrclib.js --extra-source=mpris.js .
```

## Privacidad

Para buscar la letra se envían a lrclib.net el título, artista, álbum y duración de la canción. La portada se descarga de la dirección que da el reproductor y se guarda en `~/.cache/letras/art`.

## Licencia

GPL-2.0-or-later
