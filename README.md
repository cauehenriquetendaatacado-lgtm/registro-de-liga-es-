# Painel de chamadas

Atendente qualifica a ligação (Sangria, Caixa central ou Apoio de cópia) pelo app web no celular; o painel no PC atualiza ao vivo.

- Painel (PC): `https://SEU-APP.onrender.com/`
- App do celular: `https://SEU-APP.onrender.com/app.html` (instalar pelo menu do Chrome)

## Publicar
1. **GitHub:** crie um repositório vazio e envie este código (comandos abaixo).
2. **Supabase:** crie um projeto, abra *SQL Editor* e rode `supabase.sql`. Em *Project Settings > API*, copie a **Project URL** e a chave **service_role**.
3. **Render:** *New > Blueprint*, escolha o repositório (ele lê `render.yaml`) e preencha `TOKEN`, `SUPABASE_URL` e `SUPABASE_SERVICE_KEY`.

```
git remote add origin https://github.com/SEU-USUARIO/painel-chamadas.git
git push -u origin main
```

## Rodar local
```
cp .env.example .env   # preencha
npm install
node --env-file=.env server.js
```

## Mudar as opções
Edite `opcoes.json` e faça deploy. O app e o painel passam a usar a nova lista.
