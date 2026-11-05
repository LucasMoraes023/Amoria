# Pendências reais

O que **depende de você ou de serviços externos**, e o que **não foi verificado**. Nada aqui foi disfarçado de pronto.

## Ações suas (necessárias)

1. **Rodar as 3 migrações SQL no Supabase** (`CONFIGURACAO-SUPABASE.md`). Enquanto não rodar, o banco continua no modelo antigo e o app novo não funciona direito.
2. **Cadastrar as variáveis no Netlify** (`VARIAVEIS-DE-AMBIENTE.md`) e cadastrar o **webhook** no Mercado Pago (`CONFIGURACAO-NETLIFY.md`).
3. **Remover `amoria-completo.zip` do repositório** (não é mais publicado, mas não deve ficar versionado).
4. **Cadastrar `MP_WEBHOOK_SECRET`** (recomendado): sem ele a notificação não é assinada. O pagamento continua seguro porque o servidor sempre consulta a API antes de liberar.
5. **Confirmar o preço inicial do QR padrão (R$ 2,99)** em *Admin → Preços e acesso*.
6. **Definir seu administrador principal** se ainda não estiver (`CONFIGURACAO-SUPABASE.md`, seção 5).

## Não verificado (exige ambiente externo ou aparelho)

- **Pagamento real no Mercado Pago:** nenhuma transação real foi feita. Todo o fluxo foi testado com um simulador. Roteiro seguro em `INSTRUCOES-DE-IMPLANTACAO.md`, seção 7 (somente com a sua autorização).
- **Cadastro, login, logout e recuperação de senha reais** (dependem do Supabase Auth e de e-mail).
- **Upload de fotos e de vídeos, e reprodução de vídeo** (dependem do Storage e do navegador). Limites reais: foto JPEG 2 MB, vídeo MP4/WebM 25 MB, áudio 8 MB.
- **IA com provedores reais:** exige `ANTHROPIC_API_KEY` e `OPENAI_API_KEY`, e a IA nasce desligada (liga em *Admin → IA*). O modelo de imagem precisa entregar JPEG (modelos `gpt-image`; a OpenAI pode pedir verificação da organização). Os nomes de modelo são configuráveis; confira a disponibilidade na documentação do provedor.
- **Aparência no Android:** layout, toque, fontes e rolagem não foram vistos em aparelho. O desenho do QR foi testado em canvas de teste (Node), não no navegador do celular.
- **A CSP nova** (cabeçalho de segurança) não foi exercitada em navegador real. Se a tela ficar em branco, veja o plano de reversão em `CONFIGURACAO-NETLIFY.md`.
- **O estado do seu banco de produção:** não tive acesso. As migrações checam pré-requisitos e o painel mostra o que foi aplicado.

## Riscos residuais conhecidos

- **S15:** visualizações anônimas sem limite (a tabela `experience_views` cresce a cada visita) e sem cota de armazenamento por usuário. Acompanhe o uso do Supabase; se necessário, o próximo passo é limitar por IP/dia ou usar contagem agregada.
- **Contas descartáveis:** cada conta nova ganha 3 usos do AMORIA1. Ligue "Confirm email" (e CAPTCHA, se houver abuso).
- **QR gerado no navegador:** ver decisão 7 em `CORRECOES-REALIZADAS.md`.
- **Webhook sem segredo** até o item 4 acima.

## Funcionalidades parcialmente concluídas ou não implementadas

- **Estorno iniciado pelo app:** não existe botão. O estorno feito no painel do Mercado Pago chega pelo webhook e revoga o download (testado com simulador). Estorno parcial não é tratado.
- **Prazo de expiração do Pix:** usa o padrão do Mercado Pago (o app não define um prazo próprio). Pix expirado é tratado e abre nova cobrança.
- **Relatórios:** indicadores e CSV básicos (sem gráficos por período).
- **Posição livre do QR na arte:** o Estúdio escolhe a posição pelo modelo; foi adicionado ajuste de **tamanho**, não de arrastar livremente.
- **Geração em lote de códigos** (muitos códigos de uma vez): não existe; cada código é criado individualmente.
