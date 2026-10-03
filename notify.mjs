import { config } from './config.mjs';

// Fire a notification to the configured webhook. Defaults to ntfy's plain-text convention
// (message in the body, headline in the Title header). For Discord/Slack you'd POST JSON instead.
// No-ops silently when NOTIFY_WEBHOOK is unset, and never throws into the caller.
export async function notify(title, message) {
  if (!config.notifyWebhook) return;
  try {
    await fetch(config.notifyWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Title: title },
      body: message,
    });
  } catch (err) {
    console.warn(`notify failed: ${err.message}`);
  }
}
