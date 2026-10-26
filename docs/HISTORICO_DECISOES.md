# Histórico de Decisões

> Mudanças relevantes de requisitos/arquitetura e por que foram tomadas.
> Antes de "corrigir" algo que parece estranho no código, verificar aqui se
> não é uma decisão deliberada. Reconstruído a partir dos planos de trabalho
> e do histórico de commits disponíveis — não é exaustivo; complementar
> sempre que uma decisão permanente for tomada.

## Unificação do cadastro de cliente (Implantação + Migração)

Antes: clientes em implantação e clientes em migração viviam em coleções
separadas (`implantacao_clientes` e `migracao_clientes`), podendo gerar
cadastro duplicado para o mesmo cliente.

Decisão: unificar em uma única coleção `clientes`, identificada por ID
Central, com Migração vivendo como subcoleção (`clientes/<id>/migracoes`).
Implantação e Migração passam a ser processos paralelos e independentes do
mesmo cadastro — nunca duas entidades. Ver regra completa em
`docs/DOCUMENTACAO_FUNCIONAL.md`.

Migração de dados feita em fases, com scripts aditivos e idempotentes
(`migrar_clientes.py`, `migrar_migracao_para_clientes.py`) para permitir
conferir a coleção nova funcionando antes de remover a antiga, e
`limpar_migracao_orfa.py` para remover, só depois de confirmado, os
registros de migração sem vínculo com nenhum cliente.

## Terminologia "tentativa" → "processo" de migração

Decisão explícita: um processo de migração nunca deve ser chamado de
"tentativa" na interface — mesmo cancelado, foi um processo que chegou a um
fim, não "só uma tentativa". Textos visíveis ao usuário em `script.js`
foram ajustados (placeholder da aba Migração da Ficha, confirmação de
cancelamento, título da lista de processos anteriores); comentários internos
no código não foram alterados nessa rodada, por não serem visíveis ao
usuário (diff mínimo).

## Campo `estagio` (onboarding/ongoing) mantido dormente

O cadastro de cliente já tem o campo `estagio` com os valores `implantacao`,
`onboarding` e `ongoing`, mas só `implantacao` é controlado por tela hoje.
Decisão do usuário: não ativar onboarding/ongoing nesta rodada — fica para
quando houver definição mais completa do fluxo de pós-vendas. Não
interpretar isso como funcionalidade esquecida/bug.

## Log de auditoria e histórico do cliente em banco relacional paralelo

Decisão: criar um banco relacional (Postgres em produção, SQLite em dev) só
para `log_auditoria`, `log_auditoria_mudanca` e `historico_cliente`, correndo
**em paralelo** ao Firestore (que continua sendo a fonte de verdade dos
dados de negócio). Motivo: essas duas features (auditoria imutável e
histórico/timeline) se beneficiam de FK e consulta relacional de verdade, que
o Firestore não oferece bem; não se justificou migrar todo o resto do
sistema para SQL só por isso.

## Login/usuários migrados pro Postgres (cutover, não dual-write)

Login/usuários (antes `app_usuarios` no Firestore) agora são 100% Postgres
(`models.Usuario`, acessado via `usuarios_sql.py`) — o banco relacional do
Render (`migracao-ssx-db`) passou a existir, cumprindo a condição que
deixava essa migração pendente.

Decisão de corte: **cutover direto**, não dual-write. `app.py` parou de
ler/escrever a coleção `app_usuarios` do Firestore de uma vez; ela **não foi
apagada**, fica intacta lá como backup read-only, sem prazo definido de
remoção. Rollback, se precisar, é reverter o deploy do `app.py` (o Firestore
intacto garante isso) — só dados criados/alterados depois do corte (novo
usuário, troca de senha, foto) ficariam só no Postgres nesse cenário.

Dois ajustes feitos durante a migração que vale registrar:
- A foto de perfil foi pra uma tabela própria (`UsuarioFoto`, 1:1 com
  `Usuario`, sem linha = sem foto) — pedido explícito pra não deixar a
  tabela principal pesada com um blob base64 que pode chegar a ~700KB.
  Listagens em massa (Gerenciar Usuários, dropdown de responsável, mapa de
  telefones, aniversariantes do dia) nunca consultam essa tabela; só login,
  Minha Conta e o endpoint de avatar fazem.
- Coluna `aniversario_post_em` (controle de "já postei hoje" no post
  automático de aniversário do feed) foi adicionada ao model — existia em
  uso ativo no Firestore mas não estava no model ainda.

