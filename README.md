# BALANCE360 — 360° Digital Intelligence
**VeyharCorp · Harvey Aquino**

Auditoría inteligente de productos digitales para empresas grandes en Latinoamérica.
Analiza app, web, redes sociales, reviews y Google Business con IA.

---

## Deploy en 3 pasos

### PASO 1 — Supabase

1. Ir a [supabase.com](https://supabase.com) → New project
2. Ir a **SQL Editor** → pegar y ejecutar todo el contenido de `supabase/schema.sql`
3. Ir a **Settings > API** y copiar:
   - `Project URL` → será `SUPABASE_URL` y `VITE_SUPABASE_URL`
   - `anon public` key → será `VITE_SUPABASE_ANON_KEY`
   - `service_role` key → será `SUPABASE_SERVICE_ROLE_KEY` (**solo en backend**)

---

### PASO 2 — GitHub

```bash
# Clonar / descomprimir el zip, entrar al directorio
cd balance360

# Inicializar repo
git init
git add .
git commit -m "feat: BALANCE360 v0.3.0 inicial"

# Crear repo en github.com → copiar la URL y hacer push
git remote add origin https://github.com/harveyaquino/balance360.git
git branch -M main
git push -u origin main
```

---

### PASO 3 — Vercel

1. Ir a [vercel.com](https://vercel.com) → **Add New Project**
2. Importar el repo de GitHub `harveyaquino/balance360`
3. En **Environment Variables** agregar estas 5 variables:

| Variable | Valor | Entorno |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Production, Preview |
| `SUPABASE_URL` | `https://xxx.supabase.co` | Production, Preview |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Production, Preview |
| `VITE_SUPABASE_URL` | `https://xxx.supabase.co` | Production, Preview |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | Production, Preview |

4. Click **Deploy** → listo

> `ALLOWED_ORIGIN` es opcional. Si no lo configuras, acepta cualquier origen (ok para MVP).
> Para producción, agrégala con el valor `https://balance360.vercel.app` (tu dominio real).

---

## Dev local

```bash
npm install

# Crear archivo de variables locales
cp .env.example .env.local
# Editar .env.local con tus keys reales

npm run dev
# → http://localhost:5173
```

---

## Seguridad — checklist antes de cada deploy

- [ ] `.env.local` no está commiteado (revisar `.gitignore`)
- [ ] `npm audit` sin vulnerabilidades críticas
- [ ] `SUPABASE_SERVICE_ROLE_KEY` no está en variables `VITE_*`
- [ ] Rate limiting activo en `api/analyze.js`
- [ ] RLS activo en Supabase (verificar en Authentication > Policies)

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + Vite + Tailwind CSS |
| IA | Claude Sonnet (Anthropic API + web search) |
| Serverless | Vercel Functions |
| Base de datos | Supabase (PostgreSQL + Auth) |
| Deploy | GitHub + Vercel (CI/CD automático) |
| Seguridad | DOMPurify, CSP headers, RLS, rate limiting |

---

## Estructura del proyecto

```
balance360/
├── api/
│   └── analyze.js          ← serverless: sanitización, cache, Claude API
├── src/
│   ├── App.jsx             ← UI principal
│   ├── components/
│   │   ├── ScoreRing.jsx   ← visualización del BALANCE Score
│   │   ├── FrenteCard.jsx  ← cada dimensión analizada
│   │   └── AgentSteps.jsx  ← thinking steps del agente
│   ├── hooks/
│   │   └── useArgos.js     ← lógica + sanitización cliente
│   ├── lib/
│   │   ├── supabase.js     ← cliente Supabase
│   │   └── db.js           ← helpers de base de datos
│   └── styles/global.css   ← design tokens BALANCE360
├── supabase/
│   └── schema.sql          ← ejecutar en Supabase SQL Editor
├── .env.example            ← template de variables
├── vercel.json             ← security headers + config functions
└── CAMBIOS.txt             ← changelog
```

---

Creado por [Harvey Aquino](https://www.linkedin.com/in/harveyaquinomas/) · VeyharCorp
