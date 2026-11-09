// RELAY LOCAL - roda num PC/servidor ligado da rede 10.1.99.x.
// Recebe o aviso do telefone Yealink por HTTP simples (que todo Yealink aceita) e repassa ao Render por HTTPS,
// com fila e nova tentativa (se o Render estiver "dormindo" ou sem internet, o aviso não se perde).
// Não usa API do 3CX e não precisa instalar nada além do Node.js 18+.
const http = require("http");
const fs = require("fs");
const path = require("path");

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "relay.config.json"), "utf-8")); } catch (e) {}
const RENDER_URL = (process.env.RENDER_URL || cfg.render_url || "").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || cfg.token || "";
const PORTA = Number(process.env.RELAY_PORT || cfg.porta || 8090);
if (!RENDER_URL || !TOKEN) { console.error("Preencha render_url e token no arquivo relay.config.json"); process.exit(1); }

const st = { recebidos: 0, enviados: 0, tentativas_falhas: 0, descartados: 0, ultimo: null, ultimo_erro: "" };
const fila = [];
let enviando = false;
const hora = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function processar() {
  if (enviando) return;
  enviando = true;
  while (fila.length) {
    const item = fila[0];
    const url = `${RENDER_URL}/evento?t=${encodeURIComponent(TOKEN)}&${item.qs}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(80000) });   // 80s: dá tempo do Render acordar
      if (r.status === 401) throw new Error("senha (token) recusada pelo Render");
      if (!r.ok) throw new Error("Render respondeu " + r.status);
      fila.shift(); st.enviados++;
      console.log(`[${hora()}] enviado: ${item.resumo}`);
    } catch (e) {
      st.tentativas_falhas++; st.ultimo_erro = e.message; item.tentativas++;
      console.log(`[${hora()}] falha (${item.tentativas}): ${e.message}`);
      if (item.tentativas >= 12) { fila.shift(); st.descartados++; continue; }
      await dorme(Math.min(5000 * item.tentativas, 60000));
    }
  }
  enviando = false;
}

function enfileirar(qs, resumo) {
  if (fila.length >= 2000) { fila.shift(); st.descartados++; }
  fila.push({ qs, resumo, tentativas: 0 });
  processar();
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const ipSocket = (req.socket.remoteAddress || "").replace("::ffff:", "");
  const texto = (code, t, tipo) => { res.writeHead(code, { "Content-Type": tipo || "text/plain; charset=utf-8" }); res.end(t); };

  if (u.pathname === "/status") {
    return texto(200, JSON.stringify({ ...st, na_fila: fila.length, render: RENDER_URL, agora: hora() }, null, 2), "application/json; charset=utf-8");
  }
  if (u.pathname === "/" || u.pathname === "/saude") return texto(200, "relay ok");

  if (u.pathname === "/evento" || u.pathname === "/e") {
    st.recebidos++;
    const q = u.searchParams;
    let ip = (q.get("ip") || "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ip = ipSocket;          // se a variável $ip não veio preenchida, usa o IP de quem chamou
    const ev = q.get("evento") || "";
    let remoto = q.get("remoto") || "";
    if (remoto.startsWith("$")) remoto = "";                          // variável não substituída pelo telefone
    let callid = q.get("callid") || "";
    if (callid.startsWith("$")) callid = "";
    const qs = new URLSearchParams({ ip, evento: ev, remoto, callid, ts: String(Date.now()) }).toString();
    const resumo = `ip=${ip} evento=${ev} remoto=${remoto}`;
    st.ultimo = { quando: hora(), ip, evento: ev, remoto, de: ipSocket };
    console.log(`[${hora()}] telefone ${ipSocket} avisou: ${resumo}`);
    enfileirar(qs, resumo);
    return texto(200, "ok");
  }
  texto(404, "nao encontrado");
}).listen(PORTA, "0.0.0.0", () => {
  console.log(`Relay rodando na porta ${PORTA}. Repassando para ${RENDER_URL}`);
  console.log(`Teste no navegador: http://localhost:${PORTA}/status`);
});

// Mantém o Render acordado (substitui o UptimeRobot)
const ping = () => fetch(RENDER_URL + "/saude", { signal: AbortSignal.timeout(80000) }).catch(() => {});
ping(); setInterval(ping, 4 * 60 * 1000);
