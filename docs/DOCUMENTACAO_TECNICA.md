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
- **SMS Market** — envio de comando em massa aos rastreadores.
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
- Versões de `google-cloud-firestore`, `google-api-core`, `grpcio`,
  `google-auth` e `protobuf` estão **fixadas deliberadamente** em
  `requirements.txt` — uma atualização automática dessas libs já quebrou
  produção com erro "Invalid database id (default)". Não atualizar essas
  libs sem testar a aplicação de ponta a ponta.
