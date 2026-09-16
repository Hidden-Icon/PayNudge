// Runs automatically once a day (see netlify.toml for the schedule).
// Never called from the browser — SUPABASE_SERVICE_KEY and RESEND_API_KEY
// are private server-side environment variables set in Netlify's dashboard.

const SUPABASE_URL = 'https://ecsnkjpaubpwxejxhyjn.supabase.co';

const TEMPLATES = {
  friendly: (clientName, desc, amount, dueDate) => ({
    subject: `Upcoming payment reminder${desc ? `: ${desc}` : ''}`,
    html: `<p>Hi ${clientName},</p>
      <p>Just a friendly heads-up that the invoice ${desc ? `for "${desc}" ` : ''}totaling $${amount} is due on ${dueDate}.</p>
      <p>No action needed if it's already scheduled — just didn't want it to slip by. Thanks!</p>`,
  }),
  firm: (clientName, desc, amount, dueDate) => ({
    subject: `Payment overdue${desc ? `: ${desc}` : ''}`,
    html: `<p>Hi ${clientName},</p>
      <p>The invoice ${desc ? `for "${desc}" ` : ''}totaling $${amount} was due on ${dueDate} and hasn't come through yet.</p>
      <p>Could you let me know the status, or send payment at your earliest convenience? Happy to answer any questions about it.</p>`,
  }),
  final: (clientName, desc, amount, dueDate) => ({
    subject: `Final notice — payment significantly overdue${desc ? `: ${desc}` : ''}`,
    html: `<p>Hi ${clientName},</p>
      <p>This is a final reminder that the invoice ${desc ? `for "${desc}" ` : ''}totaling $${amount}, originally due ${dueDate}, remains unpaid.</p>
      <p>Please reach out as soon as possible so we can resolve this. If there's an issue on your end, I'm glad to work with you on it.</p>`,
  }),
};

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.method === 'PATCH' ? 'return=minimal' : undefined,
      ...options.headers,
    },
  });
  if (options.method === 'PATCH') return null;
  return res.json();
}

async function sendEmail(to, subject, html) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'PayNudge <onboarding@resend.dev>', // swap for your verified domain later
      to,
      subject,
      html,
    }),
  });
}

exports.handler = async function () {
  const invoices = await supabaseFetch(
    'invoices?status=eq.unpaid&select=*,clients(name,email)'
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let sentCount = 0;

  for (const inv of invoices) {
    const due = new Date(inv.due_date);
    due.setHours(0, 0, 0, 0);
    const daysDiff = Math.round((due - today) / (1000 * 60 * 60 * 24)); // positive = future, negative = overdue

    let template = null;
    let nextStage = inv.reminder_stage;

    if (inv.reminder_stage === 0 && daysDiff <= 3 && daysDiff >= 0) {
      template = TEMPLATES.friendly;
      nextStage = 1;
    } else if (inv.reminder_stage === 1 && daysDiff <= -3) {
      template = TEMPLATES.firm;
      nextStage = 2;
    } else if (inv.reminder_stage === 2 && daysDiff <= -10) {
      template = TEMPLATES.final;
      nextStage = 3;
    }

    if (!template || !inv.clients?.email) continue;

    const { subject, html } = template(
      inv.clients.name,
      inv.description,
      Number(inv.amount).toFixed(2),
      inv.due_date
    );

    const emailRes = await sendEmail(inv.clients.email, subject, html);
    if (emailRes.ok) {
      await supabaseFetch(`invoices?id=eq.${inv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ reminder_stage: nextStage, last_reminder_sent_at: new Date().toISOString() }),
      });
      sentCount++;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ sent: sentCount }) };
};
