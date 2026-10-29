# Documentação Técnica

> Arquitetura, stack e padrões técnicos. Ver `DOCUMENTACAO_CENTRAL_PROJETO.md`
> para o propósito do sistema e `docs/DOCUMENTACAO_FUNCIONAL.md` para as
> regras de negócio por módulo.

## Stack

- **Backend**: Python + Flask, monolito em `app.py` (rotas) com módulos
  auxiliares por responsabilidade (`conversor_*.py`, `validador_importacao/`,
  `auditoria.py`, `db_sql.py`, `planilha_migracao.py`, `conversorkml.py`).
- **Frontend**: uma única SPA server-rendered — `templates/index.html`
  (seções por `id`, mostradas/escondidas via JS) + `static/script.js`
  (JavaScript puro, sem framework). Não usar um framework de frontend aqui
  sem decisão explícita — é um padrão deliberado deste projeto.
- Existe um componente Angular isolado (`standalone-kml-converter/`) fora
  deste padrão — não faz parte do fluxo normal da aplicação, não acoplar
  funcionalidades novas a ele sem necessidade.
- **Deploy de produção**: Render, via `gunicorn`.

## Dados: dois bancos, dois papéis diferentes

- **Firestore** (`firebase-admin`) é a fonte principal de dados hoje:
  clientes, tarefas, credenciais, usuários da ferramenta (`app_usuarios`),
  feed, modelos de rastreador/comando, etc.
- **Banco relacional** (Postgres em produção / SQLite local em dev, via
  SQLAlchemy + Alembic — `models.py`, `db_sql.py`) roda **em paralelo**, só
  para:
  - `log_auditoria` + `log_auditoria_mudanca`: log de auditoria imutável.
  - `historico_cliente`: timeline curada do cliente.
  - `usuarios`: modelo já pronto para os logins da ferramenta, mas **ainda
    não ativo** — `app.py` continua lendo/escrevendo login em
    `app_usuarios` no Firestore até o Postgres do servidor da empresa
    existir em produção (hoje produção é só Render, sem Postgres
    provisionado lá).
- Os IDs entre os dois bancos (`cliente_id`, `usuario_id`, `tarefa_id`) são
  referências soltas (string), não FK de verdade — FK real só existe dentro
  do próprio banco relacional.
- Arquivo anexado (foto de perfil, documentos do cliente) fica em base64 numa
  **tabela própria** (`usuario_foto`, `cliente_documentos`), nunca como coluna
  na tabela principal (`usuarios`, `clientes`) — assim listar/buscar o
  registro principal não carrega o blob, só quem busca o anexo em si paga
  esse custo. FK de verdade (`ON DELETE CASCADE`) liga o anexo ao registro
  principal.
- `DATABASE_URL` não definida → cai para SQLite local (`local_dev.db`), sem
  exigir infraestrutura para rodar/testar localmente.

## Autenticação (duas camadas, não confundir)

1. **Login da ferramenta** (`app_usuarios`/`usuarios`): quem pode usar este
   sistema internamente, com perfil (`adm`/`analista`/`visualizacao`) e área
   (`CS`/`Treinamento`/`Suporte`/`Comercial`).
2. **Credencial SSX do cliente**: sessão/login na plataforma de rastreamento
   real (`BASE_URL = https://integration.systemsatx.com.br`), usada para
   autenticar operações (importação, consulta, comando) em nome de uma
   central específica.

## Integrações externas

- **API da SSX** (`BASE_URL`) — importação de cadastros, consultas,
  autenticação em nome do cliente.
- **Verificação de comunicação na Migração** — as listas de unidades
  monitoradas/desatualizadas são cruzadas pelo `IdTracker` (`Tracker` na
  resposta da SSX), diretamente com `id_equipamento` da ficha, sem usar
  `TrackerIntegrationCode` nem placa. Veículos sem `id_equipamento` não são
  correspondidos ou confirmados; confirmações históricas desses registros
  também são limpas ao recalcular a lista. Cada lista é consultada uma vez por
  verificação.
- **Timeouts de consultas SSX em migrações grandes** — Vehicle/List,
  Tracker/ListTrackerModel e as duas listas de comunicação usam timeout de
  leitura de 120 segundos e uma repetição em falha de rede ou gateway
  transitório (502/503/504). Outros endpoints mantêm o timeout padrão de 20
  segundos. A tela informa que a operação pode levar alguns minutos, limita o
  polling a 10 minutos e os jobs registram erros inesperados para não ficarem
  presos em `rodando`.
