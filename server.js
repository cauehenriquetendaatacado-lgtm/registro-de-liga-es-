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
const CX_SYNC_MIN = Math.max(1, Number(process.env.CX_SYNC_MIN) || 2);        // de quantos em quantos minutos atualiza o histórico
const CX_DIAS_INICIAL = Math.max(1, Number(process.env.CX_DIAS_INICIAL) || 30); // quantos dias buscar na primeira vez
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
  mapa.extra = new Map();                                  // ramal -> { email, depto } (formato: Nome | e-mail | departamento)
  let txt = "";
  try { txt = fs.readFileSync(ARQ_IPS, "utf-8"); } catch (e) {}
  txt.split(/\r?\n/).forEach((l) => {
    l = l.trim();
    if (!l || l.startsWith("#")) return;
    const [ip, ...resto] = l.split(/\s+/);
    const [nome, email, depto] = resto.join(" ").split("|").map((x) => x.trim());
    mapa.set(ip, nome || "");
    mapa.extra.set(ip, { email: email || "", depto: depto || "" });
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
      // histórico do 3CX: origem + chave única (evita duplicar a mesma chamada a cada sincronização)
      await pool.query(`alter table ligacoes add column if not exists origem text default 'yealink'`);
      await pool.query(`alter table ligacoes add column if not exists chave text`);
      await pool.query(`create unique index if not exists ligacoes_chave on ligacoes (chave)`);
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
    async listAbertas() { return (await pool.query("select dados from chamadas_abertas")).rows.map((x) => x.dados); },
    async contar() { return Number((await pool.query("select count(*) c from ligacoes")).rows[0].c); },
    async addLigacao(l) {
      const r = await pool.query(`insert into ligacoes (ip, direcao, numero, status, inicio, fim, duracao_seg, origem, chave)
        values ($1,$2,$3,$4, to_timestamp($5::bigint/1000.0), to_timestamp($6::bigint/1000.0), $7, $8, $9)
        on conflict (chave) do update set status = excluded.status, duracao_seg = excluded.duracao_seg, numero = excluded.numero
        returning id`,
        [l.ip, l.direcao, l.numero || "", l.status, l.inicio, l.fim || l.inicio, l.duracaoSeg || 0, l.origem || "yealink", l.chave || null]);
      return Number(r.rows[0].id);
    },
    async buscar(f) {
      const w = [], p = [];
      const add = (sql, v) => { p.push(v); w.push(sql.replace("?", "$" + p.length)); };
      if (f.de != null) add("inicio >= to_timestamp(?::bigint/1000.0)", f.de);
      if (f.ate != null) add("inicio <= to_timestamp(?::bigint/1000.0)", f.ate);
      if (f.ramal) add("ip = ?", f.ramal);
      if (f.status) add("status = ?", f.status);
      if (f.direcao) add("direcao = ?", f.direcao);
      if (f.origem) add("origem = ?", f.origem);
      if (f.q) add("numero ilike ?", "%" + f.q + "%");
      if (f.ramais && f.ramais.length) add("ip = any(?::text[])", f.ramais);
      const onde = w.length ? "where " + w.join(" and ") : "";
      const total = Number((await pool.query(`select count(*) c from ligacoes ${onde}`, p)).rows[0].c);
      const r = await pool.query(
        `select id, ip, direcao, numero, status, (extract(epoch from inicio)*1000)::bigint as inicio, duracao_seg, origem
         from ligacoes ${onde} order by inicio desc, id desc limit ${Number(f.limite) | 0} offset ${Number(f.offset) | 0}`, p);
      return { total, itens: r.rows.map((x) => ({ id: Number(x.id), ip: x.ip, direcao: x.direcao, numero: x.numero, status: x.status, inicio: Number(x.inicio), duracaoSeg: x.duracao_seg, origem: x.origem })) };
    },
    async remover(id) { return (await pool.query("delete from ligacoes where id=$1", [id])).rowCount > 0; },
    async listLigacoes(de, ate, origem, ramal) {
      const r = await pool.query(
        `select ip, direcao, numero, status, (extract(epoch from inicio)*1000)::bigint as inicio, duracao_seg
         from ligacoes where ($1::bigint is null or inicio >= to_timestamp($1/1000.0))
         and ($2::bigint is null or inicio <= to_timestamp($2/1000.0))
         and ($3::text is null or origem = $3) and ($4::text is null or ip = $4) order by inicio`,
        [de, ate, origem || null, ramal || null]);
      return r.rows.map((x) => ({ ip: x.ip, direcao: x.direcao, numero: x.numero, status: x.status, inicio: Number(x.inicio), duracaoSeg: x.duracao_seg }));
    },
    async upsertLigacoes(lista) {               // grava/atualiza chamadas do 3CX (chave única por chamada + ramal)
      const mapa = new Map(lista.map((l) => [l.chave, l]));
      const ls = [...mapa.values()];
      for (let i = 0; i < ls.length; i += 500) {
        const l = ls.slice(i, i + 500);
        await pool.query(`insert into ligacoes (ip, direcao, numero, status, inicio, duracao_seg, origem, chave)
          select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::int[], $7::text[], $8::text[])
          on conflict (chave) do update set status = excluded.status, duracao_seg = excluded.duracao_seg, numero = excluded.numero`,
          [l.map((x) => x.ip), l.map((x) => x.direcao), l.map((x) => x.numero || ""), l.map((x) => x.status),
           l.map((x) => new Date(x.inicio).toISOString()), l.map((x) => x.duracaoSeg || 0), l.map(() => "3cx"), l.map((x) => x.chave)]);
      }
    },
    async ultimoInicio(origem) {
      const r = await pool.query("select (extract(epoch from max(inicio))*1000)::bigint as m from ligacoes where origem = $1", [origem]);
      return r.rows[0] && r.rows[0].m ? Number(r.rows[0].m) : 0;
    },
    async abertasAntigas(limiteMs) {
      const r = await pool.query("select chave, dados from chamadas_abertas");
      return r.rows.filter((x) => Date.now() - x.dados.ultimo > limiteMs).map((x) => [x.chave, x.dados]);
    },
  };
}

