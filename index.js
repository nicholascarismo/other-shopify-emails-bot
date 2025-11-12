import 'dotenv/config';
import boltPkg from '@slack/bolt';
import { google as GoogleAPI } from 'googleapis';

const { App } = boltPkg;

/* =========================
   Slack Socket Mode App
========================= */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,     // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN,  // xapp-... (connections:write)
  socketMode: true,
  processBeforeResponse: true
});

/* =========================
   Env & Config
========================= */
const WATCH_CHANNEL = process.env.WATCH_CHANNEL_ID || process.env.FORWARD_CHANNEL_ID || '';

/* Gmail config (identical shape to your existing app) */
const SHOP_FROM_EMAIL     = (process.env.SHOP_FROM_EMAIL || 'shop@carismodesign.com').toLowerCase();
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI  = process.env.GMAIL_REDIRECT_URI;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

/* =========================
   Subject patterns to watch
   (optional "Fwd: " prefix; order # varies for order C# / Order #)
========================= */
const SUBJECT_PATTERNS = [
  // 1–5 (original)
  /^(?:Fwd:\s*)?Your order is confirmed - no further action needed!$/i,
  /^(?:Fwd:\s*)?Refund notification$/i,
  /^(?:Fwd:\s*)?A shipment from order C#\d{3,6} is out for delivery$/i,
  /^(?:Fwd:\s*)?A shipment from order C#\d{3,6} has been delivered$/i,
  /^(?:Fwd:\s*)?A shipment from order C#\d{3,6} is on the way$/i,

  // 6. "Order confirmed, no further action needed!"
  /^(?:Fwd:\s*)?Order confirmed, no further action needed!$/i,

  // 7. "URGENT - COULD NOT PROCESS PAYMENT"
  /^(?:Fwd:\s*)?URGENT - COULD NOT PROCESS PAYMENT$/i,

  // 8. "Welcome to the Carismo family!"
  /^(?:Fwd:\s*)?Welcome to the Carismo family!$/i,

  // 9. "Your Carismo order is ready for pickup"
  /^(?:Fwd:\s*)?Your Carismo order is ready for pickup$/i,

  // 10. "Your order has been picked up"
  /^(?:Fwd:\s*)?Your order has been picked up$/i,

  // 11. "Carismo $10 store credit" (any $ amount)
  /^(?:Fwd:\s*)?Carismo \$\d+(?:\.\d{2})? store credit$/i,

  // 12. "Order #9999 has been canceled" (any order number)
  /^(?:Fwd:\s*)?Order #\d{3,6} has been canceled$/i
];

/* =========================
   Basic utils
========================= */
function normalizeSubjForSearch(s) {
  let out = String(s || '').trim();
  // Strip any number of leading "Re:" or "Fwd:" prefixes (in any order)
  // e.g., "Fwd: Re: Fwd: Subject" -> "Subject"
  while (/^(?:re:|fwd?:)\s*/i.test(out)) {
    out = out.replace(/^(?:re:|fwd?:)\s*/i, '');
  }
  return out.trim();
}

// Prefer Slack “Email” file’s subject when present
function extractSubjectFromSlackEmail(event) {
  if (Array.isArray(event.files)) {
    for (const f of event.files) {
      if (f && f.mode === 'email') {
        if (f.subject) return String(f.subject).trim();
        if (f.headers?.subject) return String(f.headers.subject).trim();
      }
    }
  }
  const titles = (event.attachments || []).map(a => a.title).filter(Boolean);
  if (titles.length) return titles[0].trim();
  if (event.text) {
    const first = String(event.text).split('\n')[0].trim();
    if (/^subject:/i.test(first)) return first.replace(/^[Ss]ubject:\s*/, '').trim();
    return first;
  }
  return '';
}

/* =========================
   Gmail helpers (same primitives as your app)
========================= */
const b64urlEncode = (str) =>
  Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

function mkOAuthClient() {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    throw new Error('Missing Gmail OAuth env: GMAIL_CLIENT_ID/SECRET/REDIRECT_URI');
  }
  return new GoogleAPI.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI);
}

async function getGmail() {
  if (!GMAIL_REFRESH_TOKEN) throw new Error('GMAIL_REFRESH_TOKEN not set');
  const auth = mkOAuthClient();
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return GoogleAPI.gmail({ version: 'v1', auth });
}