- **Sincronização de veículos SSX** — consulta `Vehicle/List` e
  `Tracker/ListTrackerModel`; resolve `IdModelTracker` para `TrackerModel` e
  grava o nome retornado no campo local `equipamento`. Para veículos sem
  código de integração, usa a placa como último critério para casar registros
  já existentes. Prévia e resultado ficam em `migracao_ssx_sync_jobs` por até
  sete dias, em vez de depender da memória do processo; aplicar a prévia e
  marcá-la como aplicada ocorre na mesma transação e é idempotente. A tela
  limita a 50 detalhes de cada tipo, mantendo os totais completos.
- **Planilha de veículos** — a listagem não recalcula nem grava a migração
  durante um GET. A interface mantém os dados para busca/filtros, mas monta
  somente 100 linhas por página para evitar milhares de controles no DOM.
- **Contagem da Migração** — `migracoes_sql.normalizar_status_veiculo`
  define `Sem rastreador` quando `id_equipamento` está vazio (e retorna para
  `Aguardando` ao preencher o ID, exceto quando o status é `Cancelado`).
  `Sem rastreador` e `Cancelado` são excluídos dos totais e percentuais; as
  linhas permanecem armazenadas e disponíveis na tabela.
- **SMS Market** — envio de comando em massa aos rastreadores.
- **API de Integrações do ssxdesk** (`ssxdesk_api.py`) — chamados de suporte
  do cliente, buscados pelo IdCentral (bloco "Chamados abertos" na Visão
  Geral da Ficha + sub-aba Suporte do Histórico). Chave fixa
  (`SSXDESK_API_KEY`, Bearer token), gerada em
  ssxdesk.ssatx.com.br/settings — não por usuário. Carregado pelo front em
  segundo plano, DEPOIS da Ficha já estar renderizada (rota
  `/api/clientes/<id>/chamados`): uma falha ou lentidão dessa API externa
  nunca pode atrasar a abertura da Ficha. IdCentral não é um filtro direto
  da API nem é único do lado do ssxdesk (duas empresas podem compartilhar o
  mesmo IdCentral) — o módulo resolve isso buscando todas as empresas
  (`GET /companies`, cacheado 10 min em processo) e casando pelo IdCentral
  antes de buscar os chamados (`GET /tickets?companyId=...`).
- **API REST da Wootric** (`wootric_api.py` + `wootric_sql.py`) — avaliações
  de NPS do cliente (bloco "Avaliações NPS" na Visão Geral da Ficha +
  eventos sintéticos de setor "NPS" na Timeline/Detalhado do Histórico, ver
  `construirEventosSinteticosWootric` em script.js). Autenticação OAuth
  `client_credentials` (`WOOTRIC_CLIENT_ID`/`WOOTRIC_CLIENT_SECRET`, token
  Bearer cacheado em processo, ~2h de validade).

  **Persistido em tabela própria** (`wootric_avaliacoes`, ver models.py) —
  a Ficha NUNCA chama a API da Wootric na hora de abrir a tela
  (`/api/clientes/<id>/wootric` só lê do Postgres, instantâneo); quem
  alimenta a tabela é uma sincronização incremental que roda em thread de
  fundo, disparada (sem bloquear) toda vez que alguém abre uma Ficha, no
  máximo 1x a cada 5 min por worker do gunicorn (ver
  `_disparar_sync_wootric_em_segundo_plano`/`sincronizar_avaliacoes_wootric`
  em app.py). Isso substituiu uma abordagem anterior que consultava a
  Wootric ao vivo a cada Ficha aberta (varredura de `/v1/end_users`,
  7-8s mesmo com cache) — ver `docs/HISTORICO_DECISOES.md`.

  IdCentral: nesta conta Wootric (confirmado consultando a API diretamente —
  mesma conta usada pelo projeto irmão `kanban_dashboard_dev`), o end_user
  NÃO tem `external_id` preenchido — o IdCentral vem no final do e-mail do
  end_user (ex. `"(SSX) contato@dominio.com - 997"`), igual ao mecanismo de
  `centralIdFromEmail` em `kanban_dashboard_dev` (`server/wootric.ts`). Esse
  código bate com `Cliente.codigo_idcentral` (mesmo fallback
  `codigo_idcentral` → `idcentral` da integração ssxdesk), não
  necessariamente com `Cliente.idcentral`.

  Sincronização via `GET /v1/responses` — diferente de `/v1/end_users`, essa
  rota já devolve o end_user (com e-mail) embutido em cada resposta, então
  não precisa varrer toda a base de end_users pra achar o IdCentral de cada
  avaliação. Incremental com cursor (`created[gte]`, timestamp da avaliação
  mais recente já salva, com 5 min de folga): cada rodada normal busca só
  o que mudou, rápido, nunca esbarra em limite de paginação. **Carga
  inicial** (tabela vazia): sem cursor, busca em ordem **decrescente**
  (mais recentes primeiro) até o teto documentado de 30 páginas/1500
  respostas da API — ordem importa aqui: a primeira versão trazia em ordem
  crescente (mais antigas primeiro) e, numa conta com anos de histórico,
  nunca chegava nas avaliações recentes dentro do teto de 1500 (bug real,
  corrigido antes de ir pra produção — ver `docs/HISTORICO_DECISOES.md`).
  **Limitação que continua existindo:** histórico mais antigo que as 1500
  respostas mais recentes da conta inteira nunca é importado — resolver de
  verdade exigiria paginação por outro eixo (ex. por end_user) ou backfill
  manual; não é um problema no dia a dia porque a sincronização incremental
  mantém tudo que importa (o que é recente) sempre em dia.
