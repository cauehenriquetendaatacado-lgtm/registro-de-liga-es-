#!/bin/sh
# Monta a pasta public/ que o Render publica.
# Variáveis de ambiente (definidas no Render): SUPABASE_URL e SUPABASE_ANON_KEY.
set -e

rm -rf public
mkdir -p public
cp -r web/. public/

# Biblioteca do Supabase servida pelo próprio site (funciona offline depois de instalado).
curl -fsSL "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js" -o public/supabase.min.js

cat > public/config.js <<EOF
window.APP_CONFIG = { SUPABASE_URL: "${SUPABASE_URL}", SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}" };
EOF

echo "public/ pronto"