function parseAddressList(headerVal) {
  return String(headerVal || '')
    .split(',')
    .map(s => s.trim())
    .map(s => {
      const m = s.match(/<([^>]+)>/);
      if (m) return m[1].toLowerCase();
      const t = s.replace(/^["']|["']$/g, '');
      return /^[^@\s]+@[^@\s]+$/.test(t) ? t.toLowerCase() : '';
    })
    .filter(Boolean);
}

function textToSafeHtml(s) {
  const esc = String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map(line => line.trim() ? `<p>${line}</p>` : '<p><br></p>').join('');
}

function quoteOriginalHtml({ date, from, html }) {
  const header = `<div>On ${date}, ${from} wrote:</div>`;
  const quoted = `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${html || '[original message not available]'}</blockquote>`;
  return `${header}${quoted}`;
}

/** Find likely customer thread using the subject (strip Re:/Fwd:) and “to: our mailbox” */
async function gmailFindThreadBySubject(subjectGuess) {
  const gmail = await getGmail();
  const our = SHOP_FROM_EMAIL.toLowerCase();
  const norm = normalizeSubjForSearch(subjectGuess);

  const base = `to:${our} newer_than:60d -from:${our}`;
  const queries = [
    `${base} subject:"${norm.replace(/"/g, '\\"')}"`
  ];

  for (const q of queries) {
    const tl = await gmail.users.threads.list({ userId: 'me', q, maxResults: 10 });
    const threads = tl.data.threads || [];
    for (const t of threads) {
      // quick fetch; accept first match (you mimic the existing app’s “best effort”)
      return { threadId: t.id };
    }
  }
  return null;
}

async function gmailGetThreadFull(threadId) {
  const gmail = await getGmail();
  const thr = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full'
  });
  return thr.data.messages || [];
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((2 - str.length * 3) & 3), 'base64').toString('utf8');
}

function extractRichMessage(msg) {
  const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const subject = headers['subject'] || '';
  const from = headers['from'] || '';
  const to = headers['to'] || '';
  const date = headers['date'] || '';
  const msgId = headers['message-id'] || '';

  function walkParts(p) {
    if (!p) return { html: null, text: null };
    if (p.mimeType?.startsWith('multipart/')) {
      let html = null, text = null;
      for (const part of p.parts || []) {
        const r = walkParts(part);
        html = html || r.html;
        text = text || r.text;
      }
      return { html, text };
    } else {
      const data = p.body?.data ? b64urlDecode(p.body.data) : null;
      if (!data) return { html: null, text: null };
      if (p.mimeType === 'text/html') return { html: data, text: null };
      if (p.mimeType === 'text/plain') return { html: null, text: data };
      return { html: null, text: null };
    }
  }

  const best = walkParts(msg.payload);
  const plainFromHtml = best.html
    ? best.html.replace(/<\/p>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
    : null;

  return {
    threadId: msg.threadId,
    id: msg.id,
    subject,
    from,
    to,
    date,
    bodyHtml: best.html,
    bodyText: best.text || plainFromHtml || '',
    refs: { inReplyTo: msgId, references: msgId }
  };
}

async function gmailGetLatestInboundInThread(threadId) {
  const messages = await gmailGetThreadFull(threadId);
  const our = SHOP_FROM_EMAIL.toLowerCase();

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const headers = Object.fromEntries((m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const from = (headers['from'] || '').toLowerCase();
    const fromIsUs = from.includes(`<${our}>`) || from.includes(our) || from.startsWith(our);
    if (!fromIsUs) return extractRichMessage(m);
  }
  return extractRichMessage(messages[messages.length - 1]);
}

/** Attachments from a Gmail message (return [{filename, mime, b64}]) */
async function collectAttachmentsFromMessage(msg) {
  const gmail = await getGmail();
  const out = [];

  function walk(parts = []) {
    for (const p of parts) {
      if (p.parts && p.parts.length) walk(p.parts);
      const filename = p.filename || '';
      const attId = p.body?.attachmentId;
      const mime = p.mimeType || 'application/octet-stream';
      if (filename && attId) out.push({ attachmentId: attId, filename, mime });
    }
  }
  walk(msg.payload?.parts || []);

  const files = [];
  for (const meta of out) {
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: msg.id,
      id: meta.attachmentId
    });
    const dataUrl = res.data.data || '';
    const dataStd = dataUrl.replace(/-/g, '+').replace(/_/g, '/'); // b64url → b64
    files.push({ filename: meta.filename, mime: meta.mime, b64: dataStd });
  }
  return files;
}

/** multipart/alternative (HTML preserve for replies) */
function buildRawEmailAlt({ from, to, subject, textBody, htmlBody, inReplyTo, references }) {
  const boundary = 'b_' + Math.random().toString(36).slice(2);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    textBody || '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody || '',
    `--${boundary}--`,
    ''
  ];

  return b64urlEncode(headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n'));
}

