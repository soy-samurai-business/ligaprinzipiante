import nodemailer from 'nodemailer';

// SMTP de la cuenta de correo del dominio (SiteGround: Site Tools → Email → Accounts).
const port = Number(process.env.SMTP_PORT || 465);
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  })
  : null;
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost';

export async function sendMail({ to, subject, html, text }) {
  if (!transport) {
    // Sin SMTP configurado (desarrollo): el correo se muestra en el log en lugar de enviarse.
    console.log(`\n[correo no enviado: falta SMTP_HOST] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
    return { simulated: true };
  }
  return transport.sendMail({ from: FROM, to, subject, html, text });
}

export async function verifyMail() {
  if (!transport) return 'SMTP sin configurar: los correos se escriben en el log';
  await transport.verify();
  return `SMTP listo (${process.env.SMTP_HOST}:${port})`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ league, title, body, button, link, footer }) {
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f3f8f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2b22">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f8f4;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;border:1px solid #dcebe0">
<tr><td style="padding:22px 28px;border-bottom:3px solid #1f8a4c"><span style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f8a4c;font-weight:700">⛳ ${esc(league)}</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:22px;color:#123d24">${esc(title)}</h1>
${body}
${button ? `<p style="margin:26px 0"><a href="${esc(link)}" style="display:inline-block;background:#1f8a4c;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px">${esc(button)}</a></p>
<p style="font-size:13px;color:#5d6b62;margin:0">Si el botón no funciona, copia este enlace en el navegador:<br><a href="${esc(link)}" style="color:#1f8a4c;word-break:break-all">${esc(link)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#f7faf7;border-top:1px solid #e5efe8;border-radius:0 0 14px 14px;font-size:12px;color:#7a877f">${footer || 'Has recibido este correo porque te has inscrito en la liga. Si no has sido tú, ignóralo.'}</td></tr>
</table></td></tr></table></body></html>`;
  return html;
}

const p = (t) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${t}</p>`;

export function activationEmail({ league, firstName, link, hours }) {
  return {
    subject: `Bienvenido a la ${league}: crea tu contraseña`,
    text: `Hola ${firstName}:\n\nHemos recibido tu inscripción en la ${league}. Para acceder a la plataforma (tu ficha, tus puntuaciones e inscripción a las próximas jornadas) crea tu contraseña aquí:\n\n${link}\n\nEl enlace caduca en ${hours} horas y solo puede usarse una vez.\n\n¡Nos vemos en el campo!`,
    html: layout({ league, title: `¡Hola, ${firstName}!`, button: 'Crear mi contraseña', link,
      body: p(`Hemos recibido tu inscripción en la <b>${esc(league)}</b>.`)
        + p('Crea tu contraseña para acceder a la plataforma: tu ficha de jugador, tus puntuaciones y la inscripción a las próximas jornadas.')
        + p(`<span style="color:#5d6b62;font-size:13px">El enlace caduca en ${hours} horas y solo puede usarse una vez.</span>`) }),
  };
}

export function resetEmail({ league, firstName, link, hours }) {
  return {
    subject: `${league}: restablece tu contraseña`,
    text: `Hola ${firstName}:\n\nPara crear una contraseña nueva entra en:\n\n${link}\n\nEl enlace caduca en ${hours} horas. Si no lo has pedido tú, ignora este correo: tu contraseña actual sigue siendo válida.`,
    html: layout({ league, title: 'Restablece tu contraseña', button: 'Crear contraseña nueva', link,
      body: p(`Hola ${esc(firstName)}, hemos recibido una solicitud para restablecer tu contraseña.`)
        + p(`<span style="color:#5d6b62;font-size:13px">El enlace caduca en ${hours} horas.</span>`),
      footer: 'Si no has pedido este cambio, ignora este correo: tu contraseña actual sigue siendo válida.' }),
  };
}

export function adminNewPlayerEmail({ league, player, link }) {
  const rows = [['Nombre', player.name], ['Email', player.email], ['Teléfono', player.phone], ['Licencia', player.licence],
    ['Hándicap', player.handicap], ['Talla', player.shirt_size], ['Instagram', player.instagram ? `@${player.instagram}` : '—'],
    ['Notificaciones', player.consent_notifications ? 'Sí' : 'No'], ['Uso de imagen', player.consent_image ? 'Sí' : 'No']];
  return {
    subject: `Nueva inscripción: ${player.name}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nPanel del comité: ${link}`,
    html: layout({ league, title: 'Nueva inscripción', button: 'Ver en el panel del comité', link,
      body: `<table style="font-size:14px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5d6b62">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>`,
      footer: 'Aviso automático para el comité de la liga.' }),
  };
}