// Banco próprio (SQLite embutido no Node 22.13+): sem serviço externo, o histórico fica no arquivo dados/ligacoes.db
function criarStoreSqlite() {
  const { DatabaseSync } = require("node:sqlite");
  const dir = process.env.DATA_DIR || path.join(__dirname, "dados");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "ligacoes.db"));
  db.exec(`pragma journal_mode = WAL; pragma synchronous = NORMAL;
    create table if not exists eventos (id integer primary key autoincrement, criado integer, ip text, evento text, remoto text, local text, callid text);
    create table if not exists chamadas_abertas (chave text primary key, dados text not null);
    create table if not exists ligacoes (id integer primary key autoincrement, ip text not null, direcao text not null, numero text,
      status text not null, inicio integer not null, fim integer, duracao_seg integer default 0, origem text default 'yealink', chave text);
    create index if not exists ligacoes_ip_inicio on ligacoes (ip, inicio);
    create index if not exists ligacoes_inicio on ligacoes (inicio);
    create unique index if not exists ligacoes_chave on ligacoes (chave);`);
  const pegar = (sql) => db.prepare(sql);
  const mapa = (x) => ({ id: Number(x.id), ip: x.ip, direcao: x.direcao, numero: x.numero, status: x.status, inicio: Number(x.inicio), duracaoSeg: x.duracao_seg, origem: x.origem });
  const filtros = (f) => {
    const w = [], p = [];
    if (f.de != null) { w.push("inicio >= ?"); p.push(f.de); }
    if (f.ate != null) { w.push("inicio <= ?"); p.push(f.ate); }
    if (f.ramal) { w.push("ip = ?"); p.push(f.ramal); }
    if (f.status) { w.push("status = ?"); p.push(f.status); }
    if (f.direcao) { w.push("direcao = ?"); p.push(f.direcao); }
    if (f.origem) { w.push("origem = ?"); p.push(f.origem); }
    if (f.q) { w.push("numero like ?"); p.push("%" + f.q + "%"); }
    if (f.ramais && f.ramais.length) { w.push(`ip in (${f.ramais.map(() => "?").join(",")})`); p.push(...f.ramais); }
    return { onde: w.length ? "where " + w.join(" and ") : "", p };
  };
  const upsert = pegar(`insert into ligacoes (ip, direcao, numero, status, inicio, fim, duracao_seg, origem, chave) values (?,?,?,?,?,?,?,?,?)
    on conflict (chave) do update set status = excluded.status, duracao_seg = excluded.duracao_seg, numero = excluded.numero returning id`);
  return {
    nome: "SQLite próprio (" + path.join(dir, "ligacoes.db") + ")",
    async init() {},
    async addEvento(e) { pegar("insert into eventos (criado, ip, evento, remoto, local, callid) values (?,?,?,?,?,?)").run(Date.now(), e.ip, e.evento, e.remoto, e.local, e.callid); },
    async getAberta(k) { const r = pegar("select dados from chamadas_abertas where chave=?").get(k); return r ? JSON.parse(r.dados) : null; },
    async setAberta(k, c) { pegar("insert into chamadas_abertas (chave, dados) values (?,?) on conflict (chave) do update set dados = excluded.dados").run(k, JSON.stringify(c)); },
    async delAberta(k) { pegar("delete from chamadas_abertas where chave=?").run(k); },
    async listAbertas() { return pegar("select dados from chamadas_abertas").all().map((x) => JSON.parse(x.dados)); },
    async contar() { return Number(pegar("select count(*) c from ligacoes").get().c); },
    async addLigacao(l) {
      return Number(upsert.get(l.ip, l.direcao, l.numero || "", l.status, l.inicio, l.fim || l.inicio, l.duracaoSeg || 0, l.origem || "yealink", l.chave || null).id);
    },
    async listLigacoes(de, ate, origem, ramal) {
      const { onde, p } = filtros({ de, ate, origem, ramal });
      return pegar(`select * from ligacoes ${onde} order by inicio`).all(...p).map(mapa);
    },
    async buscar(f) {
      const { onde, p } = filtros(f);
      const total = Number(pegar(`select count(*) c from ligacoes ${onde}`).get(...p).c);
      const itens = pegar(`select * from ligacoes ${onde} order by inicio desc, id desc limit ? offset ?`).all(...p, f.limite, f.offset).map(mapa);
      return { total, itens };
    },
    async remover(id) { return pegar("delete from ligacoes where id=?").run(id).changes > 0; },
    async upsertLigacoes(lista) {
      db.exec("begin");
      try { for (const l of lista) upsert.get(l.ip, l.direcao, l.numero || "", l.status, l.inicio, l.inicio, l.duracaoSeg || 0, "3cx", l.chave); db.exec("commit"); }
      catch (e) { db.exec("rollback"); throw e; }
    },
    async ultimoInicio(origem) { const r = pegar("select max(inicio) m from ligacoes where origem=?").get(origem); return r && r.m ? Number(r.m) : 0; },
    async abertasAntigas(lim) { return pegar("select chave, dados from chamadas_abertas").all().map((x) => [x.chave, JSON.parse(x.dados)]).filter(([, c]) => Date.now() - c.ultimo > lim); },
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
      try { ligs = fs.readFileSync(A_LG, "utf-8").split("\n").filter(Boolean).map((l, i) => { const o = JSON.parse(l); o.id = o.id || i + 1; return o; }); } catch (e) {}
    },
    async addEvento(e) { fs.appendFileSync(A_EV, linhaCsv([fmt(Date.now()), e.ip, e.evento, e.remoto, e.local, e.callid])); },
    async getAberta(k) { return abertas.get(k) || null; },
    async setAberta(k, c) { abertas.set(k, c); },
    async delAberta(k) { abertas.delete(k); },
    async listAbertas() { return [...abertas.values()]; },
    async contar() { return ligs.length; },
    async addLigacao(l) {
      const i = l.chave ? ligs.findIndex((x) => x.chave === l.chave) : -1;
      if (i >= 0) { ligs[i] = { ...ligs[i], ...l, id: ligs[i].id }; fs.writeFileSync(A_LG, ligs.map((x) => JSON.stringify(x)).join("\n") + "\n"); return ligs[i].id; }
      const n = { ...l, id: (ligs.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1, origem: l.origem || "yealink" };
      ligs.push(n); fs.appendFileSync(A_LG, JSON.stringify(n) + "\n"); return n.id;
    },
    async buscar(f) {
      let r = ligs.filter((l) => (f.de == null || l.inicio >= f.de) && (f.ate == null || l.inicio <= f.ate) && (!f.ramal || l.ip === f.ramal)
        && (!f.status || l.status === f.status) && (!f.direcao || l.direcao === f.direcao) && (!f.origem || (l.origem || "yealink") === f.origem)
        && (!f.q || String(l.numero || "").includes(f.q)) && (!f.ramais || !f.ramais.length || f.ramais.includes(l.ip)))
        .sort((a, b) => b.inicio - a.inicio);
      return { total: r.length, itens: r.slice(f.offset, f.offset + f.limite).map((l) => ({ ...l, id: l.id || 0, origem: l.origem || "yealink" })) };
    },
    async remover(id) {
      const i = ligs.findIndex((x) => x.id === id); if (i < 0) return false;
      ligs.splice(i, 1); fs.writeFileSync(A_LG, ligs.map((x) => JSON.stringify(x)).join("\n") + (ligs.length ? "\n" : "")); return true;
    },
    async listLigacoes(de, ate, origem, ramal) {
      return ligs.filter((l) => (!de || l.inicio >= de) && (!ate || l.inicio <= ate)
        && (!origem || (l.origem || "yealink") === origem) && (!ramal || l.ip === ramal)).sort((a, b) => a.inicio - b.inicio);
    },
    async upsertLigacoes(lista) {
      let mudou = false;
      for (const l of lista) {
        const i = ligs.findIndex((x) => x.chave === l.chave);
        if (i < 0) { const n = { ...l, origem: "3cx" }; ligs.push(n); fs.appendFileSync(A_LG, JSON.stringify(n) + "\n"); }
        else if (ligs[i].status !== l.status || ligs[i].duracaoSeg !== l.duracaoSeg) { ligs[i] = { ...ligs[i], ...l, origem: "3cx" }; mudou = true; }
      }
      if (mudou) fs.writeFileSync(A_LG, ligs.map((x) => JSON.stringify(x)).join("\n") + "\n");
    },
    async ultimoInicio(origem) { return ligs.filter((l) => l.origem === origem).reduce((m, l) => Math.max(m, l.inicio), 0); },
    async abertasAntigas(lim) { return [...abertas].filter(([, c]) => Date.now() - c.ultimo > lim); },
  };
}