Sem tabela `Pessoa` separada de `Usuario` (dados de login e dados pessoais
na mesma tabela) — decisão explícita: hoje não existe nenhuma outra
entidade no banco relacional que reaproveitaria esses dados pessoais
("Colaborador" é só um conceito do Conversor que envia dados pra API
externa da SSX, não é persistido localmente), então separar seria desenhar
pra um requisito hipotético.

## Base de conexão com Google Sheets/Drive sem UI

Foi implementada só a conexão autenticada com a API do Google Sheets/Drive
(`planilha_migracao.py`), reaproveitando a credencial de service account do
Firebase com escopo próprio — sem nenhuma tela ou rota nova no Flask ainda.
Motivo: duas features futuras (gerar planilha nova por cópia de modelo no
Drive, e ler a planilha de um cliente para extrair insights) dependem dessa
base; ela foi deixada funcionando e verificável antes de construir qualquer
tela em cima.

## Versões de dependências do Firestore fixadas

`google-cloud-firestore`, `google-api-core`, `grpcio`, `google-auth` e
`protobuf` foram fixados em `requirements.txt` depois que uma atualização
automática (puxada pelo `firebase-admin`, que não fixa suas próprias
dependências) quebrou produção com o erro "Invalid database id (default)".
Não remover essas fixações sem testar a aplicação de ponta a ponta.

## Jobs longos em thread de fundo com polling

Importação de planilha e envio de comando em massa passaram a rodar em
thread de fundo com endpoint de status por `job_id`, em vez de manter a
requisição HTTP aberta até terminar. Motivo: evitar timeout da plataforma de
deploy (Render) em operações demoradas.

## Padrão único para os Conversores

Cada novo Conversor (Clientes, Veículos, Rastreadores, SIM Cards, Áreas, UO)
foi construído seguindo o mesmo fluxo de tela e o mesmo conjunto de rotas
(`campos → upload → mapear → editar/excluir/adicionar linha → limpar vazias
→ transformar → validar → verificar duplicidade → exportar`), reaproveitando
`validador_importacao/` para as regras de cada tipo. O Conversor de Unidades
Organizacionais é o único sem exportação de arquivo — a SSX só aceita esse
cadastro via API, então o fluxo importa direto. Motivo do padrão único:
manter a curva de aprendizado baixa entre um conversor e outro, e permitir
reaproveitar a mesma base de validação no Validador de Planilha de
Importação.

## Avaliações de NPS (Wootric) persistidas localmente, não consultadas ao vivo

A integração com a Wootric (bloco "Avaliações NPS" da Ficha) começou
consultando a API ao vivo a cada Ficha aberta (varredura paginada de
`/v1/end_users`, casando o IdCentral pelo sufixo do e-mail — nessa conta o
`external_id` do end_user não é preenchido). Mesmo com cache de 5 min e
paralelização da varredura, a primeira consulta depois do cache expirar
ficava em 7-8s, e um end_user sem atividade recente podia cair fora do teto
de 30 páginas da API e nunca ser encontrado.

Foi trocada por uma tabela própria (`wootric_avaliacoes`) sincronizada em
segundo plano (disparada, sem bloquear, a cada Ficha aberta — no máximo 1x a
cada 5 min por worker) a partir de `GET /v1/responses`, que já devolve o
e-mail do end_user embutido em cada resposta — não precisa mais varrer
`/v1/end_users`. A Ficha passou a ler só do Postgres (instantâneo). Motivo:
eliminar a espera e resolver a limitação de alcance da varredura por
end_user (ver `docs/DOCUMENTACAO_TECNICA.md` pros detalhes de
sincronização incremental vs. carga inicial).

**Bug real encontrado e corrigido antes de ir pra produção:** a primeira
versão da carga inicial (tabela vazia, sem cursor) buscava em ordem
crescente de data — numa conta com histórico desde 2020, isso significava
trazer as respostas mais ANTIGAS dentro do teto de 1500 da API, nunca
chegando nas recentes. Corrigido pra ordem decrescente (mais recentes
primeiro) quando não há cursor; a sincronização incremental normal (com
cursor) continua em ordem crescente, que é o certo pra não pular nada entre
uma rodada e outra.

As avaliações também viraram evento sintético na Timeline/Detalhado do
Histórico da Ficha (setor/tag "NPS", mesmo padrão já usado pros chamados do
ssxdesk e pras tentativas de migração — nunca um registro real em
`cliente_eventos`, sempre montado em memória a partir da tabela de
avaliações, igual a `construirEventosSinteticosChamados`).
