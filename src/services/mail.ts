import nodemailer, { type Transporter } from "nodemailer";
import { env, appWebUrl } from "../env.js";

/**
 * Outbound email. Two transports:
 *  - "smtp"    — real delivery, used when SMTP_URL is set.
 *  - "console" — default; logs a boxed message to the server log so the
 *                verification / reset / OTP links are usable end-to-end in dev
 *                without any mail infrastructure.
 */

let transport: Transporter | null = null;
const mode: "smtp" | "console" = env.SMTP_URL ? "smtp" : "console";

if (mode === "smtp") transport = nodemailer.createTransport(env.SMTP_URL!);

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail({ to, subject, text, html }: MailInput): Promise<void> {
  if (mode === "smtp" && transport) {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    return;
  }
  const line = "─".repeat(64);
  console.log(
    `\n${line}\n📧  MAIL (console transport — not delivered)\n   to:      ${to}\n   subject: ${subject}\n${line}\n${text}\n${line}\n`,
  );
}

// ── templated helpers ──────────────────────────────────────────────────────

const link = (path: string, token: string) => `${appWebUrl}${path}?token=${encodeURIComponent(token)}`;

export const sendVerificationEmail = (to: string, token: string) =>
  sendMail({
    to,
    subject: "Verify your Forma email",
    text:
      `Welcome to Forma.\n\nConfirm this email address to finish setting up your account:\n` +
      `${link("/verify-email", token)}\n\nThis link expires in 24 hours. If you didn't create a Forma account, ignore this message.`,
  });

export const sendPasswordResetEmail = (to: string, token: string) =>
  sendMail({
    to,
    subject: "Reset your Forma password",
    text:
      `Someone (hopefully you) asked to reset the password for your Forma account.\n\n` +
      `${link("/reset-password", token)}\n\nThis link expires in 1 hour. If it wasn't you, no action is needed — your password is unchanged.`,
  });

export const sendEmailChangeEmail = (to: string, token: string) =>
  sendMail({
    to,
    subject: "Confirm your new Forma email",
    text:
      `Confirm that you want to use this address for your Forma account:\n\n` +
      `${link("/settings/security", token)}\n\nThis link expires in 1 hour.`,
  });

export const sendSecurityAlert = (to: string, what: string) =>
  sendMail({
    to,
    subject: "Forma security alert",
    text:
      `This is a notification that the following change was made to your Forma account:\n\n  ${what}\n\n` +
      `If this was you, no action is needed. If not, reset your password immediately and review your active sessions in Account & Security.`,
  });

export { mode as mailTransportMode };