function escolherStore() {
  if (DATABASE_URL) return criarStorePg();                       // opcional: Postgres/Supabase
  try { return criarStoreSqlite(); }                             // padrão: banco próprio SQLite
  catch (e) { console.error("SQLite indisponível (precisa Node 22.13+), usando arquivos:", e.message); return criarStoreArquivo(); }
}
const store = escolherStore();
const diag = { recebidos: 0, aceitos: 0, ignorados: new Map(), ultimo: null, desde: Date.now() };   // diagnóstico dos avisos dos telefones

// ---------- lógica das ligações ----------
const finalizadas = new Map();                  // chaves já encerradas (evita "terminated" após "missed" fechar outra chamada)
async function finalizar(chave, c, fim) {
  await store.delAberta(chave);
  finalizadas.set(chave, Date.now());
  for (const [k, t] of finalizadas) if (Date.now() - t > 120000) finalizadas.delete(k);
  const status = c.direcao === "saida" ? "Feita" : (c.atendida ? "Atendida" : "Não atendida");
  await store.addLigacao({
    ip: c.ip, direcao: c.direcao, numero: c.numero, status,
    inicio: c.inicio, fim,
    duracaoSeg: c.atendidaEm ? Math.round((fim - c.atendidaEm) / 1000) : 0,
  });
}

