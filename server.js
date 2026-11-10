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
const limpa = (n) => String(n || '').replace(/[^\d+*#]/g, '');
const opcoes = () => JSON.parse(fs.readFileSync(OPC));
const auth = (q, r, n) => q.get('x-token') === TOKEN ? n() : r.status(401).json({ erro: 'senha inválida' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (q, r) => r.send('ok'));
app.get('/api/opcoes', auth, (q, r) => r.json(JSON.parse(fs.readFileSync(OPC))));
app.get('/api/chamadas', auth, async (q, r) => {
  const { data, error } = await sb.from('chamadas').select('*').order('data', { ascending: false }).limit(Math.min(+q.query.limite || 500, 5000));
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
// guarda no número (contato) a última qualificação; cria o contato se ainda não existir
async function registrarNoNumero(numero, nome, qualificacao, quando) {
  if (!numero || !qualificacao) return;
  const { data: ex } = await sb.from('contatos').select('id,atualizado').eq('numero', numero).maybeSingle();
  if (ex) {
    if (ex.atualizado && new Date(ex.atualizado) > new Date(quando)) return; // chamada antiga reenviada não sobrescreve a mais nova
    await sb.from('contatos').update({ qualificacao, atualizado: quando }).eq('id', ex.id);
  } else {
    await sb.from('contatos').insert({ nome: nome || numero, numero, qualificacao, atualizado: quando });
  }
}
app.post('/api/chamadas', auth, async (q, r) => {
  const { uid, numero, contato, atendente, data, qualificacao, observacao } = q.body;
  if (!opcoes().includes(qualificacao)) return r.status(400).json({ erro: 'qualificação inválida' });
  const linha = { uid: uid || null, numero: limpa(numero), contato: contato || '', atendente, data: data || new Date().toISOString(), qualificacao, observacao: observacao || '' };
  const { data: c, error } = await sb.from('chamadas').upsert(linha, { onConflict: 'uid' }).select().single(); // reenvio com o mesmo uid não duplica
  if (error) return r.status(500).json({ erro: error.message });
  await registrarNoNumero(linha.numero, linha.contato, qualificacao, linha.data).catch(() => {});
  avisar(c); r.json(c);
});

// ---- contatos compartilhados entre os atendentes ----
app.get('/api/contatos', auth, async (q, r) => {
  const { data, error } = await sb.from('contatos').select('id,nome,numero,qualificacao,atualizado').order('nome').limit(3000);
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
app.post('/api/contatos', auth, async (q, r) => {
  const lista = (Array.isArray(q.body) ? q.body : [q.body]).map(c => {
    const o = { nome: String(c.nome || '').trim(), numero: limpa(c.numero) };
    if (c.qualificacao && opcoes().includes(c.qualificacao)) { o.qualificacao = c.qualificacao; o.atualizado = new Date().toISOString(); }
    return o;
  }).filter(c => c.nome && c.numero);
  if (!lista.length) return r.status(400).json({ erro: 'informe nome e número' });
  const { error } = await sb.from('contatos').upsert(lista, { onConflict: 'numero' });
  error ? r.status(500).json({ erro: error.message }) : r.json({ ok: true, total: lista.length });
});
app.patch('/api/contatos/:id', auth, async (q, r) => {
  const up = {};
  if (typeof q.body.nome === 'string' && q.body.nome.trim()) up.nome = q.body.nome.trim();
  if ('qualificacao' in q.body) {
    if (q.body.qualificacao && !opcoes().includes(q.body.qualificacao)) return r.status(400).json({ erro: 'qualificação inválida' });
    up.qualificacao = q.body.qualificacao || null; up.atualizado = new Date().toISOString();
  }
  if (!Object.keys(up).length) return r.status(400).json({ erro: 'nada para atualizar' });
  const { data, error } = await sb.from('contatos').update(up).eq('id', q.params.id).select('id,nome,numero,qualificacao,atualizado').single();
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
// histórico de ligações de um número
app.get('/api/contatos/:id/chamadas', auth, async (q, r) => {
  const { data: c, error: e1 } = await sb.from('contatos').select('numero').eq('id', q.params.id).single();
  if (e1) return r.status(404).json({ erro: 'contato não encontrado' });
  const { data, error } = await sb.from('chamadas').select('id,data,atendente,qualificacao,observacao').eq('numero', c.numero).order('data', { ascending: false }).limit(200);
  error ? r.status(500).json({ erro: error.message }) : r.json(data);
});
app.delete('/api/contatos/:id', auth, async (q, r) => {
  const { error } = await sb.from('contatos').delete().eq('id', q.params.id);
  error ? r.status(500).json({ erro: error.message }) : r.json({ ok: true });
});
server.listen(process.env.PORT || 3000, () => console.log('Servidor no ar'));
