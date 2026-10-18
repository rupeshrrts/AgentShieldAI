"""Outgoing email (account invites).

With SMTP configured (SMTP_HOST, SMTP_FROM, ...), messages go through that server.
Without it, development servers write the message to the log so invites can be tested
locally; production refuses, because an invite link must only reach its recipient.
"""
import logging
import smtplib
from email.message import EmailMessage

from app.core.config import settings

logger = logging.getLogger("agentshield.email")


class EmailNotConfigured(RuntimeError):
    pass


def send_email(to: str, subject: str, body: str) -> str:
    """Sends a plain-text email. Returns "smtp" or "log" (development only)."""
    if not settings.email_configured:
        if settings.is_production:
            raise EmailNotConfigured("Email is not configured on this server (set SMTP_HOST and SMTP_FROM).")
        logger.warning("[DEV EMAIL - not sent, SMTP not configured]\nTo: %s\nSubject: %s\n\n%s", to, subject, body)
        print(f"\n[DEV EMAIL - not sent, SMTP not configured]\nTo: {to}\nSubject: {subject}\n\n{body}\n", flush=True)
        return "log"

    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
        if settings.SMTP_STARTTLS:
            smtp.starttls()
        if settings.SMTP_USER:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(msg)
    return "smtp"
