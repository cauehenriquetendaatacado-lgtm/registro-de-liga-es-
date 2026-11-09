// Registro de ligações dos telefones Yealink via Action URL.
// Com DATABASE_URL (Supabase/Postgres) grava no banco; sem ela, grava em arquivos (teste local).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORTA = process.env.PORT || 8090;
const TOKEN = process.env.TOKEN || "";            // senha que o telefone e a tela precisam enviar
const DATABASE_URL = process.env.DATABASE_URL || "";
const FUSO = "America/Sao_Paulo";
const EXPIRA_MS = 2 * 60 * 60 * 1000;             // chamada sem fim após 2h é encerrada
// Integração 3CX (opcional): com estas 3 variáveis, o painel lê as chamadas direto do 3CX (por ramal)
const CX_URL = (process.env.CX_URL || "").replace(/\/+$/, "");   // ex: https://tendaatacado.3cx.com.br:5001
const CX_ID = process.env.CX_CLIENT_ID || "";
const CX_SECRET = process.env.CX_SECRET || "";
const CX_ON = !!(CX_URL && CX_ID && CX_SECRET);
const ARQ_IPS = path.join(__dirname, CX_ON ? "ramais.txt" : "ips.txt");

// ---------- utilidades ----------
const BOM = "﻿";
const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const linhaCsv = (a) => a.map(csv).join(";") + "\r\n";
const fmt = (ms) => new Date(Number(ms)).toLocaleString("pt-BR", { timeZone: FUSO });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dataParam = (s, fim) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + (fim ? "T23:59:59-03:00" : "T00:00:00-03:00"));
  return isNaN(d) ? null : d.getTime();
};

function lerIps() {
  const mapa = new Map();
  let txt = "";
  try { txt = fs.readFileSync(ARQ_IPS, "utf-8"); } catch (e) {}
  txt.split(/\r?\n/).forEach((l) => {
    l = l.trim();
    if (!l || l.startsWith("#")) return;
    const [ip, ...nome] = l.split(/\s+/);
    mapa.set(ip, nome.join(" "));
  });
  return mapa;
}

// ---------- armazenamento ----------
function criarStorePg() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  return {
    nome: "Supabase/Postgres",
    async init() {
      await pool.query(`create table if not exists eventos (
        id bigserial primary key, criado timestamptz default now(),
        ip text, evento text, remoto text, local text, callid text)`);
      await pool.query(`create table if not exists chamadas_abertas (chave text primary key, dados jsonb not null)`);
      await pool.query(`create table if not exists ligacoes (
        id bigserial primary key, ip text not null, direcao text not null, numero text,
        status text not null, inicio timestamptz not null, fim timestamptz, duracao_seg int default 0)`);
      await pool.query(`create index if not exists ligacoes_ip_inicio on ligacoes (ip, inicio)`);
      // Supabase expõe as tabelas por uma API pública; ligar o RLS (sem políticas) bloqueia esse acesso.
      // O servidor conecta como dono do banco (postgres) e continua funcionando normalmente.
      for (const t of ["eventos", "chamadas_abertas", "ligacoes"]) await pool.query(`alter table ${t} enable row level security`);
    },
    async addEvento(e) {
      await pool.query("insert into eventos (ip, evento, remoto, local, callid) values ($1,$2,$3,$4,$5)",
        [e.ip, e.evento, e.remoto, e.local, e.callid]);
    },
    async getAberta(chave) {
      const r = await pool.query("select dados from chamadas_abertas where chave=$1", [chave]);
      return r.rows[0] ? r.rows[0].dados : null;
    },
    async setAberta(chave, c) {
      await pool.query(`insert into chamadas_abertas (chave, dados) values ($1,$2)
        on conflict (chave) do update set dados = excluded.dados`, [chave, JSON.stringify(c)]);
    },
    async delAberta(chave) { await pool.query("delete from chamadas_abertas where chave=$1", [chave]); },
    async addLigacao(l) {
      await pool.query(`insert into ligacoes (ip, direcao, numero, status, inicio, fim, duracao_seg)
        values ($1,$2,$3,$4, to_timestamp($5/1000.0), to_timestamp($6/1000.0), $7)`,
        [l.ip, l.direcao, l.numero, l.status, l.inicio, l.fim, l.duracaoSeg]);
    },
    async listLigacoes(de, ate) {
      const r = await pool.query(
        `select ip, direcao, numero, status, (extract(epoch from inicio)*1000)::bigint as inicio, duracao_seg
         from ligacoes where ($1::bigint is null or inicio >= to_timestamp($1/1000.0))
         and ($2::bigint is null or inicio <= to_timestamp($2/1000.0)) order by inicio`, [de, ate]);
      return r.rows.map((x) => ({ ip: x.ip, direcao: x.direcao, numero: x.numero, status: x.status, inicio: Number(x.inicio), duracaoSeg: x.duracao_seg }));
    },
    async abertasAntigas(limiteMs) {
      const r = await pool.query("select chave, dados from chamadas_abertas");
      return r.rows.filter((x) => Date.now() - x.dados.ultimo > limiteMs).map((x) => [x.chave, x.dados]);
    },
  };
}

