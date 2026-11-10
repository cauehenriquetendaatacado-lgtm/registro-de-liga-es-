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
  const { data, error } = await sb.from('chamadas').select('*').order('data', { ascending: false }).limit(Math.min(+q.query.limite || 500, 5000));
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
app.post('/api/chamadas', auth, async (q, r) => {
  const { uid, numero, contato, atendente, data, qualificacao, observacao } = q.body;
  if (!JSON.parse(fs.readFileSync(OPC)).includes(qualificacao)) return r.status(400).json({ erro: 'qualificação inválida' });
  const linha = { uid: uid || null, numero: numero || '', contato: contato || '', atendente, data: data || new Date().toISOString(), qualificacao, observacao: observacao || '' };
  const { data: c, error } = await sb.from('chamadas').upsert(linha, { onConflict: 'uid' }).select().single(); // reenvio com o mesmo uid não duplica
  if (error) return r.status(500).json({ erro: error.message });
  avisar(c); r.json(c);
});

// ---- contatos compartilhados entre os atendentes ----
const limpa = (n) => String(n || '').replace(/[^\d+*#]/g, '');
app.get('/api/contatos', auth, async (q, r) => {
  const { data, error } = await sb.from('contatos').select('id,nome,numero').order('nome').limit(3000);
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
app.post('/api/contatos', auth, async (q, r) => {
  const lista = (Array.isArray(q.body) ? q.body : [q.body]).map(c => ({ nome: String(c.nome || '').trim(), numero: limpa(c.numero) })).filter(c => c.nome && c.numero);
  if (!lista.length) return r.status(400).json({ erro: 'informe nome e número' });
  const { error } = await sb.from('contatos').upsert(lista, { onConflict: 'numero' });
  error ? r.status(500).json({ erro: error.message }) : r.json({ ok: true, total: lista.length });
});
app.delete('/api/contatos/:id', auth, async (q, r) => {
  const { error } = await sb.from('contatos').delete().eq('id', q.params.id);
  error ? r.status(500).json({ erro: error.message }) : r.json({ ok: true });
});
server.listen(process.env.PORT || 3000, () => console.log('Servidor no ar'));
