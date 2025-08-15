import dotenv from 'dotenv';
import imaps from 'imap-simple';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import fs from 'fs';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import OpenAI from 'openai';

dotenv.config();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1️⃣ Conectare IMAP
async function checkEmails() {
  const config = {
    imap: {
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST,
      port: process.env.IMAP_PORT,
      tls: true,
      authTimeout: 3000
    }
  };

  const connection = await imaps.connect(config);
  await connection.openBox('INBOX');

  const searchCriteria = [['FROM', 'report-noreply@topdondiagnostics.com']];
  const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: true };
  const results = await connection.search(searchCriteria, fetchOptions);

  for (let res of results) {
    const body = res.parts.find(p => p.which === 'TEXT').body;
    const linkMatch = body.match(/https:\/\/[^\s"]+/);
    if (linkMatch) {
      console.log("🔗 Link raport:", linkMatch[0]);
      await processRaport(linkMatch[0]);
    }
  }
  connection.end();
}

// 2️⃣ Descărcare și parsare raport Topdon
async function processRaport(url) {
  const html = await (await fetch(url)).text();
  const $ = cheerio.load(html);

  // Extragere date (adaptăm la structura raportului real)
  let vin = $('body').text().match(/VIN:\s*([A-Z0-9]+)/)?.[1] || 'N/A';
  let coduri = [];
  $('selector-pentru-erori').each((i, el) => {
    coduri.push({
      cod: $(el).find('.cod').text().trim(),
      descriere: $(el).find('.descriere').text().trim()
    });
  });

  // 3️⃣ Prompt GPT
  const prompt = `
Analizează lista de coduri de eroare ca un mecanic expert.
Returnează în format JSON:
{
  "rows_pas1": [{ "cod": "...", "descriere": "...", "cauza_posibila": "...", "recomandare": "..." }],
  "concluzie": "...",
  "rows_todo": [{ "nr": 1, "text": "..." }]
}
Codurile:
${JSON.stringify(coduri, null, 2)}
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }]
  });

  const data = JSON.parse(completion.choices[0].message.content);
  await generateRaportHTML(vin, data);
}

// 4️⃣ Injectare date în template
async function generateRaportHTML(vin, data) {
  let template = fs.readFileSync('./templates/Raport-Diagnoza-Auto.html', 'utf8');

  template = template
    .replace('{{vin}}', vin)
    .replace('{{concluzie}}', data.concluzie);

  let rows1 = data.rows_pas1.map(row => `
    <tr class="row-pas1">
      <td>${row.cod}</td>
      <td>${row.descriere}</td>
      <td>${row.cauza_posibila}</td>
      <td>${row.recomandare}</td>
    </tr>
    <tr class="row-sep"><td colspan="4"></td></tr>
  `).join('');
  template = template.replace('<tbody id="rows_pas1">', `<tbody id="rows_pas1">${rows1}`);

  let todoRows = data.rows_todo.map(row => `
    <tr><td><b>${row.nr}</b> ${row.text}</td></tr>
  `).join('');
  template = template.replace('<tbody id="rows_todo">', `<tbody id="rows_todo">${todoRows}`);

  fs.writeFileSync('./raport-final.html', template);
  await sendEmailWithPDF(template);
}

// 5️⃣ Trimitere email cu PDF
async function sendEmailWithPDF(html) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ path: './assets/css/style.css' });
  const pdfBuffer = await page.pdf({ format: 'A4' });
  await browser.close();

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.SMTP_USER,
    subject: 'Raport Diagnoza Auto',
    text: 'Vezi atașat raportul generat.',
    attachments: [{ filename: 'Raport-Diagnoza.pdf', content: pdfBuffer }]
  });

  console.log('📨 Email trimis cu raportul!');
}

// 🚀 Rulează
checkEmails().catch(console.error);