/** multipart/mixed for forward with original attachments preserved */
function buildRawEmailMixed({ from, to, subject, textBody, htmlBody, attachments = [] }) {
  const mixed = 'mix_' + Math.random().toString(36).slice(2);
  const alt = 'alt_' + Math.random().toString(36).slice(2);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`
  ];

  const parts = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    textBody || '',
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody || '',
    `--${alt}--`,
    ''
  ];

  for (const att of attachments) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${att.mime}; name="${att.filename.replace(/"/g, '')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename.replace(/"/g, '')}"`,
      '',
      att.b64,
      ''
    );
  }
  parts.push(`--${mixed}--`, '');

  return b64urlEncode(headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n'));
}

/** Send reply (preserve HTML quote) */
async function gmailSendReplyHTML({ threadId, replyToAddress, subjectBase, latest, replyBody }) {
  const subj = subjectBase.startsWith('Re:') ? subjectBase : `Re: ${subjectBase}`;

  const htmlReply = [
    textToSafeHtml(replyBody),
    '<br>',
    quoteOriginalHtml({ date: latest.date, from: latest.from, html: latest.bodyHtml || (latest.bodyText && textToSafeHtml(latest.bodyText)) })
  ].join('\n');

  const textReply = `${replyBody}\n\nOn ${latest.date}, ${latest.from} wrote:\n` +
    (latest.bodyText ? latest.bodyText.split('\n').map(l => `> ${l}`).join('\n') : '> [original message not available]');

  const raw = buildRawEmailAlt({
    from: SHOP_FROM_EMAIL,
    to: replyToAddress,
    subject: subj,
    textBody: textReply,
    htmlBody: htmlReply,
    inReplyTo: latest.refs.inReplyTo,
    references: latest.refs.references
  });

  const gmail = await getGmail();
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
}

