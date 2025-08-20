import 'dotenv/config';
import http from 'http';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fetch from 'node-fetch';
import { load } from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- HTTP health endpoint pentru Render (obligatoriu la Web Service)
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200); res.end('running');
}).listen(PORT, () => console.log('HTTP health on', PORT));

const POLL_MS = Math.max(60, Number(process.env.POLL_SECONDS) || 120) * 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// fallback defaults (daca ENV nu e setat corect pe Render)
const IMAPHOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAPPORT = Number(process.env.IMAP_PORT || 993);
const IMAPSEC  = String(process.env.IMAP_SECURE ?? 'true').toLowerCase() !== 'false';

const SMTPHOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTPPORT = Number(process.env.SMTP_PORT || 465);
const SMTPSEC  = String(process.env.SMTP_SECURE ?? 'true').toLowerCase() !== 'false';

const MAILBOX  = process.env.MAILBOX || 'INBOX';

const imap = new ImapFlow({
  host: IMAPHOST,
  port: IMAPPORT,
  secure: IMAPSEC,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false
});

async function main() {
  await imap.connect();
  await imap.mailboxOpen(MAILBOX);
  console.log('IMAP conectat; polling la', POLL_MS/1000, 'sec');
  await checkInbox();
  setInterval(checkInbox, POLL_MS);
}

async function checkInbox() {
  const lock = await imap.getMailboxLock(MAILBOX);
  try {
    // ultimele necitite, doar de la TOPDON
    for await (const msg of imap.fetch({ seen: false }, { uid: true, source: true })) {
      const mail = await simpleParser(msg.source);
      const from = (mail.from?.text||'').toLowerCase();
      const subj = (mail.subject||'').toLowerCase();

      if (!from.includes('report-noreply@topdondiagnostics.com') &&
          !subj.includes('raport de diagnosticare')) {
        continue;
      }

      const body = (mail.html || mail.text || '');
      const link = extractTopdonLink(body);
      if (!link) {
        console.log('Email TOPDON fara link -> marchez seen');
        await imap.messageFlagsAdd({uid:msg.uid}, ['\\Seen']);
        continue;
      }

      console.log('↪️ Link raport:', link);
      const report = await fetchTopdonReport(link);
      if (!report) {
        console.log('Nu am putut prelua raportul');
        continue;
      }

      const analysis = await analyzeWithGPT(report);
      const outFiles = await renderReport(report, analysis);
      await emailReport(outFiles);

      await imap.messageFlagsAdd({uid:msg.uid}, ['\\Seen']);
    }
  } catch (e) {
    console.error('Eroare la checkInbox:', e);
  } finally { lock.release(); }
}

function extractTopdonLink(htmlOrText) {
  const m = htmlOrText.match(/https?:\/\/[^\s"<>]*topdon[^\s"<>]*/i);
  return m ? m[0] : null;
}

async function fetchTopdonReport(url) {
  const res = await fetch(url, { redirect:'follow' });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = load(html);

  // text brut din pagina
  const text = $('body').text().replace(/\s+/g,' ').trim();

  const get = (re) => (text.match(re)||[])[1] || null;
  const time    = get(/Time:\s*([0-9/:\-\s]+)/i);
  const sn      = get(/SN:\s*([A-Z0-9]+)/i);
  const make    = get(/Make:\s*([A-Za-z0-9]+)/i);
  const model   = get(/Model:\s*([A-Za-z0-9\/\-\s]+)/i);
  const vin     = get(/VIN:\s*([A-HJ-NPR-Z0-9]{17})/i);
  const mileage = get(/Mileage:\s*([0-9.,]+\s*km)/i);

  const dtcs = [];
  const blocks = text.split(/(?= [A-ZĂÂÎȘȚ]{3,}\s+[0-9A-F]{4,6}\s+)/g);
  for (const b of blocks) {
    const m1 = b.match(/([A-ZĂÂÎȘȚ]{3,})\s+([0-9A-F]{4,6})\s+([^]+?)(Memorie|Permanent|Intermitent|Fără\s*status)/i);
    if (!m1) continue;
    const modul = m1[1].normalize("NFC");
    const cod   = m1[2];
    const descr = m1[3].replace(/\s+/g,' ').replace(/\s*,\s*/g, ', ').trim();
    const status= m1[4];

    dtcs.push({ modul, cod, descriere_bruta: descr, status });
  }

  return { url, time, sn, make, model, vin, mileage, dtcs };
}

