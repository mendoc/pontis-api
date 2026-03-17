import nodemailer from 'nodemailer'

export function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  const transport = createTransport()
  const from = process.env.SMTP_FROM ?? 'Pontis <no-reply@pontis.ongoua.pro>'

  await transport.sendMail({
    from,
    to,
    subject: 'Réinitialisation de votre mot de passe Pontis',
    text: `Votre code de réinitialisation est : ${code}\n\nCe code expire dans 15 minutes.\n\nSi vous n'avez pas demandé cette réinitialisation, ignorez cet email.`,
    html: `
      <p>Voici votre code de réinitialisation de mot de passe :</p>
      <h2 style="letter-spacing: 4px; font-family: monospace;">${code}</h2>
      <p>Ce code expire dans <strong>15 minutes</strong>.</p>
      <p style="color: #666; font-size: 12px;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
    `,
  })
}