/** Forward inline (preserve HTML + original attachments) */
async function gmailForwardInline({ subject, toList, latest }) {
  const gmail = await getGmail();
  const subj = subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`;

  const attachments = await collectAttachmentsFromMessage(latest._raw || latest);

  const headerBlockHtml = [
    '<div>---------- Forwarded message ----------</div>',
    `<div>From: ${latest.from}</div>`,
    `<div>Date: ${latest.date}</div>`,
    `<div>Subject: ${latest.subject}</div>`,
    `<div>To: ${latest.to}</div>`,
    '<br/>'
  ].join('\n');

  const htmlBody =
    headerBlockHtml +
    (latest.bodyHtml || (latest.bodyText && textToSafeHtml(latest.bodyText)) || '<div>[original message not available]</div>');

  const textBody =
    '---------- Forwarded message ----------\n' +
    `From: ${latest.from}\n` +
    `Date: ${latest.date}\n` +
    `Subject: ${latest.subject}\n` +
    `To: ${latest.to}\n\n` +
    (latest.bodyText || '[original message not available]');

  const raw = buildRawEmailMixed({
    from: SHOP_FROM_EMAIL,
    to: toList.join(', '),
    subject: subj,
    textBody,
    htmlBody,
    attachments
  });

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

/* =========================
   Minimal Slack helpers
========================= */
async function resolveEmailMetaFromSlack({ client, channel, root_ts }) {
  const hist = await client.conversations.replies({
    channel,
    ts: root_ts,
    inclusive: true,
    limit: 1
  });

  const root = (hist.messages || []).find(m => m.ts === root_ts) || (hist.messages || [])[0] || null;
  if (!root) return { subject: '', fromAddress: '' };

  const files = Array.isArray(root.files) ? root.files : [];
  const emailFile = files.find(f => f.mode === 'email') || null;
  if (!emailFile) return { subject: '', fromAddress: '' };

  let subject = emailFile.subject || emailFile.headers?.subject || '';
  let fromAddress =
    (emailFile.from && emailFile.from[0]?.address) ||
    (emailFile.headers?.from && (emailFile.headers.from.match(/<([^>]+)>/)?.[1] || emailFile.headers.from)) ||
    '';

  if (!subject || !fromAddress) {
    const info = await client.files.info({ file: emailFile.id });
    const f = info.file || {};
    subject = subject || f.subject || f.headers?.subject || '';
    fromAddress =
      fromAddress ||
      (f.from && f.from[0]?.address) ||
      (f.headers?.from && (f.headers.from.match(/<([^>]+)>/)?.[1] || f.headers.from)) ||
      '';
  }

  return { subject: String(subject || '').trim(), fromAddress: String(fromAddress || '').trim().toLowerCase() };
}

/* =========================
   UI blocks: Reply / Forward
========================= */
function actionBlocks({ subjectGuess }) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `Matched email subject:\n• _${subjectGuess || '(unknown subject)'}_` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Reply' }, action_id: 'reply_email', style: 'primary', value: JSON.stringify({ subjectGuess }) },
        { type: 'button', text: { type: 'plain_text', text: 'Forward' }, action_id: 'forward_email', value: JSON.stringify({ subjectGuess }) }
      ]
    }
  ];
}

/* =========================
   Event: watch messages in WATCH_CHANNEL for matching subjects
   - More tolerant: allow file_share, bot_message, message_changed
   - If message_changed, normalize to the inner event.message payload
========================= */
app.event('message', async ({ event, client, logger }) => {
  try {
    // Debug line to see what Slack is actually sending
    logger?.info?.({
      gotMessage: true,
      channel: event.channel,
      subtype: event.subtype || '',
      hasFiles: Array.isArray(event.files),
      hasAttachments: Array.isArray(event.attachments),
      hasBlocks: Array.isArray(event.blocks),
      hasText: !!event.text,
      ts: event.ts
    });

    if (!WATCH_CHANNEL) return;
    if (event.channel !== WATCH_CHANNEL) return;

    // Normalize: if Slack sends a "message_changed" wrapper, use the inner message
    const subtype = event.subtype || '';
    const base = (subtype === 'message_changed' && event.message) ? event.message : event;

    // Allow common subtypes for Email-to-Slack posts; ignore others
    if (subtype && !['file_share', 'bot_message', 'message_changed'].includes(subtype)) {
      return;
    }

    // Extract subject from the normalized payload
    const subj = extractSubjectFromSlackEmail(base);
    if (!subj) {
      logger?.info?.({ skipNoSubject: true });
      return;
    }

    // Normalize away any leading Re:/Fwd: prefixes before regex matching
    const normSubj = normalizeSubjForSearch(subj);

    const matched = SUBJECT_PATTERNS.some(re => re.test(normSubj));
    if (!matched) {
      logger?.info?.({ skipNoMatch: true, subj, normSubj });
      return;
    }

    // Post Reply/Forward controls into the thread (root ts of the visible message)
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: base.ts || event.ts,
      text: 'Email actions',
      blocks: actionBlocks({ subjectGuess: subj })
    });
  } catch (e) {
    logger?.error?.('message handler error', e);
  }
});

/* =========================
   Actions: Reply
========================= */
app.action('reply_email', async ({ ack, body, client, logger }) => {
  await ack();
  const channel = body.channel?.id;
  const thread_ts = body.message?.thread_ts || body.message?.ts;

  let subjectGuess = '';
  try {
    subjectGuess = JSON.parse(body.actions?.[0]?.value || '{}').subjectGuess || '';
  } catch {}

  // Try to resolve latest inbound message + recipient before showing the body box
  let resolvedTo = '';
  let resolvedSubject = '';
  let latest = null;

  try {
    // Prefer the Slack email file to infer subject/from (mimics your existing flow)
    const meta = await resolveEmailMetaFromSlack({ client, channel, root_ts: thread_ts });
    const subj = meta.subject || subjectGuess;
    subjectGuess = subj || subjectGuess;

    const found = await gmailFindThreadBySubject(subjectGuess);
    if (found) {
      latest = await gmailGetLatestInboundInThread(found.threadId);
      // pick Reply-To or From (non-us)
      const headers = Object.fromEntries((latest?._raw?.payload?.headers || latest?.payload?.headers || []).map?.(h => [h.name.toLowerCase(), h.value]) || []);
      const replyToList = parseAddressList(headers?.['reply-to'] || '');
      const fromList = parseAddressList(headers?.['from'] || latest?.from || '');
      const our = SHOP_FROM_EMAIL.toLowerCase();
      resolvedTo = replyToList.find(a => a !== our) || fromList.find(a => a !== our) || '';
      resolvedSubject = latest?.subject || subjectGuess || '';
      if (resolvedSubject && !/^re:/i.test(resolvedSubject)) resolvedSubject = `Re: ${resolvedSubject}`;
    }
  } catch (e) {
    logger?.error?.('prefetch reply context failed', e);
  }

  if (!resolvedTo || !resolvedSubject || !latest) {
    await client.chat.postMessage({
      channel, thread_ts,
      text: `❌ Cannot determine customer email/subject/thread for reply. Please reply from Gmail.`
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'reply_body_modal',
      title: { type: 'plain_text', text: 'Reply to Customer' },
      submit: { type: 'plain_text', text: 'Review' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*To:* ${resolvedTo}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Subject:* ${resolvedSubject}` } },
        {
          type: 'input',
          block_id: 'body_block',
          label: { type: 'plain_text', text: 'Message to customer' },
          element: {
            type: 'plain_text_input',
            action_id: 'body',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Type your reply…' }
          }
        }
      ],
      private_metadata: JSON.stringify({ channel, thread_ts, resolvedTo, resolvedSubject, subjectGuess, threadId: latest.threadId })
    }
  });
});

