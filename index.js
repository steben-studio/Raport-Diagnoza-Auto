import 'dotenv/config';
import http from 'http';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fetch from 'node-fetch';
import { load } from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import SftpClient from 'ssh2-sftp-client'; // <— pentru upload pe Hostinger

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* -------------------- HTTP health -------------------- */
const PORT = Number(process.env.PORT || 10000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200); res.end('running');
}).listen(PORT, () => console.log('[http] health on', PORT));

const POLL_MS = Math.max(60, Number(process.env.POLL_SECONDS) || 120) * 1000;

/* -------------------- OpenAI -------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------- IMAP / SMTP -------------------- */
const IMAPHOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAPPORT = Number(process.env.IMAP_PORT || 993);
const IMAPSEC  = String(process.env.IMAP_SECURE ?? 'true').toLowerCase() !== 'false';

const SMTPHOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTPPORT = Number(process.env.SMTP_PORT || 465);
const SMTPSEC  = String(process.env.SMTP_SECURE ?? 'true').toLowerCase() !== 'false';

const MAILBOX  = process.env.MAILBOX || 'INBOX';
const MAIL_TO  = (process.env.MAIL_TO || process.env.SMTP_USER || '').trim();

/* -------------------- Template & Assets -------------------- */
const TEMPLATE_URL = process.env.TEMPLATE_URL || 'https://stebenstudio.com/Raport-Diagnoza-Auto.html';
const ASSETS_BASE  = (process.env.ASSETS_BASE_URL || 'https://stebenstudio.com').replace(/\/+$/,'');
const INLINE_CSS   = String(process.env.INLINE_CSS ?? 'true').toLowerCase() !== 'false';
const CSS_URL      = process.env.CSS_URL || `${ASSETS_BASE}/assets/css/style.css`;

/* -------------------- SFTP (Hostinger) -------------------- */
const SFTP = {
  host: process.env.SFTP_HOST,                 // ex: ftp.tudomeniu.ro
  port: Number(process.env.SFTP_PORT || 22),
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
  baseDir: (process.env.SFTP_BASEDIR || '/public_html/reports').replace(/\/+$/,''), // unde urcam .html
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://stebenstudio.com/reports').replace(/\/+$/,'')
};

/* -------------------- IMAP client (factory cu reconectare corecta) -------------------- */
let imap; // instanta curenta

function attachImapHandlers(client) {
  client.on('error', (err) => console.error('[imap] error:', err));
  client.on('close', () => {
    console.warn('[imap] closed. Reconnecting in 5s...');
    setTimeout(() => initImap().catch(e => console.error('[imap] reconnect failed:', e)), 5000);
  });
}

async function initImap() {
  // inchide politicos vechea instanta, daca exista
  try { if (imap) await imap.logout().catch(()=>{}); } catch {}
  imap = new ImapFlow({
    host: IMAPHOST,
    port: IMAPPORT,
    secure: IMAPSEC,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false
  });
  attachImapHandlers(imap);
  await imap.connect();
  await imap.mailboxOpen(MAILBOX);
  console.log('[imap] connected; polling each', POLL_MS/1000, 'sec');
}

/* -------------------- Main -------------------- */
async function main() {
  await initImap();
  await checkInbox();
  setInterval(checkInbox, POLL_MS);
}

/* -------------------- Inbox polling -------------------- */
async function checkInbox() {
  const lock = await imap.getMailboxLock(MAILBOX);
  try {
    for await (const msg of imap.fetch({ seen: false }, { uid: true, source: true })) {
      // marcheaza devreme ca vazut, ca sa nu re-procesezi daca procesul cade intre timp
      await imap.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);

      const mail = await simpleParser(msg.source);
      const from = (mail.from?.text||'').toLowerCase();
      const subj = (mail.subject||'').toLowerCase();

      // filtre: email/topdon sau subiect raport
      if (!from.includes('report-noreply@topdondiagnostics.com') &&
          !subj.includes('raport de diagnosticare') &&
          !/topdon/i.test(from)) {
        continue;
      }

      const body = (mail.html || mail.text || '');
      const link = extractTopdonLink(body);
      if (!link) {
        console.log('⏭️  email TOPDON fara link -> skip');
        continue;
      }

      console.log('↪️  raport URL:', link);
      const report = await fetchTopdonReport(link);
      if (!report) { console.log('⚠️ nu am putut prelua raportul'); continue; }

      const analysis = await analyzeWithGPT(report);
      const { htmlPublicUrl, filename } = await renderAndUpload(report, analysis); // <-- upload SFTP
      await emailReport(htmlPublicUrl, filename);
    }
  } catch (e) {
    console.error('Eroare la checkInbox:', e);
  } finally { lock.release(); }
}