async function tratarEvento({ ip, evento, remoto, callid, ts }) {
  const ev = String(evento).toLowerCase();
  let chave = ip + "|" + (callid || remoto || "?");
  // ts = hora real do evento (enviada pelo relay local quando reenvia um aviso atrasado); aceita só até 6h atrás
  const tsN = Number(ts);
  const t = tsN > Date.now() - 6 * 3600 * 1000 && tsN <= Date.now() ? tsN : Date.now();
  let c = await store.getAberta(chave);
  if (!c && ev !== "incoming" && ev !== "outgoing" && Date.now() - (finalizadas.get(chave) || 0) < 120000) return;   // evento repetido de chamada já registrada
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
    const id = r.SegmentId ?? r.CallHistoryId ?? r.Id ?? "";
    const chaveDe = (ramal, dir, numero) => `3cx|${id !== "" ? id : inicio + "|" + numero}|${ramal}|${dir}`;
    const sNum = r.DestinationCallerId || r.DestinationDn || "", eNum = r.SourceCallerId || r.SourceDn || "";
    const sIp = String(r.SourceDn || "").trim(), eIp = String(r.DestinationDn || "").trim();
    const saida = { ip: sIp, direcao: "saida", numero: sNum, status: "Feita", inicio, duracaoSeg: seg, chave: chaveDe(sIp, "saida", sNum) };
    const entrada = { ip: eIp, direcao: "entrada", numero: eNum, status: atendida ? "Atendida" : "Não atendida", inicio, duracaoSeg: seg, chave: chaveDe(eIp, "entrada", eNum) };
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

// ---------- 3CX: histórico por ramal gravado no banco ----------
// A cada CX_SYNC_MIN minutos busca no 3CX as chamadas recentes dos ramais de ramais.txt e grava/atualiza
// na tabela "ligacoes" (origem 3cx). Assim o histórico de cada ramal fica guardado e o painel não depende
// de consultar o 3CX a cada abertura.
const cxSync = { rodando: false, ok: false, ultima: 0, erro: "", gravadas: 0 };
const DIA_MS = 24 * 3600 * 1000;
async function cxSincronizar(de, ate) {
  const ramais = lerIps();
  let total = 0;
  for (let ini = de; ini < ate; ini += 3 * DIA_MS) {            // busca em blocos de 3 dias
    const fim = Math.min(ini + 3 * DIA_MS, ate);
    const lista = cxNormalizar(await cxBuscarBruto(ini, fim)).filter((l) => !ramais.size || ramais.has(l.ip));
    await store.upsertLigacoes(lista);
    total += lista.length;
  }
  cxCache.clear();
  return total;
}
async function cxCicloSync(primeira) {
  if (!CX_ON || cxSync.rodando) return;
  cxSync.rodando = true;
  try {
    const ate = Date.now();
    let de = ate - 6 * 3600 * 1000;                               // ciclo normal: últimas 6h (pega chamadas que terminaram depois)
    if (primeira) {
      const ult = await store.ultimoInicio("3cx");
      de = ult ? ult - DIA_MS : ate - CX_DIAS_INICIAL * DIA_MS;   // 1ª vez: histórico inicial; depois: continua de onde parou
    }
    cxSync.gravadas = await cxSincronizar(de, ate);
    cxSync.ok = true; cxSync.erro = ""; cxSync.ultima = Date.now();
    if (primeira) console.log(`3CX: histórico sincronizado (${cxSync.gravadas} registros de ramais)`);
  } catch (e) { cxSync.erro = e.message; console.error("3CX sync:", e.message); }
  finally { cxSync.rodando = false; }
}

// ---------- ligações ativas agora ----------
// Yealink: lê as chamadas abertas (ainda sem "terminated"). 3CX: lê /xapi/v1/ActiveCalls.
// Quando uma chamada some da lista, o histórico dela é gravado: no modo Yealink o "terminated" já grava;
// no modo 3CX dispara uma sincronização logo depois (sem esperar o ciclo de 2 min).
async function ativasYealink() {
  const ips = lerIps();
  return (await store.listAbertas())
    .filter((c) => (!ips.size || ips.has(c.ip)) && (c.atendida || Date.now() - c.inicio < 5 * 60 * 1000)) // tocando há +5 min = aviso perdido
    .map((c) => ({ ramal: c.ip, direcao: c.direcao, numero: c.numero, estado: c.atendida ? "Falando" : "Tocando", inicio: c.inicio, falandoDesde: c.atendidaEm || 0 }))
    .sort((a, b) => a.inicio - b.inicio);
}

async function cxAtivasBruto() {
  const tok = await cxToken();
  const r = await fetch(`${CX_URL}/xapi/v1/ActiveCalls`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) throw new Error("3CX chamadas ativas falhou (" + r.status + "): " + (await r.text()).slice(0, 200));
  return (await r.json()).value || [];
}

const cxRamalDe = (txt, ramais) => {                     // acha o ramal dentro de textos como "Ext.39001 (PA01)" ou "39001"
  for (const m of String(txt || "").match(/\b\d{3,6}\b/g) || []) if (!ramais.size || ramais.has(m)) return m;
  return "";
};

function cxNormalizarAtivas(rows, ramais) {
  const out = [];
  for (const r of rows) {
    const de = cxRamalDe(r.Caller, ramais), para = cxRamalDe(r.Callee, ramais);
    if (!de && !para) continue;
    const falando = /^talking$/i.test(String(r.Status || ""));
    const inicio = Date.parse(r.EstablishedAt) || Date.parse(r.LastChangeStatus) || Date.now();
    const base = { id: String(r.Id ?? ""), estado: falando ? "Falando" : "Tocando", inicio, falandoDesde: falando ? (Date.parse(r.LastChangeStatus) || inicio) : 0 };
    if (de) out.push({ ...base, ramal: de, direcao: "saida", numero: String(r.Callee || "") });
    if (para) out.push({ ...base, ramal: para, direcao: "entrada", numero: String(r.Caller || "") });
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}

let cxAtivasCache = { t: 0, v: [] }, cxAtivasIds = new Set();
async function cxAtivas() {
  if (Date.now() - cxAtivasCache.t < 4000) return cxAtivasCache.v;   // vários painéis abertos = 1 consulta ao 3CX
  const bruto = await cxAtivasBruto();
  const ids = new Set(bruto.map((r) => String(r.Id)));
  if ([...cxAtivasIds].some((i) => !ids.has(i))) setTimeout(() => cxCicloSync(false), 15000);   // alguma chamada terminou: grava no histórico
  cxAtivasIds = ids;
  cxAtivasCache = { t: Date.now(), v: cxNormalizarAtivas(bruto, lerIps()) };
  return cxAtivasCache.v;
}

// Com o 3CX ligado lê o histórico do banco (por ramal); enquanto a 1ª sincronização não termina, lê direto do 3CX.
async function listarLigacoes(de, ate, ramal) {
  if (!CX_ON) return store.listLigacoes(de, ate, null, ramal);
  if (!cxSync.ok) return (await cxLigacoes(de, ate)).filter((l) => !ramal || l.ip === ramal);
  return store.listLigacoes(de, ate, "3cx", ramal);
}

// ---------- resumo ----------
async function resumo(de, ate) {
  const ips = lerIps();
  const por = new Map();
  const get = (ip) => {
    if (!por.has(ip)) por.set(ip, { ip, nome: ips.get(ip) || "", email: (ips.extra.get(ip) || {}).email || "", depto: (ips.extra.get(ip) || {}).depto || "", feitas: 0, atendidas: 0, naoAtendidas: 0 });
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





// ---------- API própria ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS }); res.end(JSON.stringify(obj, null, 2)); };
const lerCorpo = (req) => new Promise((ok, falha) => {
  let b = "";
  req.on("data", (d) => { b += d; if (b.length > 2e6) { falha(new Error("corpo grande demais")); req.destroy(); } });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { falha(new Error("JSON inválido")); } });
  req.on("error", falha);
});
const STATUS = { atendida: "Atendida", answered: "Atendida", atendido: "Atendida", "nao atendida": "Não atendida", "não atendida": "Não atendida", missed: "Não atendida", perdida: "Não atendida", rejeitada: "Não atendida",
  feita: "Feita", outgoing: "Feita", realizada: "Feita" };
const semAcento = (x) => String(x || "").trim().toLowerCase();
const tempo = (v) => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(v)); return n && n < 1e11 ? n * 1000 : n || null; };   // aceita ms, segundos ou data ISO