- **Google Sheets/Drive API** (`planilha_migracao.py`) — geração/leitura da
  planilha de migração por cliente. Reusa a mesma credencial de service
  account do Firebase (`FIREBASE_CREDENTIALS_JSON`), só com escopo próprio.
  Módulo independente: não importa nada de `app.py`, para não criar import
  circular quando `app.py` vier a importar este módulo.

## Padrão dos Conversores

Cada tipo de cadastro (`clientes`, `veiculos`, `rastreadores`, `simcards`,
`areas`, `uo`) tem:

- Um módulo `conversor_<tipo>.py` com a lógica de transformação/validação.
- Um conjunto padronizado de rotas
  `/api/conversor-<tipo>/{campos,upload,mapear,usar-como-upload,editar,
  excluir-linha,adicionar-linha,limpar-vazias,transformar,validar,
  verificar-duplicidade,exportar}`.
- Um módulo de regras em `validador_importacao/tipo_<tipo>.py`, reutilizado
  pelo Validador de Planilha de Importação.

Ao criar um novo conversor (ex.: quando Viagens/Abastecimento/Colaboradores
saírem de "em construção"), seguir este mesmo padrão de rotas e separação de
responsabilidade — é o que mantém os conversores consistentes entre si (ver
princípio 6 da Documentação Central: interface consistente, sem reinventar
fluxo a cada tela nova).

## Jobs longos / timeout do Render

Importações e envios em massa (comando, exportação) rodam em **thread de
fundo com polling de status** (`/api/.../status/<job_id>`), em vez de manter
a requisição HTTP aberta — evita timeout da plataforma de deploy em
operações demoradas.

## Ambiente de desenvolvimento local

- `dev_offline_preview.py` sobe o Flask com um Firestore **falso** em
  memória — serve para testar layout/fluxo de tela sem gastar cota real do
  Firestore nem depender de credencial de produção.
- `app.config["TEMPLATES_AUTO_RELOAD"] = True` — template é relido do disco
  a cada mudança, para não exigir reiniciar o servidor a cada ajuste de
  tela em dev.

## Scripts de migração de dados (uso único, não rotineiro)

- `migrar_clientes.py` — copia `implantacao_clientes` para `clientes`
  (cópia aditiva, idempotente, não apaga a coleção antiga).
- `migrar_migracao_para_clientes.py` — move `migracao_clientes` para dentro
  de `clientes/<id>/migracoes/<id>`.
- `migrar_usuarios_para_postgres.py` — migra login de `app_usuarios`
  (Firestore) para `usuarios` (Postgres). **Não rodar em produção** até o
  Postgres do servidor da empresa existir.
- `limpar_migracao_orfa.py` — **ação destrutiva real**: apaga da coleção
  antiga `migracao_clientes` os registros sem `idcentral` correspondente em
  `clientes`. Só atinge órfãos; nunca roda sem conferência prévia.

Esses scripts documentam fases de uma reestruturação de dados já aplicada
(ver `docs/HISTORICO_DECISOES.md`) — não são parte do fluxo normal da
aplicação.

## Observações de infraestrutura

- `FIREBASE_CREDENTIALS_JSON` é obrigatória (conteúdo da service account,
  via variável de ambiente — não arquivo), tanto local quanto em produção.
- `SSXDESK_API_KEY` é opcional: sem ela, o bloco de chamados da Ficha
  simplesmente mostra "não foi possível carregar" (ver `ssxdesk_api.py`) —
  não derruba o resto do app.
- `WOOTRIC_CLIENT_ID`/`WOOTRIC_CLIENT_SECRET` são opcionais, mesmo padrão:
  sem elas, o bloco "Avaliações NPS" da Ficha mostra "não foi possível
  carregar" (ver `wootric_api.py`) — não derruba o resto do app.
- Versões de `google-cloud-firestore`, `google-api-core`, `grpcio`,
  `google-auth` e `protobuf` estão **fixadas deliberadamente** em
  `requirements.txt` — uma atualização automática dessas libs já quebrou
  produção com erro "Invalid database id (default)". Não atualizar essas
  libs sem testar a aplicação de ponta a ponta.