function extractTopdonLink(htmlOrText) {
  const m = htmlOrText.match(/https?:\/\/[^\s"<>]*topdon[^\s"<>]*/i);
  return m ? m[0] : null;
}

/* -------------------- Fetch + PARSE raport -------------------- */
async function fetchTopdonReport(url) {
  const res = await fetch(url, {
    redirect:'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (DiagBot/1.0; +stebenstudio.com)' }
  });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = load(html);
  const text = $('body').text().replace(/\s+/g,' ').trim();

  const pick = (re) => (text.match(re)||[])[1] || null;
  const make    = pick(/Make:\s*([A-Za-z0-9\/\-\s]+)/i);
  const model   = pick(/Model:\s*([A-Za-z0-9\/\-\s]+)/i);
  const vin     = pick(/VIN:\s*([A-HJ-NPR-Z0-9]{17})/i);
  const mileage = pick(/Mileage:\s*([0-9.,]+\s*(?:km|mi))/i);

  const dtcs = [];

  // PASS 1 – tip "System  CODE  desc  Status"
  const reSys = /([A-Z]{2,}(?:\s*\([^)]+\))?)\s+([A-Z0-9]{3,5})\s+([^]+?)(?=\s(?:History|Current|Intermitent|Permanent)\b)/gi;
  let m;
  while ((m = reSys.exec(text)) !== null) {
    dtcs.push({
      modul: m[1].replace(/\s+/g, ' ').trim(),
      cod: m[2],
      descriere_bruta: m[3].replace(/\s+/g,' ').trim(),
      status: 'Nespecificat'
    });
  }

  // PASS 2 – coduri OBD generice P/B/C/U
  if (dtcs.length === 0) {
    const reObd = /\b([PBCU]\d{4})\b[:\-\s]*([A-Za-z0-9 ,.'()\/\-\+]+?)(?=\s(?:Status|Memor(?:y|ie)|Permanent|Intermitent|$))/gi;
    let n;
    while ((n = reObd.exec(text)) !== null) {
      dtcs.push({ modul: 'ECU', cod: n[1], descriere_bruta: (n[2]||'').trim(), status: 'Nespecificat' });
    }
  }

  // PASS 3 – fallback tabele din pagina
  if (dtcs.length === 0) {
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td,th').map((__, el) => $(el).text().trim()).get();
      if (tds.length >= 2) {
        const maybeCode = tds.find(x => /^[PBCU]\d{4}$/.test(x) || /^[0-9A-Z]{3,6}$/.test(x));
        if (maybeCode) {
          dtcs.push({
            modul: tds[0] || 'ECU',
            cod: maybeCode,
            descriere_bruta: (tds.slice(1).join(' ') || '').trim(),
            status: 'Nespecificat'
          });
        }
      }
    });
  }

  return { url, make, model, vin, mileage, dtcs };
}

