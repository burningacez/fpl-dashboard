import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';
import config from './config';

/**
 * Email alerts — port of the transporter setup in legacy/server.js:626-667.
 * Optional: without EMAIL_USER/EMAIL_PASS alerts are silently skipped.
 */

declare global {
  var __fplEmailTransporter: Transporter | null | undefined;
}

export function initEmailTransporter(): void {
  if (globalThis.__fplEmailTransporter !== undefined) return;
  const { EMAIL_USER, EMAIL_PASS } = config.email;
  if (EMAIL_USER && EMAIL_PASS) {
    globalThis.__fplEmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
      },
    });
    console.log('[Email] Transporter configured for:', EMAIL_USER);
  } else {
    globalThis.__fplEmailTransporter = null;
    console.log('[Email] No credentials configured - email alerts disabled');
    console.log('[Email] Set EMAIL_USER and EMAIL_PASS environment variables to enable');
  }
}

export async function sendEmailAlert(subject: string, message: string): Promise<void> {
  const transporter = globalThis.__fplEmailTransporter;
  if (!transporter) {
    console.log('[Email] Skipping alert - no transporter configured');
    return;
  }

  try {
    await transporter.sendMail({
      from: config.email.EMAIL_USER ?? undefined,
      to: config.email.ALERT_EMAIL,
      subject: `[FPL Dashboard] ${subject}`,
      text: message,
      html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2 style="color: #37003c;">${subject}</h2>
                <p>${message.replace(/\n/g, '<br>')}</p>
                <hr style="border: 1px solid #00ff87;">
                <p style="color: #666; font-size: 12px;">FPL Dashboard Alert - barryfpl.site</p>
            </div>`,
    });
    console.log('[Email] Alert sent:', subject);
  } catch (error) {
    console.error('[Email] Failed to send alert:', (error as Error).message);
  }
}
