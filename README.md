# Ligações

Discador para celular com qualificação da chamada (1 Sangria, 2 Fechamento de caixa, 3 Apoio de cópia) e dashboard em página separada. Instalável no celular (PWA), com dados no Supabase e hospedagem no Render.

- `web/index.html`: discador (abre o discador do celular com o número digitado)
- `web/dashboard.html`: dashboard em tempo real
- `supabase/schema.sql`: tabela, regras de acesso e tempo real
- `render.yaml` e `build.sh`: publicação no Render

## 1. Supabase

1. Crie um projeto em supabase.com.
2. Abra **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Abra **Authentication > Users > Add user**, informe e-mail e senha e marque **Auto Confirm User**. Esse é o login do app.
4. Em **Authentication > Sign In / Providers**, desligue **Allow new users to sign up**, para que ninguém crie conta sozinho.
5. Em **Project Settings > API**, copie a **Project URL** e a chave **anon public**.

A chave anon pode ficar no site. Quem protege os dados são as regras de acesso do `schema.sql`: só usuários logados leem, criam e apagam ligações.

## 2. Render

1. Envie esta pasta para um repositório no GitHub.
2. No Render: **New > Blueprint**, escolha o repositório. O `render.yaml` cria o site estático.
3. Preencha as variáveis `SUPABASE_URL` e `SUPABASE_ANON_KEY` com os valores do passo anterior.
4. Aguarde o deploy. O endereço será algo como `https://ligacoes.onrender.com`.

Sem Blueprint: crie um **Static Site**, com **Build Command** `sh build.sh`, **Publish Directory** `public` e as duas variáveis de ambiente.

## 3. No celular

- Discador: `https://SEU-SITE.onrender.com/`
- Dashboard: `https://SEU-SITE.onrender.com/dashboard.html`

No Android (Chrome), toque em **Instalar atalho no celular** e confirme. No iPhone (Safari), use **Compartilhar > Adicionar à Tela de Início**. A instalação exige HTTPS, que o Render já fornece.

## Como a chamada é medida

O app abre o discador do celular. Ele não enxerga a ligação: a duração é o tempo em que o app ficou em segundo plano, e quem informa se a chamada foi atendida é a pessoa, na qualificação (0 = não atendida). Para medir a duração exata seria preciso um serviço de telefonia (Twilio, por exemplo).

## Testar sem Supabase

Com `web/config.js` vazio, o app guarda os dados no navegador. Rode `curl -fsSL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js -o web/supabase.min.js` e sirva a pasta `web` com `python3 -m http.server`.
