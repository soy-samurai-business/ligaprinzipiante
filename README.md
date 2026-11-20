# Liga de Golf Baviera

Plataforma de la liga: 10 jornadas a 9 hoyos en Baviera Golf, con clasificación por las 8 mejores tarjetas.

**Producción:** https://baviera.ligaprinzipiantes.com (SiteGround, Node.js + MySQL). Guía de puesta en marcha: [SITEGROUND.md](SITEGROUND.md).

## Fase actual

- **Inscripción de jugadores** en dos pasos:
  - **Datos:** nombre, apellidos, licencia, fecha de nacimiento, hándicap, talla de polo, Instagram, email, teléfono y fotografía.
  - **Privacidad y consentimientos:** obligatorio para la gestión de la liga; opcionales para las notificaciones y para publicar su imagen en redes. Si es menor de 14 años, autorización del tutor.
- **Página de gracias**, y **correo con un enlace de un solo uso** (72 h) para crear la contraseña.
- **Área del jugador:**
  - Mi ficha: editar datos y foto, y retirar o dar consentimientos.
  - Puntuaciones y tarjetas.
  - Clasificación e inscripción a las próximas jornadas.
- **Panel del comité:**
  - Inscripciones con foto, exportación a Excel, reenvío del correo y eliminación de datos.
  - Jornadas y partidas, campo, ajustes y auditoría.
- **En borrador** (solo las ve el comité): tarjeta live y tienda. Se activan en *Comité → Ajustes*.

## Desarrollo en local

Requiere Node.js 22.13 o superior y MySQL.

```bash
npm install
```

```bash
cp .env.example .env
```

Edita `.env` con tu MySQL local.

```bash
npm run db:demo
```

Crea las tablas con datos de ejemplo (12 jugadores ficticios con la contraseña `golf123`).

```bash
npm start
```

La app queda en http://localhost:3000. Sin `SMTP_HOST`, los correos no se envían: se escriben en el log, con el enlace para crear la contraseña.

## Reglas de puntuación

- **Hándicap de juego (9 hoyos):** hándicap ÷ 2 × % de aplicación, redondeado. Se fija al generar las partidas.
- **Golpes recibidos:** se reparten por el índice de dificultad (SI) de los 9 hoyos que se juegan.
- **Puntos Stableford:** máx(0, 2 + par + golpes recibidos − golpes).

## Estructura

```
server.js        API, sesiones, registro, consentimientos y tiempo real
db.js            conexión MySQL, creación de tablas, datos iniciales y partidas
sql/schema.sql   esquema MySQL (también importable en phpMyAdmin)
mailer.js        envío de correos (SMTP) y plantillas
scoring.js       Stableford, golpes recibidos y mejores N tarjetas
public/          aplicación web (index.html, app.js, styles.css)
```

## Pendiente para siguientes fases

- Activar la tarjeta live y la tienda (con pago online).
- Cargar la tarjeta oficial del campo (par, SI y metros).
- Confirmar con el comité la fórmula de hándicap: WHS completa o ÷ 2.