function criarStoreArquivo() {
  const A_EV = path.join(__dirname, "eventos.csv");
  const A_LG = path.join(__dirname, "ligacoes.jsonl");
  const abertas = new Map();
  let ligs = [];
  return {
    nome: "arquivos locais (teste)",
    async init() {
      if (!fs.existsSync(A_EV)) fs.writeFileSync(A_EV, BOM + linhaCsv(["Data/hora", "IP", "Evento", "Número remoto", "Número local", "ID da chamada"]));
      try { ligs = fs.readFileSync(A_LG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {}
    },
    async addEvento(e) { fs.appendFileSync(A_EV, linhaCsv([fmt(Date.now()), e.ip, e.evento, e.remoto, e.local, e.callid])); },
    async getAberta(k) { return abertas.get(k) || null; },
    async setAberta(k, c) { abertas.set(k, c); },
    async delAberta(k) { abertas.delete(k); },
    async addLigacao(l) { ligs.push(l); fs.appendFileSync(A_LG, JSON.stringify(l) + "\n"); },
    async listLigacoes(de, ate) { return ligs.filter((l) => (!de || l.inicio >= de) && (!ate || l.inicio <= ate)); },
    async abertasAntigas(lim) { return [...abertas].filter(([, c]) => Date.now() - c.ultimo > lim); },
  };
}

const store = DATABASE_URL ? criarStorePg() : criarStoreArquivo();

// ---------- lógica das ligações ----------
async function finalizar(chave, c, fim) {
  await store.delAberta(chave);
  const status = c.direcao === "saida" ? "Feita" : (c.atendida ? "Atendida" : "Não atendida");
  await store.addLigacao({
    ip: c.ip, direcao: c.direcao, numero: c.numero, status,
    inicio: c.inicio, fim,
    duracaoSeg: c.atendidaEm ? Math.round((fim - c.atendidaEm) / 1000) : 0,
  });
}

async function tratarEvento({ ip, evento, remoto, callid }) {
  const ev = String(evento).toLowerCase();
  let chave = ip + "|" + (callid || remoto || "?");
  const t = Date.now();
  let c = await store.getAberta(chave);
  // Se o fim/atendimento chegar com callid diferente, usa a chamada aberta mais recente deste telefone
  if (!c && ev !== "incoming" && ev !== "outgoing") {
    const abertas = (await store.abertasAntigas(-1)).filter(([, x]) => x.ip === ip).sort((a, b) => b[1].ultimo - a[1].ultimo);
    if (abertas[0]) { chave = abertas[0][0]; c = abertas[0][1]; }
  }
  if (ev === "incoming" || ev === "outgoing") {
    if (!c) await store.setAberta(chave, { ip, direcao: ev === "incoming" ? "entrada" : "saida", numero: remoto, inicio: t, atendida: false, ultimo: t });
  } else if (ev === "established" || ev === "answer") {
    if (c) { c.atendida = true; c.atendidaEm = c.atendidaEm || t; c.ultimo = t; await store.setAberta(chave, c); }
  } else if (ev === "missed" || ev === "rejected") {
    if (c) { c.atendida = false; await finalizar(chave, c, t); }
  } else if (ev === "terminated") {
    if (c) await finalizar(chave, c, t);
  }
}

// Processa os avisos um de cada vez, para a ordem não se misturar
let fila = Promise.resolve();
const enfileirar = (fn) => (fila = fila.then(fn).catch((e) => console.error("erro:", e.message)));

// ---------- 3CX (XAPI) ----------
let cxTok = { v: "", exp: 0 };
async function cxToken() {
  if (cxTok.v && Date.now() < cxTok.exp) return cxTok.v;
  const r = await fetch(CX_URL + "/connect/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CX_ID, client_secret: CX_SECRET, grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error("3CX login falhou (" + r.status + "): confira CX_URL, CX_CLIENT_ID e CX_SECRET");
  const j = await r.json();
  cxTok = { v: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return cxTok.v;
}

const cxSeg = (d) => {                       // aceita número, "00:01:05" ou "PT1M5S"
  if (d == null || d === "") return 0;
  if (typeof d === "number") return d;
  let m = String(d).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (m) return (+m[1] || 0) * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4];
  m = String(d).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.round(+m[3] || 0) : 0;
};

async function cxBuscarBruto(de, ate) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const f = `periodFrom=${iso(de)},periodTo=${iso(ate)},sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',` +
    `callsType=0,callTimeFilterType=0,callTimeFilterFrom='0:00:0',callTimeFilterTo='0:00:0',hidePcalls=false`;
  const tok = await cxToken();
  const linhas = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const r = await fetch(`${CX_URL}/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(${f})?$top=1000&$skip=${skip}`,
      { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) throw new Error("3CX chamadas falhou (" + r.status + "): " + (await r.text()).slice(0, 200));
    const v = (await r.json()).value || [];
    linhas.push(...v);
    if (v.length < 1000) break;
  }
  return linhas;
}

function cxNormalizar(rows) {
  const out = [];
  for (const r of rows) {
    const dir = String(r.Direction || "").toLowerCase();
    const inicio = Date.parse(r.StartTime);
    if (!inicio) continue;
    const seg = cxSeg(r.TalkingDuration);
    const atendida = r.Answered === true || r.Status === true || /^answered$/i.test(String(r.Status || "")) || seg > 0;
    const saida = { ip: String(r.SourceDn || "").trim(), direcao: "saida", numero: r.DestinationCallerId || r.DestinationDn || "", status: "Feita", inicio, duracaoSeg: seg };
    const entrada = { ip: String(r.DestinationDn || "").trim(), direcao: "entrada", numero: r.SourceCallerId || r.SourceDn || "", status: atendida ? "Atendida" : "Não atendida", inicio, duracaoSeg: seg };
    if (dir.startsWith("out")) out.push(saida);
    else if (dir.startsWith("internal")) { out.push(saida); out.push(entrada); }
    else out.push(entrada);
  }
  return out.filter((l) => l.ip).sort((a, b) => a.inicio - b.inicio);
}

const cxCache = new Map();
async function cxLigacoes(de, ate) {
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: FUSO });
  de = de || new Date(hoje + "T00:00:00-03:00").getTime();
  ate = ate || Date.now();
  const k = de + "|" + ate, c = cxCache.get(k);
  if (c && Date.now() - c.t < 60000) return c.v;               // cache de 1 minuto
  const v = cxNormalizar(await cxBuscarBruto(de, ate));
  cxCache.set(k, { t: Date.now(), v });
  if (cxCache.size > 30) cxCache.delete(cxCache.keys().next().value);
  return v;
}
const listarLigacoes = (de, ate) => (CX_ON ? cxLigacoes(de, ate) : store.listLigacoes(de, ate));

