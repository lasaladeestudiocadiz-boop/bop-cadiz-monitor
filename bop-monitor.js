// bop-monitor.js — Revisa a diario el BOP de Cádiz y envía por correo los anuncios
// relacionados con procesos selectivos (bases, convocatorias, listas, tribunales, bolsas, OEP).
// Requisitos: Node 20+ (fetch nativo) y nodemailer.
// Variables de entorno: SMTP_USER, SMTP_PASS (contraseña de aplicación de Gmail), MAIL_TO
// Opcional: SEND_EMPTY=1 para recibir correo también los días sin anuncios.

import fs from 'node:fs';
import nodemailer from 'nodemailer';

const BASE = 'https://www.bopcadiz.es';
const STATE_FILE = new URL('./state.json', import.meta.url);
const MAX_CATCHUP = 6; // máximo de boletines atrasados a procesar en una ejecución
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (aviso personal diario de procesos selectivos)',
  'Accept-Language': 'es-ES,es;q=0.9',
};

// ---------- utilidades ----------
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&([a-z]+)acute;/gi, (_, l) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' }[l] ?? l))
  .replace(/&ntilde;/g, 'ñ').replace(/&Ntilde;/g, 'Ñ');

const htmlToLines = (html) => decode(
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.text();
      console.warn(`HTTP ${r.status} en ${url}`);
    } catch (e) { console.warn(`Error en ${url}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
  }
  throw new Error(`No se pudo descargar ${url}`);
}

// ---------- 1. localizar boletines publicados ----------
async function listarBoletines() {
  const html = await get(`${BASE}/`);
  const re = /\/boletin\/Boletin-numero-(\d{1,3})-del-ano-(\d{4})\/?/gi;
  const vistos = new Map();
  for (const m of html.matchAll(re)) {
    const num = +m[1], ano = +m[2];
    vistos.set(`${ano}-${num}`, { num, ano, url: `${BASE}/boletin/Boletin-numero-${String(num).padStart(3, '0')}-del-ano-${ano}/` });
  }
  return [...vistos.values()].sort((a, b) => a.ano - b.ano || a.num - b.num);
}

// ---------- 2. extraer anuncios de un boletín ----------
const SECCIONES = ['ADMINISTRACION DEL ESTADO', 'JUNTA DE ANDALUCIA', 'DIPUTACION PROVINCIAL DE CADIZ',
  'ADMINISTRACION LOCAL', 'ADMINISTRACION DE JUSTICIA', 'VARIOS'];

function extraerAnuncios(html) {
  const lines = htmlToLines(html);
  const anuncios = [];
  let seccion = '';
  for (const l of lines) {
    const up = norm(l).toUpperCase();
    const sec = SECCIONES.find((s) => up === s || up.startsWith(s));
    if (sec && l.length < 60) { seccion = sec; continue; }
    // Formato: "66.143.- Ayuntamiento de Bornos. Bases para la cobertura de..."
    const m = l.match(/^(\d{1,3}(?:\.\d{3})+)\s*\.-\s*(.+)$/);
    if (m) {
      const resto = m[2];
      const corte = resto.search(/\.\s+(?=[A-ZÁÉÍÓÚÑ])/);
      const organo = corte > 0 ? resto.slice(0, corte) : '';
      const titulo = corte > 0 ? resto.slice(corte + 1).trim() : resto;
      anuncios.push({ n: m[1], seccion, organo, titulo });
    }
  }
  // PDF del boletín completo (si está enlazado en la página)
  const pdf = html.match(/href="([^"]*\.boletines_pdf[^"]*\/BOP[^"]*\.pdf)"/i)?.[1];
  return { anuncios, pdf: pdf ? new URL(pdf, BASE).href : null };
}

// ---------- 3. filtro de procesos selectivos ----------
const FUERTES = [
  'proceso selectivo', 'procesos selectivos', 'oposicion', 'concurso-oposicion', 'concurso oposicion',
  'bolsa de empleo', 'bolsa de trabajo', 'bolsa de trabajadores', 'oferta de empleo publico', 'oep ',
  'admitidos', 'excluidos', 'tribunal calificador', 'organo de seleccion', 'personal funcionario',
  'funcionario de carrera', 'funcionarios de carrera', 'funcionario interino', 'personal laboral',
  'estabilizacion', 'policia local', 'aspirantes', 'nombramiento', 'toma de posesion', 'libre designacion',
  'provision de puestos', 'concurso de meritos', 'promocion interna', 'cobertura de plaza', 'cobertura de',
];
const DEBILES = ['bases', 'convocatoria']; // solo cuentan si van con "plaza", "puesto" o "seleccion"
const CONTEXTO = ['plaza', 'puesto', 'seleccion', 'empleo', 'interin'];
const DESCARTE = ['subvencion', 'licitacion', 'contrato de', 'premios', 'ayudas'];

function clasificar(t) {
  const s = norm(t);
  if (/admitid|excluid/.test(s)) return 'Listas de admitidos/excluidos';
  if (/tribunal|organo de seleccion/.test(s)) return 'Tribunales';
  if (/bolsa/.test(s)) return 'Bolsas de empleo';
  if (/bases|convocatoria/.test(s)) return 'Bases y convocatorias';
  if (/oferta de empleo publico|\boep\b/.test(s)) return 'Ofertas de empleo público';
  if (/nombramiento|toma de posesion|cese/.test(s)) return 'Nombramientos';
  return 'Otros (personal)';
}

function esSeleccion(a) {
  const s = norm(`${a.organo} ${a.titulo}`) + ' ';
  const fuerte = FUERTES.some((k) => s.includes(k));
  const debil = DEBILES.some((k) => s.includes(k)) && CONTEXTO.some((k) => s.includes(k));
  if (!fuerte && !debil) return false;
  if (DESCARTE.some((k) => s.includes(k)) && !fuerte) return false;
  return true;
}

// ---------- 4. correo ----------
const ORDEN = ['Bases y convocatorias', 'Ofertas de empleo público', 'Bolsas de empleo',
  'Listas de admitidos/excluidos', 'Tribunales', 'Nombramientos', 'Otros (personal)'];
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function construirCorreo(resultados) {
  let total = 0;
  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">';
  for (const r of resultados) {
    html += `<h2 style="font-size:16px;border-bottom:1px solid #ccc">BOP Cádiz nº ${r.num}/${r.ano} — `
      + `<a href="${r.url}">sumario</a>${r.pdf ? ` · <a href="${r.pdf}">PDF</a>` : ''}</h2>`;
    if (r.aviso) html += `<p style="color:#b00"><b>Aviso:</b> ${r.aviso}</p>`;
    if (!r.hits.length) { html += '<p>Sin anuncios de procesos selectivos.</p>'; continue; }
    total += r.hits.length;
    const grupos = Object.groupBy(r.hits, (a) => clasificar(a.titulo));
    for (const g of ORDEN.filter((g) => grupos[g])) {
      html += `<h3 style="font-size:14px;margin:12px 0 4px">${g}</h3><ul style="margin:0">`;
      for (const a of grupos[g]) {
        const destacado = /administrativ/i.test(norm(a.titulo));
        html += `<li style="margin-bottom:4px">${destacado ? '<b>★ ' : ''}${esc(a.organo || a.seccion)}.${destacado ? '</b>' : ''} `
          + `${esc(a.titulo)} <span style="color:#888">(${a.n})</span></li>`;
      }
      html += '</ul>';
    }
  }
  html += '<p style="color:#888;font-size:12px">★ = menciona «administrativo». Generado automáticamente.</p></div>';
  const nums = resultados.map((r) => r.num).join(', ');
  const subject = total
    ? `BOP Cádiz ${nums}: ${total} anuncio${total > 1 ? 's' : ''} de procesos selectivos`
    : `BOP Cádiz ${nums}: sin procesos selectivos`;
  return { subject, html, total };
}

async function enviar({ subject, html }) {
  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: `"Monitor BOP Cádiz" <${process.env.SMTP_USER}>`, to: process.env.MAIL_TO, subject, html });
}

// ---------- main ----------
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const boletines = await listarBoletines();
if (!boletines.length) throw new Error('No se han encontrado boletines en la portada: revisar formato de la web.');

const ultimo = state.ultimo; // { ano, num }
let pendientes = ultimo
  ? boletines.filter((b) => b.ano > ultimo.ano || (b.ano === ultimo.ano && b.num > ultimo.num))
  : boletines.slice(-1); // primera ejecución: solo el más reciente
pendientes = pendientes.slice(-MAX_CATCHUP);

if (!pendientes.length) { console.log('Sin boletines nuevos.'); process.exit(0); }

const resultados = [];
for (const b of pendientes) {
  const html = await get(b.url);
  const { anuncios, pdf } = extraerAnuncios(html);
  const hits = anuncios.filter(esSeleccion);
  const aviso = anuncios.length ? null
    : 'No se ha reconocido ningún anuncio en el sumario. Puede que la web haya cambiado de formato: revisa el boletín a mano.';
  console.log(`BOP ${b.num}/${b.ano}: ${anuncios.length} anuncios, ${hits.length} de selección`);
  resultados.push({ ...b, pdf, hits, aviso });
}

const correo = construirCorreo(resultados);
if (correo.total || process.env.SEND_EMPTY === '1' || resultados.some((r) => r.aviso)) {
  await enviar(correo);
  console.log(`Correo enviado: ${correo.subject}`);
}

const ult = pendientes.at(-1);
fs.writeFileSync(STATE_FILE, JSON.stringify({ ultimo: { ano: ult.ano, num: ult.num } }, null, 2) + '\n');