/* Reply: body -> send */
app.view('reply_body_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  const md = JSON.parse(view.private_metadata || '{}');
  const { channel, thread_ts, resolvedTo, resolvedSubject, subjectGuess, threadId } = md;
  const replyBody = view.state.values?.body_block?.body?.value?.trim();

  if (!replyBody) {
    await client.chat.postMessage({ channel, thread_ts, text: '❌ Please enter a message.' });
    return;
  }

  try {
    const latest = await gmailGetLatestInboundInThread(threadId);
    await gmailSendReplyHTML({
      threadId,
      replyToAddress: resolvedTo,
      subjectBase: resolvedSubject || subjectGuess || '',
      latest,
      replyBody
    });

    await client.chat.postMessage({
      channel, thread_ts,
      text: `✉️ Replied to customer (${resolvedTo}) from *${SHOP_FROM_EMAIL}*.\n_Subject:_ ${resolvedSubject}`
    });
  } catch (e) {
    logger?.error?.('reply send failed', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Reply failed: ${e.message}` });
  }
});

/* =========================
   Actions: Forward
========================= */
const FORWARD_CHOICES = [
  'kenny@carismodesign.com',
  'kevinl@carismodesign.com',
  'irish@carismodesign.com',
  'k@carismodesign.com',
  'shop@carismodesign.com',
  'nicholas@carismodesign.com'
];

app.action('forward_email', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id;
  const thread_ts = body.message?.thread_ts || body.message?.ts;

  let subjectGuess = '';
  try {
    subjectGuess = JSON.parse(body.actions?.[0]?.value || '{}').subjectGuess || '';
  } catch {}

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'forward_pick_modal',
      title: { type: 'plain_text', text: 'Forward to Team' },
      submit: { type: 'plain_text', text: 'Review' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'to_block',
          label: { type: 'plain_text', text: 'Select recipients' },
          element: {
            type: 'multi_static_select',
            action_id: 'to',
            options: FORWARD_CHOICES.map(e => ({ text: { type: 'plain_text', text: e }, value: e })),
            placeholder: { type: 'plain_text', text: 'Pick one or more' }
          }
        }
      ],
      private_metadata: JSON.stringify({ channel, thread_ts, subjectGuess })
    }
  });
});

app.view('forward_pick_modal', async ({ ack, body, view, client }) => {
  const md = JSON.parse(view.private_metadata || '{}');
  const tos = (view.state.values?.to_block?.to?.selected_options || []).map(o => o.value);

  if (!tos.length) {
    await ack({ response_action: 'errors', errors: { to_block: 'Pick at least one recipient' } });
    return;
  }

  await ack({
    response_action: 'update',
    view: {
      type: 'modal',
      callback_id: 'forward_review_modal',
      title: { type: 'plain_text', text: 'Review Forward' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Back' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Recipients:* ' + tos.join(', ') } }
      ],
      private_metadata: JSON.stringify({ ...md, tos })
    }
  });
});

app.view('forward_review_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  const md = JSON.parse(view.private_metadata || '{}');
  const { channel, thread_ts, subjectGuess, tos } = md;

  try {
    // locate thread by subject from Slack email file (same approach used in Reply)
    const found = await gmailFindThreadBySubject(subjectGuess);
    if (!found) throw new Error('Could not locate Gmail thread for forward.');
    const latest = await gmailGetLatestInboundInThread(found.threadId);

    await gmailForwardInline({
      subject: subjectGuess || latest.subject || '',
      toList: tos,
      latest
    });

    await client.chat.postMessage({
      channel, thread_ts,
      text: `📤 Forwarded from *${SHOP_FROM_EMAIL}* to: ${tos.join(', ')}`
    });
  } catch (e) {
    logger?.error?.('forward send failed', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Forward failed: ${e.message}` });
  }
});

/* =========================
   Start
========================= */
(async () => {
  await app.start(); // Socket Mode: no HTTP port
  console.log('✅ <APP_NAME> running (Socket Mode)');
  console.log('🔧 Watching channel ID:', WATCH_CHANNEL || '(not set)');
})();