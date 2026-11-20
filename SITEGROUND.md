# Puesta en producción en SiteGround

**Dominio:** `https://baviera.ligaprinzipiantes.com`
**Plan:** GoGeek · proyecto Node.js desplegado desde GitHub · base de datos MySQL (phpMyAdmin)

## Qué se publica en esta fase

| Sección | Estado |
|---|---|
| Portada, inscripción de jugadores (2 pasos), página de gracias | ✅ Pública |
| Política de privacidad y consentimientos | ✅ Pública |
| Crear contraseña desde el correo / recuperar contraseña | ✅ Pública |
| Mi ficha, clasificación, jornadas (con inscripción), jugadores y tarjetas | 🔒 Solo jugadores con contraseña creada |
| Panel del comité (inscripciones, exportación a Excel, jornadas, campo, ajustes) | 🔒 Solo el comité |
| Tarjeta live y tienda | 📝 En borrador: solo las ve el comité. Se activan en *Comité → Ajustes*. |

---

## 1. Base de datos MySQL

1. Abre **Site Tools** del proyecto Node.js y ve a **Site → MySQL → Databases → Create Database**.
2. En **Users**, crea un usuario con una contraseña segura y dale acceso **All privileges** a esa base de datos.
3. Apunta tres datos: nombre de la base de datos, usuario y contraseña. El host es `localhost`, salvo que SiteGround indique otro.

**No hace falta importar nada:** la aplicación crea las tablas y los datos iniciales en el primer arranque (campo, 10 jornadas y la cuenta del comité). Si preferís crear las tablas a mano, importad `sql/schema.sql` desde phpMyAdmin (pestaña *Importar*).

## 2. Buzón para enviar los correos

1. Ve a **Site Tools → Email → Accounts** y crea `noreply@ligaprinzipiantes.com`.
2. En el menú del buzón, abre **Mail Configuration** y apunta:
   - el servidor de salida (SMTP), normalmente `mail.ligaprinzipiantes.com`;
   - el puerto **465** (SSL).

> El correo de SiteGround no funciona con el dominio temporal del proyecto. Asigna primero el dominio definitivo (paso 4).

## 3. Variables de entorno

Configúralas en **Site Tools → Node.js → Deployment Options → Environment variables**. La plantilla completa está en `.env.example`.

| Variable | Valor |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | los del paso 1 |
| `PUBLIC_URL` | `https://baviera.ligaprinzipiantes.com` |
| `SMTP_HOST` / `SMTP_PORT` | los del paso 2 (`465`) |
| `SMTP_USER` / `SMTP_PASSWORD` | `noreply@ligaprinzipiantes.com` y su contraseña |
| `MAIL_FROM` | `Liga de Golf Baviera <noreply@ligaprinzipiantes.com>` |
| `ADMIN_NOTIFY_EMAIL` | email(s) del comité que reciben aviso de cada inscripción |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | cuenta del comité (se crea en el primer arranque) |
| `SEED_DEMO` | `false` |

Ajustes de despliegue en esa misma pantalla:
- **Node version:** 24.
- **Build command:** vacío.
- **Comando de arranque:** `npm start`, si lo pide.

## 4. Dominio `baviera.ligaprinzipiantes.com`

1. Ve a **Client Area → Websites → Node.js Projects**, abre el menú del proyecto y elige **Change domain**. Escribe `baviera.ligaprinzipiantes.com`.
2. Si el DNS de `ligaprinzipiantes.com` no está en SiteGround, crea en vuestro proveedor de DNS el registro que indique SiteGround (A o CNAME para `baviera`).
3. Ve a **Site Tools → Security → SSL Manager**, instala el certificado Let's Encrypt y activa **HTTPS Enforce**.

## 5. Publicar desde GitHub

```bash
git push
```

SiteGround construye y publica la app automáticamente. En **Node.js → Logs → View build log** deben aparecer estas líneas:

```
Liga de Golf Baviera → http://…
MySQL: usuario@localhost/nombre_bd
SMTP listo (mail.ligaprinzipiantes.com:465)
```

Si sale `No se pudo conectar o preparar la base de datos MySQL`, revisa las variables `DB_*`. Si sale `AVISO SMTP`, revisa las `SMTP_*`.

## 6. Antes de anunciar la inscripción (checklist)

- [ ] Entrar con `ADMIN_EMAIL` y cambiar la contraseña (*Mi ficha → Cambiar contraseña*).
- [ ] **Comité → Ajustes → Responsable del tratamiento:** razón social, CIF, dirección y email. Mientras falten, el formulario y la política de privacidad muestran avisos en ámbar.
- [ ] Revisar el texto de la **política de privacidad** con vuestra asesoría (`#/privacidad`).
- [ ] Hacer una inscripción de prueba con un email real. Comprobad que llega el correo, que el enlace crea la contraseña y que la inscripción aparece en *Comité → Inscripciones*. Después, borradla desde el propio panel.
- [ ] Cargar el par, el SI y los metros oficiales en **Comité → Campo**.
- [ ] Revisar las fechas de las 10 jornadas en **Comité → Jornadas**.

## Ver los datos en phpMyAdmin

**Site Tools → Site → MySQL → phpMyAdmin**. Tablas principales:

| Tabla | Contenido |
|---|---|
| `users` | Jugadores y comité: datos personales, estado (`pending` = aún no ha creado contraseña, `active`, `disabled`) y consentimientos actuales. |
| `consents` | Historial de consentimientos (fecha, IP, versión del texto). Es la prueba exigida por el RGPD: no se debe editar. |
| `photos` | Fotografías de los jugadores. |
| `rounds`, `entries`, `tee_groups`, `cards`, `scores` | Jornadas, inscripciones, partidas, tarjetas y golpes. |
| `audit` | Registro de acciones del comité. |

Para trabajar con los jugadores es más cómodo usar **Comité → Inscripciones → Exportar a Excel (CSV)**. Las fotos se descargan desde la ficha de cada jugador en ese mismo panel.

## Copias de seguridad

- SiteGround hace copias diarias de archivos y bases de datos: **Site Tools → Security → Backups**.
- Copia manual en cualquier momento: phpMyAdmin → base de datos → **Exportar → SQL**.

## Actualizar la aplicación

Para cada cambio:

```bash
git add -A
```

```bash
git commit -m "Describe el cambio"
```

```bash
git push
```

Los datos están en MySQL, así que un despliegue nuevo no los toca.
