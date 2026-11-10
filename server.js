// Painel (PC): /     App do atendente (celular): /app.html
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Defina TOKEN, SUPABASE_URL e SUPABASE_SERVICE_KEY.'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OPC = path.join(__dirname, 'opcoes.json');
const app = express(), server = http.createServer(app), wss = new WebSocketServer({ server });
const avisar = (c) => wss.clients.forEach(w => w.readyState === 1 && w.send(JSON.stringify(c)));
const auth = (q, r, n) => q.get('x-token') === TOKEN ? n() : r.status(401).json({ erro: 'senha inválida' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (q, r) => r.send('ok'));
app.get('/api/opcoes', auth, (q, r) => r.json(JSON.parse(fs.readFileSync(OPC))));
app.get('/api/chamadas', auth, async (q, r) => {
  const { data, error } = await sb.from('chamadas').select('*').order('data', { ascending: false }).limit(500);
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
app.post('/api/chamadas', auth, async (q, r) => {
  const { uid, numero, atendente, data, qualificacao, observacao } = q.body;
  if (!JSON.parse(fs.readFileSync(OPC)).includes(qualificacao)) return r.status(400).json({ erro: 'qualificação inválida' });
  const linha = { uid: uid || null, numero: numero || '', atendente, data: data || new Date().toISOString(), qualificacao, observacao: observacao || '' };
  const { data: c, error } = await sb.from('chamadas').upsert(linha, { onConflict: 'uid' }).select().single(); // reenvio com o mesmo uid não duplica
  if (error) return r.status(500).json({ erro: error.message });
  avisar(c); r.json(c);
});
server.listen(process.env.PORT || 3000, () => console.log('Servidor no ar'));