async function analyzeWithGPT(report) {
  const sys = `Esti un mecanic auto senior. Raspunzi EXCLUSIV in JSON strict, fara diacritice.
Campuri obligatorii: 
{
 "vehicul":{"brand": "...","model":"...","an": null|"....","motorizare": null|"....","kilometraj": "...","data_scanarii":"YYYY-MM-DD"},
 "pas_1_erori_initiale":[{"cod":"...","descriere":"...","cauza_posibila":"...","recomandare":"..."}],
 "concluzie":"...",
 "todo":[{"nr":"1","text":"..."}]
}
Reguli: 2-4 propozitii per camp de text; nu inventa date lipsa; pastreaza concis si practic; nu folosi diacritice.`;

  const user = {
    instr: "Analizeaza raportul TOPDON: pentru fiecare DTC da Descriere, Cauza posibila, Recomandare. La final Concluzie si lista 'Ce trebuie facut acum'.",
    meta: {
      vin: report.vin, brand: report.make, model: report.model,
      kilometraj: report.mileage, data_scanarii: new Date().toISOString().slice(0,10)
    },
    dtc_list: report.dtcs.map(d => ({ cod: d.cod, modul: d.modul, descriere_bruta: d.descr }))
  };

  const resp = await openai.chat.completions.create({
  model: "gpt-5",        // <- in loc de "gpt-4o"
  messages: [
    { role:"system", content: sys },
    { role:"user", content: JSON.stringify(user) }
  ],
});

  let data;
  try { data = JSON.parse(resp.choices[0].message.content); }
  catch { throw new Error("LLM a returnat non-JSON"); }

  data.vehicul = data.vehicul || {};
  data.vehicul.brand = data.vehicul.brand || report.make || null;
  data.vehicul.model = data.vehicul.model || report.model || null;
  data.vehicul.kilometraj = data.vehicul.kilometraj || report.mileage || null;
  if (!data.vehicul.data_scanarii) data.vehicul.data_scanarii = new Date().toISOString().slice(0,10);

  return data;
}

async function renderReport(report, data) {
  const tplPath = path.join(__dirname, 'templates', 'Raport-Diagnoza-Auto.html');
  let html = await fs.readFile(tplPath, 'utf8');

  // header
  html = html.replaceAll('{{vin}}', safe(report.vin))
             .replaceAll('{{vehicul.brand}}', safe(data.vehicul?.brand))
             .replaceAll('{{vehicul.model}}', safe(data.vehicul?.model))
             .replaceAll('{{vehicul.an}}', safe(data.vehicul?.an))
             .replaceAll('{{vehicul.motorizare}}', safe(data.vehicul?.motorizare))
             .replaceAll('{{vehicul.kilometraj}}', safe(data.vehicul?.kilometraj))
             .replaceAll('{{vehicul.data_scanarii}}', safe(data.vehicul?.data_scanarii));

  // concluzie
  html = html.replaceAll('{{concluzie}}', safe(data.concluzie));

  // PAS 1 loop
  html = fillLoop(html, 'ROW_TEMPLATE_PAS1', (data.pas_1_erori_initiale||[]).map((r,i,arr) => {
    let row = `{{cod}}|{{descriere}}|{{cauza_posibila}}|{{recomandare}}`;
    row = row.replace('{{cod}}', safe(r.cod))
             .replace('{{descriere}}', safe(r.descriere))
             .replace('{{cauza_posibila}}', safe(r.cauza_posibila))
             .replace('{{recomandare}}', safe(r.recomandare));
    if (i === arr.length - 1) row += '\n<!--__LASTROW__-->';
    return row;
  }), 'rows_pas1');

  // TODO loop
  html = fillLoop(html, 'ROW_TEMPLATE_TODO', (data.todo||[]).map(r => {
    return `{{nr}}|{{text}}`
      .replace('{{nr}}', safe(r.nr))
      .replace('{{text}}', safe(r.text));
  }), 'rows_todo');

  html = html.replace('<!--__LASTROW__-->\n<tr class="row-sep"><td colspan="4"></td></tr>', '');
  const outDir = path.join(__dirname, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const outHtml = path.join(outDir, `Raport_${safe(report.vin)||'FARA_VIN'}.html`);
  await fs.writeFile(outHtml, html, 'utf8');

  const browser = await puppeteer.launch({
    executablePath: puppeteer.executablePath(),  // folosește Chrome inclus în pachet
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.goto('file://' + outHtml, { waitUntil: 'networkidle0' });
  const outPdf = outHtml.replace(/\.html?$/i, '.pdf');
  await page.pdf({ path: outPdf, printBackground: true });
  await browser.close();

  return { outHtml, outPdf };
}

function fillLoop(html, token, rows, tbodyId) {
  const re = new RegExp(`(<tbody[^>]*id="${tbodyId}"[^>]*>)([\\s\\S]*?BEGIN:${token}[\\s\\S]*?END:${token}[\\s\\S]*?)(</tbody>)`);
  const m = html.match(re);
  if (!m) return html;
  const [full, start, block, end] = m;
  const inner = block.replace(/^[\\s\\S]*BEGIN:[^>]*-->([\\s\\S]*?)<!--\\s*END:[^>]*$/,'$1');
  const rendered = rows.map(val => {
    const parts = val.split('|');
    let row = inner;
    if (parts.length === 4) {
      row = row.replace('{{cod}}', parts[0])
               .replace('{{descriere}}', parts[1])
               .replace('{{cauza_posibila}}', parts[2])
               .replace('{{recomandare}}', parts[3]);
    } else {
      row = row.replace('{{nr}}', parts[0]).replace('{{text}}', parts[1]);
    }
    return row;
  }).join('\n');

  return html.replace(re, `$1${rendered}$3`);
}

function safe(v){ return (v ?? '').toString(); }

// TRIMITERE EMAIL
async function emailReport(files) {
  const t = nodemailer.createTransport({
    host: SMTPHOST,
    port: SMTPPORT,
    secure: SMTPSEC,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await t.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.SMTP_USER,
    subject: `Raport Diagnoza Auto`,
    text: `Gasesti atasat raportul generat.`,
    attachments: [
      { filename: path.basename(files.outPdf), path: files.outPdf },
      { filename: path.basename(files.outHtml), path: files.outHtml }
    ]
  });
  console.log('✅ Email trimis cu raportul:', files.outPdf);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