/* -------------------- GPT analiza → JSON fara diacritice -------------------- */
async function analyzeWithGPT(report) {
  const sys = `Esti un mecanic auto senior. Raspunzi EXCLUSIV cu un SINGUR obiect JSON, fara diacritice.
NU adauga explicatii, markdown sau text in afara JSON.
Schema:
{
  "vehicul":{"brand":"...","model":"...","an":null|"....","motorizare":null|"....","kilometraj":"...","data_scanarii":"YYYY-MM-DD"},
  "pas_1_erori_initiale":[{"cod":"...","descriere":"...","cauza_posibila":"...","recomandare":"..."}],
  "concluzie":"...",
  "todo":[{"nr":"1","text":"..."}]
}
Reguli: 2-4 propozitii la fiecare camp text; concis si practic; fara diacritice; nu inventa date lipsa.`;

  const userPayload = {
    instr: "Analizeaza raportul TOPDON: pentru fiecare DTC da Descriere, Cauza posibila, Recomandare. La final Concluzie si lista 'Ce trebuie facut acum'.",
    meta: {
      vin: report.vin, brand: report.make, model: report.model,
      kilometraj: report.mileage, data_scanarii: new Date().toISOString().slice(0,10)
    },
    dtc_list: report.dtcs.map(d => ({ cod: d.cod, modul: d.modul, descriere_bruta: d.descriere_bruta }))
  };

  // 1) cerem explicit JSON mode (FARA 'temperature', modelul nu accepta alta valoare decat default)
  const req = {
    model: 'gpt-5',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(userPayload) }
    ],
    response_format: { type: 'json_object' }
  };

  // 2) retry + cleanup daca tot vine non-JSON (de ex. modele fara JSON mode)
  let raw;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await openai.chat.completions.create(req);
    raw = resp.choices?.[0]?.message?.content || '';
    try {
      const data = parseLLMJson(raw);
      // completam meta lipsa
      data.vehicul = data.vehicul || {};
      data.vehicul.brand = data.vehicul.brand || report.make || null;
      data.vehicul.model = data.vehicul.model || report.model || null;
      data.vehicul.kilometraj = data.vehicul.kilometraj || report.mileage || null;
      data.vehicul.data_scanarii = data.vehicul.data_scanarii || new Date().toISOString().slice(0,10);

      if (!data.pas_1_erori_initiale || data.pas_1_erori_initiale.length === 0) {
        data.concluzie = data.concluzie || 'Raportul TOPDON nu a furnizat DTC-uri detaliate. Recomand rescanare completa cu tensiune stabila si export complet cu freeze frame.';
        data.todo = data.todo?.length ? data.todo : [
          { nr: '1', text: 'Efectueaza un Auto-Scan complet pe toate modulele cu redresor conectat (12–14.5V).' },
          { nr: '2', text: 'Daca apar coduri, exporta raportul detaliat cu denumirea ECU, cod, descriere si freeze frame.' },
          { nr: '3', text: 'Daca nu apar coduri, verifica alimentarea OBD-II si liniile CAN/K-Line.' }
        ];
      }
      return data;
    } catch (e) {
      console.warn(`[llm] JSON parse fail (attempt ${attempt}) – len=${raw.length}`);
      // la al doilea esec, continuam la fallback
    }
  }

  // 3) Fallback garantat (nu blocam pipeline-ul)
  const minimal = {
    vehicul: {
      brand: report.make || null,
      model: report.model || null,
      an: null,
      motorizare: null,
      kilometraj: report.mileage || null,
      data_scanarii: new Date().toISOString().slice(0,10)
    },
    pas_1_erori_initiale: (report.dtcs || []).map(d => ({
      cod: d.cod || '',
      descriere: d.descriere_bruta || 'Descriere indisponibila',
      cauza_posibila: 'Verificare suplimentara necesara pe baza datelor de freeze frame si a testelor de rutina.',
      recomandare: 'Efectueaza diagnostic tinta pe modulul indicat; verifica alimentare, mase, conectori, senzori/actuatori si actualizari software.'
    })),
    concluzie: 'Raspunsul modelului nu a putut fi validat ca JSON. Am generat un raport minimal pe baza DTC-urilor brute.',
    todo: [
      { nr: '1', text: 'Rescaneaza si exporta raportul complet (cu freeze frame) pentru acuratete crescuta.' },
      { nr: '2', text: 'Ruleaza verificari electrice de baza (baterie, alternator, mase, conectori).' },
      { nr: '3', text: 'Efectueaza test drive si monitorizeaza parametrii relevanti; confirma simptomele.' }
    ]
  };
  return minimal;
}

/* Helper: curata si parseaza JSON "murdar" din LLM */
function parseLLMJson(raw) {
  if (typeof raw !== 'string') throw new Error('no content');
  // scoate code fences ```json ... ```
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  // inlocuieste ghilimele smart
  s = s.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // taie eventual text inainte/dupa primul { ... } mare
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) s = m[0];
  return JSON.parse(s);
}


/* -------------------- Template helpers -------------------- */
async function loadTemplate() {
  try {
    const r = await fetch(TEMPLATE_URL, { redirect: 'follow' });
    if (r.ok) return await r.text();
    console.warn('[tpl] TEMPLATE_URL fetch failed:', r.status);
  } catch (e) {
    console.warn('[tpl] TEMPLATE_URL error:', e.message);
  }
  // fallback local (din repo)
  const localTpl = path.join(__dirname, 'Raport-Diagnoza-Auto.html');
  return fs.readFile(localTpl, 'utf8');
}