function normalizarLigacao(b, ips) {
  const ip = String(b.ramal ?? b.ip ?? "").trim();
  if (!ip) throw new Error("informe o ramal (ou ip)");
  if (ips.size && !ips.has(ip)) throw new Error(`ramal/ip ${ip} não está cadastrado em ${path.basename(ARQ_IPS)}`);
  const d = semAcento(b.direcao);
  const direcao = /^(saida|saída|out|outgoing|feita|realizada)/.test(d) ? "saida" : /^(entrada|in|incoming|recebida)/.test(d) ? "entrada" : "";
  if (!direcao) throw new Error('direcao deve ser "entrada" ou "saida"');
  const inicio = tempo(b.inicio);
  if (!inicio) throw new Error("inicio inválido (use data ISO ou milissegundos)");
  const fim = tempo(b.fim) || inicio;
  const duracaoSeg = Math.max(0, Math.round(Number(b.duracaoSeg ?? b.duracao_seg ?? b.duracao ?? 0)) || 0);
  let status = STATUS[semAcento(b.status)] || "";
  if (!status) status = direcao === "saida" ? "Feita" : duracaoSeg > 0 ? "Atendida" : "Não atendida";
  if (direcao === "saida") status = "Feita";
  const chave = b.chave || b.id_externo ? "api|" + String(b.chave || b.id_externo) + "|" + ip : null;   // com chave, reenviar a mesma chamada atualiza em vez de duplicar
  return { ip, direcao, numero: String(b.numero ?? b.remoto ?? "").slice(0, 60), status, inicio, fim, duracaoSeg, origem: "api", chave };
}

