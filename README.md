# AMORIA — Transforme sentimentos em memórias

Aplicativo para criar experiências românticas (declarações, cartas, fotos, vídeos e música) e compartilhá-las por link ou por **QR Code**.
Criado por **Lucas Moraes**.

## Modelo comercial (definitivo)

| Ação | Custo |
|---|---|
| Criar, editar, salvar, publicar e compartilhar o link | **Grátis, sempre** |
| Baixar o QR Code padrão (PNG, JPG ou PDF) | Pago (Pix) ou liberado por código |
| Baixar o QR Code personalizado (arte com fotos, moldura, cores) | Pago (Pix) ou liberado por código |
| Código de cortesia válido | Grátis, dentro dos limites do código |

- A prévia da arte do QR é grátis; o **arquivo** só é entregue com a liberação confirmada **pelo servidor**.
- Os preços são definidos no painel (**Admin → Preços e acesso**), em um único lugar. O código-fonte não tem valores.
- **Cortesia só existe por código.** Não há liberação manual por e-mail nem confirmação manual de pagamento.
- O código **AMORIA1** já vem configurado: 3 liberações grátis por usuário (QR padrão ou personalizado).
- 1 uso do código = 1 QR liberado (uma experiência e um tipo de QR). Depois de liberado, o mesmo QR pode ser baixado de novo quantas vezes quiser. O personalizado inclui o padrão.

## Como funciona (resumo técnico)

- **Site:** `index.html` + `app.js` (sem CDN; bibliotecas fixas em `vendor/`).
- **Banco e login:** Supabase (Postgres com RLS, Auth, Storage). A lógica de preço, códigos, pedidos e liberações fica no banco.
- **Servidor:** Netlify Functions em `netlify/functions` (pagamento Pix pelo Mercado Pago, webhook, IA, status do painel).
- **Pagamento:** só Pix do Mercado Pago. Um pagamento só vale quando o Mercado Pago confirma ao servidor (webhook + consulta direta à API). Voltar para a página de sucesso não libera nada.
- **Build:** `node scripts/build.js` monta `dist/` com **somente** os arquivos públicos. SQL, funções, testes e documentos nunca vão para o site.

## Pastas

```
index.html, app.js, config.js   site
sw.js, manifest.webmanifest      app instalável / offline
vendor/                          bibliotecas com versão fixa
scripts/build.js                 monta dist/
netlify/functions, netlify/lib   servidor (Functions)
supabase/                        SQL legado (instalação nova)
supabase/migrations/             migrações novas (rode estas em banco existente)
tests/                           testes automatizados
backup-original/                 arquivos originais substituídos (para reverter)
```

## Documentação

- `INSTRUCOES-DE-IMPLANTACAO.md` — passo a passo pelo celular (comece por aqui)
- `CONFIGURACAO-SUPABASE.md` e `CONFIGURACAO-NETLIFY.md`
- `VARIAVEIS-DE-AMBIENTE.md` (modelo em `variaveis-exemplo.txt`, sem segredos)
- `RELATORIO-DE-AUDITORIA.md`, `CORRECOES-REALIZADAS.md`
- `PENDENCIAS-REAIS.md` — o que depende de você ou de serviços externos

## Testes

```
cd tests
npm install
npm test
```

Precisa de Node 20+. Os testes de SQL precisam de um PostgreSQL 15+ (variável `AMORIA_PG`, por exemplo `postgres://postgres@localhost:5432/postgres`); sem ele ficam **bloqueados** (nunca aprovados). Resultado desta versão: 130 aprovados, 0 reprovados.