// ---------- resumo ----------
async function resumo(de, ate) {
  const ips = lerIps();
  const por = new Map();
  const get = (ip) => {
    if (!por.has(ip)) por.set(ip, { ip, nome: ips.get(ip) || "", feitas: 0, atendidas: 0, naoAtendidas: 0 });
    return por.get(ip);
  };
  ips.forEach((_, ip) => get(ip));
  (await listarLigacoes(de, ate)).forEach((l) => {
    if (ips.size && !ips.has(l.ip)) return;
    const r = get(l.ip);
    if (l.status === "Feita") r.feitas++;
    else if (l.status === "Atendida") r.atendidas++;
    else r.naoAtendidas++;
  });
  return [...por.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}




// ---------- servidor web ----------
async function atender(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === "/saude") { res.writeHead(200); return res.end("ok"); }

  // Arquivos do aplicativo (painel instalável): públicos; os dados (/api, /evento, .csv) pedem a senha
  const ESTATICOS = {
    "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/resumo": ["index.html", "text/html; charset=utf-8"],
    "/sw.js": ["sw.js", "application/javascript; charset=utf-8"],
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    "/icon-192.png": ["icon-192.png", "image/png"], "/icon-512.png": ["icon-512.png", "image/png"],
    "/icon-512-maskable.png": ["icon-512-maskable.png", "image/png"],
  };
  if (ESTATICOS[p]) {
    try {
      const corpo = fs.readFileSync(path.join(__dirname, "public", ESTATICOS[p][0]));
      res.writeHead(200, { "Content-Type": ESTATICOS[p][1], "Cache-Control": p === "/sw.js" ? "no-cache" : "public, max-age=300" });
      return res.end(corpo);
    } catch (e) { res.writeHead(404); return res.end("nao encontrado"); }
  } // para o "ping" que evita o Render dormir

  if (TOKEN && u.searchParams.get("t") !== TOKEN) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Acesso negado. Falta o parametro t=SUA_SENHA no endereco.");
  }
  const tq = TOKEN ? `t=${encodeURIComponent(TOKEN)}` : "";

  if (p === "/evento") {
    const ipSocket = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace("::ffff:", "");
    const ip = (u.searchParams.get("ip") || ipSocket).trim();
    const e = { ip, evento: u.searchParams.get("evento") || "", remoto: u.searchParams.get("remoto") || "",
      local: u.searchParams.get("local") || "", callid: u.searchParams.get("callid") || "" };
    const ips = lerIps();
    console.log(`evento ip=${ip} (socket ${ipSocket}) evento=${e.evento} remoto=${e.remoto} callid=${e.callid}`);
    if (ips.size && !ips.has(ip)) {
      await enfileirar(() => store.addEvento({ ...e, evento: "IGNORADO:" + e.evento }));
      res.writeHead(200); return res.end("ignorado");
    }
    await enfileirar(async () => { await store.addEvento(e); await tratarEvento(e); });
    res.writeHead(200); return res.end("ok");
  }

  if (p === "/api/3cx-teste") {                       // mostra o que o 3CX devolve (para conferir a ligação)
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    if (!CX_ON) return res.end(JSON.stringify({ ok: false, erro: "Faltam CX_URL, CX_CLIENT_ID e CX_SECRET no Render" }));
    try {
      const bruto = await cxBuscarBruto(Date.now() - 24 * 3600 * 1000, Date.now());
      return res.end(JSON.stringify({ ok: true, chamadas_24h: bruto.length, amostra: bruto.slice(0, 3) }, null, 2));
    } catch (e) { return res.end(JSON.stringify({ ok: false, erro: e.message })); }
  }

  const de = dataParam(u.searchParams.get("de"), false);
  const ate = dataParam(u.searchParams.get("ate"), true);
  const filtro = [tq, u.searchParams.get("de") ? `de=${u.searchParams.get("de")}` : "", u.searchParams.get("ate") ? `ate=${u.searchParams.get("ate")}` : ""].filter(Boolean).join("&");

  if (p === "/resumo.csv") {
    let out = BOM + linhaCsv(["IP", "Nome", "Feitas", "Atendidas", "Não atendidas"]);
    (await resumo(de, ate)).forEach((r) => (out += linhaCsv([r.ip, r.nome, r.feitas, r.atendidas, r.naoAtendidas])));
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="resumo-ligacoes.csv"' });
    return res.end(out);
  }

  if (p === "/ligacoes.csv") {
    let out = BOM + linhaCsv(["Início", "IP", "Direção", "Número", "Situação", "Duração (s)"]);
    (await listarLigacoes(de, ate)).forEach((l) => (out += linhaCsv([fmt(l.inicio), l.ip, l.direcao === "saida" ? "Feita" : "Recebida", l.numero, l.status, l.duracaoSeg])));
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ligacoes.csv"' });
    return res.end(out);
  }

  if (p === "/api/painel") {
    const linhas = await resumo(de, ate);
    const ips = lerIps();
    const lista = (await listarLigacoes(de, ate)).filter((l) => !ips.size || ips.has(l.ip));
    const recentes = lista.slice(-20).reverse().map((l) => ({
      quando: fmt(l.inicio), ip: l.ip, nome: ips.get(l.ip) || "", direcao: l.direcao, numero: l.numero, status: l.status, seg: l.duracaoSeg,
    }));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ linhas, recentes, atualizado: fmt(Date.now()), armazenamento: CX_ON ? "3CX" : store.nome }));
  }

  res.writeHead(404); res.end("nao encontrado");
}

(async () => {
  await store.init();
  setInterval(async () => {
    try { for (const [k, c] of await store.abertasAntigas(EXPIRA_MS)) await enfileirar(() => finalizar(k, c, c.ultimo)); } catch (e) { console.error(e.message); }
  }, 10 * 60 * 1000);
  http.createServer((req, res) => atender(req, res).catch((e) => { console.error(e); res.writeHead(500); res.end("erro"); }))
    .listen(PORTA, () => console.log(`Rodando na porta ${PORTA}. Armazenamento: ${store.nome}. Token: ${TOKEN ? "ligado" : "DESLIGADO"}`));
})();