function absolutizeAssets(html) {
  return html.replace(/(src|href)=["'](?:\.\/)?assets\//gi, `$1="${ASSETS_BASE}/assets/`);
}

async function inlineCss(html) {
  if (!INLINE_CSS) return html;
  try {
    const r = await fetch(CSS_URL, { redirect: 'follow' });
    if (!r.ok) return html;
    const css = await r.text();
    html = html.replace(
      /<link[^>]+href=["'][^"']*assets\/css\/style\.css["'][^>]*>/i,
      `<style>${css}</style>`
    );
  } catch (e) {
    console.warn('[css] inline failed:', e.message);
  }
  // JS oricum e ignorat in email – il scoatem
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  return html;
}

function fillLoop(html, token, rows, tbodyId) {
  const re = new RegExp(`(<tbody[^>]*id="${tbodyId}"[^>]*>)([\\s\\S]*?BEGIN:${token}[\\s\\S]*?END:${token}[\\s\\S]*?)(</tbody>)`);
  const m = html.match(re);
  if (!m) return html;
  const [, start, block, end] = m;
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

  return html.replace(re, `${start}${rendered}${end}`);
}

function safe(v){ return (v ?? '').toString(); }

/* -------------------- Render + UPLOAD -------------------- */
async function renderAndUpload(report, data) {
  let html = await loadTemplate();
  html = absolutizeAssets(html);

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

  // PAS 1
  html = fillLoop(html, 'ROW_TEMPLATE_PAS1', (data.pas_1_erori_initiale||[]).map((r,i,arr) => {
    let row = `{{cod}}|{{descriere}}|{{cauza_posibila}}|{{recomandare}}`;
    row = row.replace('{{cod}}', safe(r.cod))
             .replace('{{descriere}}', safe(r.descriere))
             .replace('{{cauza_posibila}}', safe(r.cauza_posibila))
             .replace('{{recomandare}}', safe(r.recomandare));
    if (i === arr.length - 1) row += '\n<!--__LASTROW__-->';
    return row;
  }), 'rows_pas1');

  // TODO
  html = fillLoop(html, 'ROW_TEMPLATE_TODO', (data.todo||[]).map(r => {
    return `{{nr}}|{{text}}`.replace('{{nr}}', safe(r.nr)).replace('{{text}}', safe(r.text));
  }), 'rows_todo');

  // curata separatorul de la ultima linie
  html = html.replace('<!--__LASTROW__-->\n<tr class="row-sep"><td colspan="4"></td></tr>', '');

  // versiune pentru email (CSS inline) – pastram pentru viitor, dar nu o folosim acum
  const htmlEmail = await inlineCss(html);

  // salvare local + upload SFTP
  const outDir = path.join(__dirname, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const random = Math.random().toString(36).slice(2, 10);
  const filename = `Raport_${safe(report.vin)||'FARA_VIN'}_${random}.html`;
  const outHtml = path.join(outDir, filename);
  await fs.writeFile(outHtml, html, 'utf8');

  const url = await uploadViaSftp(outHtml, filename); // public URL
  return { htmlPublicUrl: url, filename, htmlEmail };
}

async function uploadViaSftp(localPath, filename) {
  if (!SFTP.host || !SFTP.username || !SFTP.password || !SFTP.baseDir || !SFTP.publicBaseUrl) {
    console.warn('[sftp] configuratie incompleta – skip upload, folosesc fisier local');
    return `file://${localPath}`;
  }
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: SFTP.host, port: SFTP.port,
      username: SFTP.username, password: SFTP.password
    });
    // asigura director
    try { await sftp.mkdir(SFTP.baseDir, true); } catch {}
    const remotePath = `${SFTP.baseDir}/${filename}`;
    console.log(`[sftp] uploading ${filename} -> ${SFTP.baseDir}`);
    await sftp.fastPut(localPath, remotePath);
    const publicUrl = `${SFTP.publicBaseUrl}/${filename}`;
    console.log('[sftp] uploaded:', publicUrl);
    return publicUrl;
  } finally {
    sftp.end().catch(()=>{});
  }
}

/* -------------------- Email -------------------- */
async function emailReport(htmlPublicUrl, filename) {
  const t = nodemailer.createTransport({
    host: SMTPHOST,
    port: SMTPPORT,
    secure: SMTPSEC,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const htmlBody = `
    <p>Buna,</p>
    <p>Am generat raportul auto. Il poti deschide aici:</p>
    <p><a href="${htmlPublicUrl}" target="_blank">${htmlPublicUrl}</a></p>
    <p>Daca ai nevoie de PDF, il putem genera la cerere.</p>
  `;

  await t.sendMail({
    from: process.env.SMTP_USER,
    to: MAIL_TO || process.env.SMTP_USER,
    subject: 'Raport Diagnoza Auto – link HTML',
    text: `Raport disponibil la: ${htmlPublicUrl}`,
    html: htmlBody,
    attachments: [] // nu mai atasam fisierul, ai linkul public
  });
  console.log('✅ Email trimis catre:', MAIL_TO || process.env.SMTP_USER, '->', htmlPublicUrl);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