function filtrosHistorico(u, ips) {
  const q = u.searchParams;
  const status = { atendida: "Atendida", nao_atendida: "Não atendida", feita: "Feita" }[semAcento(q.get("status")).replace(/[ -]/g, "_").replace("não", "nao")] || "";
  const limite = Math.min(500, Math.max(1, Number(q.get("limite")) || 50));
  const pagina = Math.max(1, Number(q.get("pagina")) || 1);
  return { de: dataParam(q.get("de"), false), ate: dataParam(q.get("ate"), true), ramal: (q.get("ramal") || "").trim(), status,
    direcao: { entrada: "entrada", recebida: "entrada", saida: "saida", feita: "saida" }[semAcento(q.get("direcao"))] || "",
    q: (q.get("q") || "").trim().slice(0, 40), ramais: ips.size ? [...ips.keys()] : null, limite, offset: (pagina - 1) * limite, pagina };
}
const itemApi = (l, ips) => ({ id: l.id, ramal: l.ip, nome: ips.get(l.ip) || "", direcao: l.direcao, numero: l.numero, status: l.status, inicio: new Date(l.inicio).toISOString(),
  quando: fmt(l.inicio), duracaoSeg: l.duracaoSeg, origem: l.origem });

async function rotasApi(req, res, u, p) {
  const ips = lerIps();
  try {
    if (p === "/api/ajuda") return json(res, 200, { auth: "?t=SENHA | Authorization: Bearer SENHA | X-API-Key: SENHA", endpoints: {
      "POST /api/ligacoes": "registra uma ligação (objeto ou lista): {ramal, direcao:'entrada'|'saida', numero, inicio, duracaoSeg, status?, fim?, chave?}",
      "GET /api/ligacoes": "histórico paginado. Filtros: de, ate (AAAA-MM-DD), ramal, status (atendida|nao_atendida|feita), direcao (entrada|saida), q (número), pagina, limite",
      "DELETE /api/ligacoes/{id}": "apaga um registro",
      "POST /api/eventos": "evento do telefone em JSON: {ip, evento:'incoming|outgoing|established|terminated|missed|rejected', remoto, callid}",
      "GET /api/ramais": "ramais/telefones cadastrados", "GET /api/resumo": "totais por ramal (de, ate)", "GET /api/ativas": "ligações em andamento", "GET /ligacoes.csv": "exportação em Excel/CSV" } });

    if (p === "/api/ramais" && req.method === "GET") return json(res, 200, { ramais: [...ips.keys()].map((r) => ({ ramal: r, nome: ips.get(r), ...ips.extra.get(r) })) });

    if (p === "/api/resumo" && req.method === "GET") return json(res, 200, { linhas: await resumo(dataParam(u.searchParams.get("de"), false), dataParam(u.searchParams.get("ate"), true)) });

    if (p === "/api/eventos" && req.method === "POST") {
      const b = await lerCorpo(req);
      const lista = Array.isArray(b) ? b : [b];
      let aceitos = 0, ignorados = 0;
      for (const x of lista.slice(0, 500)) {
        const e = { ip: String(x.ip || x.ramal || "").trim(), evento: String(x.evento || ""), remoto: String(x.remoto || x.numero || ""), local: String(x.local || ""), callid: String(x.callid || ""), ts: String(x.ts || "") };
        if (!e.ip || !e.evento) { ignorados++; continue; }
        diag.recebidos++;
        if (ips.size && !ips.has(e.ip)) { ignorados++; continue; }
        diag.aceitos++; aceitos++;
        await enfileirar(async () => { await store.addEvento(e); await tratarEvento(e); });
      }
      return json(res, 200, { ok: true, aceitos, ignorados });
    }

    if (p === "/api/ligacoes" && req.method === "POST") {
      const b = await lerCorpo(req);
      const lista = Array.isArray(b) ? b : [b];
      if (!lista.length || lista.length > 500) return json(res, 400, { ok: false, erro: "envie de 1 a 500 ligações" });
      const ids = [], erros = [];
      for (let i = 0; i < lista.length; i++) {
        try { ids.push(await store.addLigacao(normalizarLigacao(lista[i], ips))); } catch (e) { erros.push({ indice: i, erro: e.message }); }
      }
      return json(res, erros.length && !ids.length ? 400 : 201, { ok: !erros.length, gravadas: ids.length, ids, erros });
    }

    if (p === "/api/ligacoes" && req.method === "GET") {
      const f = filtrosHistorico(u, ips);
      const r = await store.buscar(f);
      return json(res, 200, { total: r.total, pagina: f.pagina, limite: f.limite, paginas: Math.max(1, Math.ceil(r.total / f.limite)), itens: r.itens.map((l) => itemApi(l, ips)) });
    }

    const m = p.match(/^\/api\/ligacoes\/(\d+)$/);
    if (m && req.method === "DELETE") return json(res, 200, { ok: await store.remover(Number(m[1])) });
  } catch (e) { return json(res, 400, { ok: false, erro: e.message }); }
  return null;
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

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (TOKEN && u.searchParams.get("t") !== TOKEN && auth !== TOKEN && req.headers["x-api-key"] !== TOKEN) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
    return res.end("Acesso negado. Envie a senha em ?t=SUA_SENHA, no cabecalho Authorization: Bearer SUA_SENHA ou X-API-Key.");
  }
  const tq = TOKEN ? `t=${encodeURIComponent(TOKEN)}` : "";

  if (p === "/evento") {
    const ipSocket = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace("::ffff:", "");
    const ip = (u.searchParams.get("ip") || ipSocket).trim();
    const e = { ip, evento: u.searchParams.get("evento") || "", remoto: u.searchParams.get("remoto") || "",
      local: u.searchParams.get("local") || "", callid: u.searchParams.get("callid") || "", ts: u.searchParams.get("ts") || "" };
    const ips = lerIps();
    diag.recebidos++; diag.ultimo = { quando: fmt(Date.now()), ip, evento: e.evento, remoto: e.remoto };
    console.log(`evento ip=${ip} (socket ${ipSocket}) evento=${e.evento} remoto=${e.remoto} callid=${e.callid}`);
    if (ips.size && !ips.has(ip)) {
      diag.ignorados.set(ip, (diag.ignorados.get(ip) || 0) + 1);
      await enfileirar(() => store.addEvento({ ...e, evento: "IGNORADO:" + e.evento }));
      res.writeHead(200); return res.end("ignorado");
    }
    diag.aceitos++;
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

  if (p === "/api/3cx-sincronizar") {               // busca o histórico de N dias no 3CX e grava no banco (ex: ?dias=60)
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    if (!CX_ON) return res.end(JSON.stringify({ ok: false, erro: "Faltam CX_URL, CX_CLIENT_ID e CX_SECRET no Render" }));
    if (cxSync.rodando) return res.end(JSON.stringify({ ok: false, erro: "Já existe uma sincronização em andamento, tente em instantes" }));
    const dias = Math.min(365, Math.max(1, Number(u.searchParams.get("dias")) || 30));
    cxSync.rodando = true;
    try {
      const n = await cxSincronizar(Date.now() - dias * DIA_MS, Date.now());
      cxSync.ok = true; cxSync.erro = ""; cxSync.ultima = Date.now(); cxSync.gravadas = n;
      return res.end(JSON.stringify({ ok: true, dias, registros_de_ramais: n }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, erro: e.message })); }
    finally { cxSync.rodando = false; }
  }

  if (p === "/api/diagnostico") {                   // mostra onde as ligações estão parando
    const ips = lerIps();
    const r = { modo: CX_ON ? "3CX" : "Yealink (Action URL)", armazenamento: store.nome, token_ligado: !!TOKEN,
      arquivo_de_cadastro: path.basename(ARQ_IPS), cadastrados: [...ips.keys()].length, exemplo_cadastrados: [...ips.keys()].slice(0, 5) };
    try { r.ligacoes_gravadas_no_banco = await store.contar(); } catch (e) { r.erro_banco = e.message; }
    if (CX_ON) {
      r.sync = { ok: cxSync.ok, ultima: cxSync.ultima ? fmt(cxSync.ultima) : "", erro: cxSync.erro, gravadas_ultimo_ciclo: cxSync.gravadas };
      try { const b = await cxAtivasBruto(); r.ativas_no_3cx_agora = b.length; r.amostra_ativas = b.slice(0, 2); } catch (e) { r.erro_ativas = e.message; }
      try { const b = await cxBuscarBruto(Date.now() - 24 * 3600 * 1000, Date.now()); r.chamadas_3cx_24h = b.length;
        const lista = cxNormalizar(b); r.chamadas_dos_ramais_cadastrados_24h = lista.filter((l) => !ips.size || ips.has(l.ip)).length;
        r.ramais_vistos_no_3cx = [...new Set(lista.map((l) => l.ip))].slice(0, 15); } catch (e) { r.erro_chamadas = e.message; }
    } else {
      r.avisos_recebidos_desde_o_boot = diag.recebidos; r.avisos_aceitos = diag.aceitos;
      r.ips_ignorados_nao_cadastrados = Object.fromEntries(diag.ignorados);
      r.ultimo_aviso = diag.ultimo;
      r.chamadas_abertas_agora = (await store.listAbertas()).length;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(r, null, 2));
  }

  if (p === "/api/ativas") {                        // ligações em andamento neste momento
    const ips = lerIps();
    let lista = [], erro = "";
    try { lista = CX_ON ? await cxAtivas() : await ativasYealink(); } catch (e) { erro = e.message; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ativas: lista.map((l) => ({ ...l, nome: ips.get(l.ramal) || "" })), agora: Date.now(), erro }));
  }

  if (p === "/api/3cx-ativas-teste") {              // mostra o que o 3CX devolve de chamadas ativas (para conferir)
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    if (!CX_ON) return res.end(JSON.stringify({ ok: false, erro: "Faltam CX_URL, CX_CLIENT_ID e CX_SECRET no Render" }));
    try {
      const bruto = await cxAtivasBruto();
      return res.end(JSON.stringify({ ok: true, ativas_agora: bruto.length, amostra: bruto.slice(0, 3) }, null, 2));
    } catch (e) { return res.end(JSON.stringify({ ok: false, erro: e.message })); }
  }

  if (p.startsWith("/api/")) { const r = await rotasApi(req, res, u, p); if (r !== null) return; }

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
    const f = filtrosHistorico(u, lerIps());
    const todas = (await store.buscar({ ...f, limite: 1000000, offset: 0 })).itens.reverse();
    todas.forEach((l) => (out += linhaCsv([fmt(l.inicio), l.ip, l.direcao === "saida" ? "Feita" : "Recebida", l.numero, l.status, l.duracaoSeg])));
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ligacoes.csv"' });
    return res.end(out);
  }

  if (p === "/api/painel") {
    const linhas = await resumo(de, ate);
    const ips = lerIps();
    const ramal = (u.searchParams.get("ramal") || "").trim();       // se vier, mostra o histórico completo daquele ramal
    const lista = (await listarLigacoes(de, ate, ramal || undefined)).filter((l) => !ips.size || ips.has(l.ip));
    const recentes = lista.slice(ramal ? -500 : -20).reverse().map((l) => ({
      quando: fmt(l.inicio), ip: l.ip, nome: ips.get(l.ip) || "", direcao: l.direcao, numero: l.numero, status: l.status, seg: l.duracaoSeg,
    }));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ linhas, recentes, atualizado: fmt(Date.now()),
      armazenamento: CX_ON ? "3CX → " + store.nome : store.nome,
      ramal: ramal ? { ramal, nome: ips.get(ramal) || "" } : null,
      sync: CX_ON ? { ultima: cxSync.ultima ? fmt(cxSync.ultima) : "", erro: cxSync.erro } : null }));
  }

  res.writeHead(404, CORS); res.end("nao encontrado");
}

(async () => {
  await store.init();
  setInterval(async () => {
    try { for (const [k, c] of await store.abertasAntigas(EXPIRA_MS)) await enfileirar(() => finalizar(k, c, c.ultimo)); } catch (e) { console.error(e.message); }
  }, 10 * 60 * 1000);
  http.createServer((req, res) => atender(req, res).catch((e) => { console.error(e); res.writeHead(500); res.end("erro"); }))
    .listen(PORTA, () => console.log(`Rodando na porta ${PORTA}. Armazenamento: ${store.nome}. Token: ${TOKEN ? "ligado" : "DESLIGADO"}`));
  if (CX_ON) {
    cxCicloSync(true);                                           // 1ª sincronização em segundo plano
    setInterval(() => cxCicloSync(false), CX_SYNC_MIN * 60 * 1000);
  }
})();
