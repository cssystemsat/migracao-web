# Histórico de Decisões

> Mudanças relevantes de requisitos/arquitetura e por que foram tomadas.
> Antes de "corrigir" algo que parece estranho no código, verificar aqui se
> não é uma decisão deliberada. Reconstruído a partir dos planos de trabalho
> e do histórico de commits disponíveis — não é exaustivo; complementar
> sempre que uma decisão permanente for tomada.

## Notificações do sininho — sem pop-up (2026-11-24)

Decisão explícita do usuário: notificações (tarefa criada, prazo de tarefa,
NPS novo, @ menção/comentário/curtida no Feed) só acumulam no contador do
sininho e aparecem na lista ao abrir o painel — nunca em pop-up/toast. Ver
regra completa em `docs/DOCUMENTACAO_FUNCIONAL.md`.

Limiares de prazo de tarefa definidos pelo usuário: notifica a 3 dias, a 1
dia, no dia do vencimento e quando a tarefa já está atrasada (uma
notificação por limiar, não repete a cada vez que o job roda).

@ menção usa autocomplete (dropdown de usuários ao digitar `@`, reaproveita
`/api/app-usuarios/opcoes`) em vez de parse de texto livre — decisão
explícita pra evitar nome ambíguo/erro de digitação não notificar ninguém.

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

Remoção do código morto (2026-11-18): as rotas `/api/implantacao/clientes...`
e a coleção Firestore `implantacao_clientes` ficaram no `app.py` por mais
tempo, sem nenhuma tela chamando-as (confirmado por busca em `script.js`/
`index.html`) — pararam de receber cliente novo desde a virada pra Postgres,
mas o código não tinha sido removido. Removidas as 9 rotas e as funções
auxiliares exclusivas delas (`_dados_implantacao_cliente`,
`_recalcular_ultima_acao_implantacao`); os dados antigos continuam no
Firestore, só o código foi apagado. `_dados_implantacao_evento` foi mantida
por ser compartilhada com o sistema novo (`/api/clientes/<id>/eventos`).

## Objetivo universal "IMPLANTAÇÃO" obrigatório (2026-11-10)

Contexto: plano de ampliação da área de Implantação (impedimentos, jornada
de ativação de 30 dias, diagnóstico de prontidão, novos indicadores do
Dashboard — ver seções seguintes e `docs/DOCUMENTACAO_FUNCIONAL.md`).

Decisão: existe um `ObjetivoTemplate` fixo chamado "IMPLANTAÇÃO"
(`universal=True`, seed da migração `44240710c2b8`) que é copiado
automaticamente para todo cliente novo com `tem_implantacao=True`, nos 3
pontos de criação de cliente (cadastro manual, sync da planilha de CS,
importação em lote) — ponto único em `clientes_sql.criar_cliente`, chamando
`objetivos_sql.criar_objetivo_universal_para_cliente`. Esse template não
pode ser excluído (`TemplateUniversalProtegidoError`) nem o objetivo
resultante pode ser removido da ficha do cliente — só editado (nome, itens,
prazo), igual a qualquer template normal.

Decisões explícitas confirmadas com a usuária:
- **Revisão (mesmo dia, 2026-11-10):** a decisão original era só criar o
  objetivo universal em clientes novos, sem rodar retroativamente nos já
  cadastrados. A usuária viu a tela de Objetivos vazia num cliente antigo e
  pediu que o objetivo universal **sempre** apareça, pra todo cliente de
  Implantação. Em vez de uma migração em lote, o backfill é preguiçoso: `GET
  /api/clientes/<id>/objetivos-implantacao-detalhados` chama
  `objetivos_sql.criar_objetivo_universal_para_cliente` (idempotente) antes
  de listar — garante o objetivo na primeira vez que a ficha de qualquer
  cliente antigo é aberta, sem precisar varrer a base inteira de uma vez.
- **Não altera a regra oficial de "implantado"**, que continua sendo pelos
  marcos (`Cliente.etapa`/`concluido_em`). O objetivo universal fica fora da
  futura regra de "todos os objetivos específicos concluídos" (`universal`
  marca exatamente isso).
- A migração `44240710c2b8` foi aplicada diretamente em produção (Render) —
  confirmado com a usuária depois do fato (ver observação de processo: a
  migração deveria ter sido testada antes contra um banco local, mas o
  `DATABASE_URL` do `.env` já apontava pra produção na hora do teste).
- **Nome do objetivo** (mesmo dia): o label exibido é "Implantação" (não
  "IMPLANTAÇÃO" em caixa alta) — migração de dado `7f6aa5a7a29f` renomeia o
  template seed e os objetivos já copiados (`universal=True`, nunca compara
  por nome no código).
- **Backfill em lote** (mesmo dia, revisão da decisão "só clientes novos"
  acima): rodado uma vez via `objetivos_sql.backfill_objetivo_universal_todos_clientes()`
  pra cobrir os 190 clientes de Implantação existentes antes dessa mudança,
  além do backfill preguiçoso que já cobre qualquer cliente futuro que passe
  batido.
- **Ordem**: o objetivo universal sempre aparece primeiro na Ficha,
  independente do valor de `ordem` guardado — `listar_objetivos` ordena por
  `universal DESC, ordem, id` (não dá pra confiar só em `ordem=0` porque
  "Salvar objetivos" reatribui `ordem` pela posição que o front mandou,
  sem tratamento especial pro universal).

## Marco sai do Dashboard de Implantação — vai virar parâmetro de Onboarding (2026-11-24)

Pedido explícito da usuária: marco deixa de ser parâmetro de Implantação —
vai virar parâmetro de uma futura área de Onboarding (ainda não
implementada). Por enquanto isso só mudou o Dashboard de Implantação, não a
regra oficial de "implantado" em todo o resto do sistema (`Cliente.etapa`/
`concluido_em`, ver seção "Objetivo universal..." acima), que continua
intacta até decisão explícita em contrário.

Removidos do Dashboard de Implantação (`templates/index.html`,
`static/script.js`): tiles "Implantações concluídas (marcos)" e "Clientes
com marco atrasado", e os cards de detalhe "Clientes com marco em atraso",
"Implantações paradas" e "Tempo nos marcos" (todos baseados em
`Cliente.etapa`/marcos). As funções `clientesComMarcoAtrasado`,
`renderDashboardAtrasados`, `renderDashboardParados` e
`renderDashboardTempoMarcos` **não foram apagadas** — continuam em uso no
Dashboard geral (tela inicial), que não foi alterado por esse pedido.
Ficaram: "Tempo médio de implantação (concluídas)" (tile do topo, ainda
baseado em marco — não foi pedido pra sair) e "Envelhecimento da carteira"
(usa `data_entrada`/`etapa`, não os marcos em si).

**Mesmo dia, pedido seguinte:** o card "Funil de Implantação" (distribuição
de clientes por etapa/marco, `construirBarraDistribuicao` com
`IMPLANTACAO_ETAPAS_ORDEM`/`MARCO_COR`) também saiu do Dashboard de
Implantação pelo mesmo motivo. A função `construirBarraDistribuicao`
continua em uso no Dashboard geral e no funil por status — não foi
apagada, só a chamada específica desta tela.

## TTFV (Time to First Value) como KPI principal da Implantação (2026-11-24)

Pedido explícito da usuária (responsável por Implantação): TTFV passa a ser
o KPI principal dela. Definição confirmada: dias entre `Cliente.data_entrada`
e a data de conclusão do PRIMEIRO objetivo ESPECÍFICO do cliente (nunca o
universal "Implantação" — mesma separação já decidida em "Objetivo
universal... obrigatório" acima). Meta: 14 dias.

Decisão explícita de escopo: é um KPI novo e separado — **não substitui**
o card "Ativação e prevenção de churn" existente (checklist "Primeiro valor
percebido", meta 30 dias, ver seção "Dashboard de ativação/churn
recalculado..." acima), que continua como está. Os dois medem coisas
diferentes com o mesmo nome popular ("primeiro valor") — não misturar.

Implementação: `objetivos_sql.estatisticas_dashboard_implantacao` agora
também recebe `Cliente.data_entrada` na query principal e calcula
`ttfv_tempo_medio_dias`, `ttfv_pct_dentro_meta` e `ttfv_amostra` (dias < 0
descartados, mesmo filtro de período dos demais indicadores de conclusão).
Na tela, substituiu a tile "Clientes sem objetivo cadastrado" (pedido
explícito da usuária) como tile em destaque (`stat-tile-destaque`, borda
mais grossa e fundo tingido pela cor do tile) — a função de drill-down
`abrirModalClientesSemObjetivo` ficou sem uso e foi removida do
`script.js`; o endpoint `/api/dashboard-implantacao/sem-objetivo` não foi
removido do `app.py` (fora do pedido, sem efeito colateral ficar parado).

## Reorganização dos KPIs de Objetivos no Dashboard de Implantação (2026-11-24)

No card "Objetivos de Implantação — tempo e duração" do Dashboard de
Implantação: os KPIs do objetivo universal "Implantação" (`universal=True`,
ver seção acima) passaram a vir **primeiro**, antes dos KPIs dos objetivos
específicos — são "Tempo médio pra implantação", "Clientes com objetivo
concluído" e "Clientes com objetivo atrasado". O tempo médio é novo
(`universal_tempo_medio_dias` em `objetivos_sql.estatisticas_dashboard_implantacao`),
calculado do mesmo jeito que o tempo médio dos objetivos específicos
(`concluido_em - criado_em`, só objetivos `feito` com as duas datas), mas
isolado do cálculo dos específicos — mantém a separação já decidida entre
objetivo universal e objetivos específicos.

Nos KPIs dos objetivos específicos (abaixo do bloco do universal): "Objetivos
concluídos" deixou de mostrar contagem ("2 de 3") e passou a mostrar
porcentagem; "Tempo mediano de conclusão" foi removido (duplicava "Tempo
médio de conclusão"); "Clientes com objetivo cadastrado" foi removido do
card (pedido explícito da usuária, sem substituto).

## Impedimentos de objetivo (Fase 2 do plano de ampliação, 2026-11-10)

Nova entidade `ClienteObjetivoImpedimento` (tabela `cliente_objetivo_impedimentos`,
migração `b4fe5b856939`) — categoria (lista fixa por responsabilidade:
cliente/Systemsat/terceiro, ver `impedimentos_sql.CATEGORIAS`), datas de
início/resolução, status, impacto e próxima ação. Nunca excluído — só
editado ou resolvido/reaberto —, pra nunca apagar o atraso do histórico
(regra explícita do contexto de negócio da Implantação).

O prazo do objetivo (`ClienteObjetivo.prazo_dias`) nunca é sobrescrito; o
"prazo ajustado" é sempre calculado na hora (`objetivos_sql._objetivo_dict`),
igual já acontecia com a data prevista de conclusão — mesmo padrão de "nunca
guardar o que pode ser calculado e fica desatualizado" já usado no resto do
módulo de Objetivos. Intervalos de impedimento que se sobrepõem no tempo são
mesclados antes de somar (`impedimentos_sql.dias_impedimento_objetivo`) pra
não descontar o mesmo dia duas vezes, conforme pedido explícito.

## Jornada de ativação de 30 dias (Fase 3 do plano de ampliação, 2026-11-10)

Nova tabela `cliente_ativacao` (migração `93d5a1185682`), 1:1 com `Cliente`.
Decisão confirmada com a usuária no planejamento original: é um controle de
dados **separado** do funil de marcos existente (`Cliente.etapa`/
`marcos_*`), não uma evolução dele — os dois convivem sem se misturar, igual
já acontece entre "implantado pelos marcos" e "implantado por objetivos"
(ver decisão acima). O relógio dos 30 dias usa sempre `Cliente.data_entrada`
e nunca é pausado por impedimento (regra explícita do contexto de negócio),
diferente do prazo ajustado dos objetivos.

**Revisão de UI (mesmo dia, 2026-11-10):** a primeira versão mostrava isso
num painel próprio, separado dos Objetivos, no topo da aba Implantação. A
usuária não gostou — pediu pra ficar dentro do objetivo universal
"Implantação", sempre visível (não atrás de toggle), com esse card
visualmente destacado dos demais objetivos.

**Segunda revisão, removendo o controle por completo (mesmo dia):** a
usuária foi além e pediu pra as métricas virarem sub-atividades com data do
próprio checklist do objetivo universal, em vez de um controle de dados
separado. Mapeamento pedido:
- "Orientar sobre o primeiro acesso" (item já existia) = primeiro acesso.
- "Iniciou os treinamentos" (renomeado de "Realizar treinamento inicial") =
  primeiro treinamento.
- "Finalizou esteira de treinamentos" (item novo) = capacitação concluída.
- "Primeiro valor percebido" (item novo) = primeiro valor.

Confirmado explicitamente que NÃO entram em lugar nenhum: "Ativação
operacional" e "Primeiro vencimento" (quando precisar, é sempre
`data_entrada + 30 dias`, calculado na hora — nunca um campo), "situação de
ativação", "motivo de não ter iniciado" (vira impedimento quando for exceção
real) e "próxima ação" (é a próxima sub-atividade pendente do checklist).

Resultado: `cliente_ativacao` foi dropada (migração `24e683c0ce3a`, tabela
nunca teve linha real — conferido antes de remover), `ativacao_sql.py` foi
deletado, e as rotas/UI correspondentes removidas. O controle de atraso
dessas sub-atividades passa a ser só impedimentos (Fase 2), igual qualquer
outro objetivo específico.

## Dashboard: objetivo universal fora do ranking + bloco de impedimentos (Fase 5, 2026-11-11)

Pedido explícito da usuária: o objetivo universal "Implantação" não deve
competir no ranking de "objetivos mais usados" nem nas médias de tempo dos
objetivos específicos — é estruturalmente diferente (régua obrigatória, não
um projeto contratado). `objetivos_sql.estatisticas_dashboard_implantacao`
agora separa o laço em duas contagens: específicos (ranking, tempo, "todos
concluídos") e universal (métrica própria: total/concluídos/atrasados).
Efeito colateral correto: `clientes_sem_objetivo` passou a significar "sem
objetivo ESPECÍFICO" (antes, com o backfill do universal, teria ido pra
zero sempre — o que não fazia sentido pra regra de negócio).

Pedido também: métricas de impedimento no Dashboard —
`impedimentos_sql.estatisticas_dashboard_impedimentos` calcula dias de
atraso ATIVO por cliente (soma, por cliente, dos dias mesclados de cada
objetivo com impedimento em aberto — reaproveita `dias_impedimento_objetivo`
já existente da Fase 2), ranking por responsabilidade/categoria e tempo
médio de resolução dos já resolvidos. Fica num bloco novo "Impedimentos e
gargalos" no Dashboard de Implantação, com a lista de clientes clicável
(abre a ficha).

## Dashboard de ativação/churn recalculado em cima do checklist (2026-11-11)

Com `cliente_ativacao` removida, o bloco "Ativação e prevenção de churn" do
Dashboard de Implantação (seção 8.4 do contexto de negócio) precisou ser
recalculado: `objetivos_sql.estatisticas_dashboard_ativacao` usa a
sub-atividade "Primeiro valor percebido" do objetivo universal
(`ClienteObjetivoItem.concluido_em`) como marco, e `Cliente.data_entrada +
30 dias` (sempre calculado na hora) como vencimento — taxa de ativação,
tempo médio até o primeiro valor e lista de clientes perto do vencimento
sem valor percebido ainda (risco de churn).

## Diagnóstico de prontidão (Fase 4 do plano de ampliação, 2026-11-12)

Nova tabela `cliente_diagnostico_prontidao` (migração `3c1f3fccee31`), 1:1
com `Cliente` — diferente do checklist do objetivo universal (que virou
sub-atividades com data), aqui NÃO virou checklist de tarefas: é uma
fotografia das condições iniciais do cliente num dado momento (possui
equipamento? chip? operação definida?), sem data de "quando foi feito" —
não faz sentido como sub-atividade. Campos booleanos nullable (`None` =
"não avaliado ainda", distinto de `False` = "não possui" — importante pra
classificação não tratar falta de dado como negativo). Vive dentro do card
do objetivo universal na Ficha, mesmo padrão de painel expansível dos
impedimentos.

**Nota + UX revisado (mesmo dia):** pedido pra gerar uma nota (0-10) junto da
classificação — apoio pro CS num eventual churn, provando que a fragilidade
já estava visível desde a entrada (`diagnostico_sql._nota`, proporção de
"Sim" entre as perguntas respondidas). Também revisado o UX: o botão do
painel carrega a nota/classificação assim que a ficha abre (sem precisar
clicar), e o formulário recolhe de novo sozinho depois de "Salvar" — antes
ficava aberto com as 6 perguntas + observações até a usuária fechar na mão,
poluindo o card do objetivo universal.

**Virou painel independente (mesmo dia):** pedido pra tirar o diagnóstico de
dentro do card do objetivo "Implantação" — agora é um painel próprio na aba
Implantação (`construirPainelDiagnosticoProntidao`), entre as informações
gerais e os Objetivos. O card de informações gerais do topo também passou a
mostrar a nota+classificação num campo "Score de implantação", substituindo
"Última ação" ali (que continua existindo só na timeline completa).

## Drill-down de impedimentos por responsabilidade/categoria (Fase 6, 2026-11-12)

Último item pendente do plano original de interatividade do Dashboard:
clicar numa linha de "Por responsabilidade" ou "Maiores categorias" do
bloco "Impedimentos e gargalos" abre modal com os registros (`impedimentos_sql.
listar_por_filtro`, rota `/api/dashboard-implantacao/impedimentos`), igual
já existia pro ranking de objetivos e pra lista de clientes mais atrasados.
**Revisão da Fase 6 (mesmo dia):** na revisão, faltavam 3 tiles do topo sem
drill-down ("Objetivos atrasados", "Clientes sem objetivo cadastrado",
"Implantações concluídas (por objetivos)") e o tile "Implantações
concluídas (marcos)" também não abria nada. Fechados com
`objetivos_sql.listar_objetivos_atrasados`/`listar_clientes_sem_objetivo_especifico`/
`listar_clientes_concluidos_por_objetivos` (3 rotas novas) + reaproveitando
o modal "Clientes implantados" (`abrirModalImplantados`) já existente pro
tile de marcos — só precisou alimentar `implantacaoClientesCache` também a
partir do loader do Dashboard de Implantação, que antes fazia sua própria
consulta de clientes sem atualizar esse cache compartilhado.

Com isso, os 6 pontos do plano original de ampliação da Implantação estão
todos entregues (com os ajustes de rota combinados ao longo do caminho,
documentados nas entradas anteriores).

## Conclusão do Objetivo de Implantação virou independente das sub-atividades

Antes: um objetivo com sub-atividades era considerado concluído automaticamente
quando todas as sub-atividades estavam marcadas (`ClienteObjetivo.feito` era
derivado de `all(item.feito for item in itens)`); objetivo sem sub-atividades
usava um campo `feito` manual. Não existia data de conclusão nem prazo no
nível do objetivo — só cada sub-atividade tinha `concluido_em`.

Decisão (pedido explícito da responsável pelo Controle de Implantação, ao
planejar o Dashboard de Implantação): `ClienteObjetivo.feito` e o novo
`ClienteObjetivo.concluido_em` passam a ser **sempre manuais e independentes**
das sub-atividades, em todo objetivo (com ou sem itens). As sub-atividades
continuam existindo na Ficha como checklist de apoio, mas não determinam mais
a conclusão do objetivo nem alimentam nenhum KPI do Dashboard de Implantação.
`concluido_em` é carimbado com a data de hoje na primeira vez que o usuário
marca o objetivo como concluído, mas fica sempre editável — e os indicadores
de tempo/prazo do dashboard são sempre recalculados a partir do valor atual
desse campo, nunca de um valor cacheado.

Também foi adicionado `ClienteObjetivo.prazo_dias` (nullable, em dias a partir
de `criado_em`) — prazo individual por objetivo, usado para calcular a data
prevista de conclusão e identificar atraso. Objetivo sem prazo definido fica
fora dos KPIs de atraso/previsão. Objetivo concluído antes dessa mudança
(`feito=True` e `concluido_em=""`) é tratado como legado: conta nos KPIs de
quantidade, mas fica fora de qualquer média/mediana de tempo (sem dado
retroativo pra calcular).

**"Implantação concluída (por objetivos)"** (cliente com pelo menos 1
objetivo e todos concluídos) é uma métrica NOVA, só do Dashboard de
Implantação — decisão explícita de manter `Cliente.etapa`/`concluido_em`
(baseado nos 5 marcos do Playbook) como a fonte oficial de "cliente
implantado" em todo o resto do sistema (Dashboard geral, lista de clientes
implantados, switch manual "Implantado"). As duas métricas convivem sem se
sobrepor.

Migração: `9ba7a2a2212e_adiciona_prazo_e_conclusao_independente_.py` (adiciona
`cliente_objetivos.concluido_em` e `cliente_objetivos.prazo_dias`).

## API do ssxdesk: domínio mudou para desk.systemsat.com.br

Era `ssxdesk.ssatx.com.br`. A chave de API (`SSXDESK_API_KEY`) e os
endpoints/escopo continuam os mesmos — só a base URL mudou, em
`ssxdesk_api.py` (`_BASE_URL`).

Isso foi descoberto investigando um 403 "sem permissão (escopo)" que só
acontecia em produção (Render), nunca testando a mesma chave localmente: o
corpo real da resposta era uma página de challenge do Cloudflare
("Attention Required!"), não um erro do ssxdesk — o domínio antigo estava
bloqueando o IP de datacenter do Render antes da requisição chegar na
aplicação. A chave sempre teve escopo completo; não era bug de código nem
de permissão. Trocar para o domínio novo resolveu.

Se esse erro voltar a aparecer (mensagem de escopo só em produção, nunca
localmente), suspeitar primeiro de bloqueio de rede/WAF, não de chave ou
escopo — comparar o corpo da resposta, não só o status HTTP.

## Terminologia "tentativa" → "processo" de migração

Decisão explícita: um processo de migração nunca deve ser chamado de
"tentativa" na interface — mesmo cancelado, foi um processo que chegou a um
fim, não "só uma tentativa". Textos visíveis ao usuário em `script.js`
foram ajustados (placeholder da aba Migração da Ficha, confirmação de
cancelamento, título da lista de processos anteriores); comentários internos
no código não foram alterados nessa rodada, por não serem visíveis ao
usuário (diff mínimo).

## Tela Churn do CRM inspirada em outro projeto interno (2026-11-26)

Pedido explícito: deixar a tela Churn (`/crm/churn`, antes placeholder) igual
à tela Churn de outro projeto interno da Systemsat
(`github.com/cssystemsat/kanban_dashboard_dev`, React/tRPC). Esse projeto lê a
aba "CHURNS" da MESMA planilha Google Sheets já usada pela Sincronização de
Planilha de CS (`PLANILHA_CS_URL`), só que outra aba (gid diferente).

Escopo combinado com a usuária, dividido em 2 rodadas:
- **Feita agora**: KPIs (cancelamentos no período, média de tempo de casa,
  cliente mais antigo, valor total de boletos), 3 gráficos de barra
  (tempo de casa / tipo / persona — feitos com divs, sem lib de gráfico, nunca
  recharts, mesmo padrão já usado no resto do projeto), tabela filtrável
  (período com atalhos + seleção manual de mês/ano, cliente, CSM, vendedor,
  persona) e exportar Excel. Rota `/api/churn` (leitura, cache 5 min) e
  `/api/churn/exportar` (recebe os registros já filtrados pelo front e gera o
  .xlsx com openpyxl, mesmo padrão de `/api/clientes/importar/modelo`).
- **Fora desta rodada, explicitamente**: o botão "Gerar análise" (resumo por
  IA dos cancelamentos filtrados) e a edição de motivo/persona/boleto direto
  na tela (que no projeto de referência ESCREVE de volta na planilha do
  Google, com sistema de permissão por usuário) — dependem de integração que
  não existe neste projeto (LLM e escrita autenticada no Google Sheets).
  Avaliar de novo se a usuária pedir.

## Campo `estagio` (onboarding/ongoing) mantido dormente

O cadastro de cliente já tem o campo `estagio` com os valores `implantacao`,
`onboarding` e `ongoing`, mas só `implantacao` é controlado por tela hoje.
Decisão do usuário: não ativar onboarding/ongoing nesta rodada — fica para
quando houver definição mais completa do fluxo de pós-vendas. Não
interpretar isso como funcionalidade esquecida/bug.

**Revisão parcial (2026-11-25): módulo CRM criado, mas ainda sem controle de
onboarding/ongoing.** Pedido explícito do usuário: novo grupo "CRM" no
sidebar com 3 sub-telas — Dashboard CRM, Clientes e Churn (placeholder vazio,
"em construção"). A tela Clientes lista TODOS os clientes (qualquer
`estagio`) com CS responsável, Comercial responsável, etapa atual, busca e
filtros, e abre a Ficha ao clicar. Isso dá visibilidade ao `estagio` pela
primeira vez numa tela, mas **não é a ativação de onboarding/ongoing**
decidida acima — onboarding e ongoing continuam sem nenhum controle próprio
(sem Kanban, sem marcos, sem objetivos equivalentes ao de Implantação); só
aparecem como rótulo na lista. O próprio usuário confirmou que montar esse
controle (nos mesmos moldes do Controle de Implantação) é a "próxima etapa",
ainda não deste pedido. Implementação: reaproveitou `/api/clientes`
(já existente, sem filtro de estágio) pra lista, e uma função nova
`clientes_sql.estatisticas_dashboard_crm` (rota `/api/dashboard-crm`) pros
totais do Dashboard CRM — nenhuma rota/coleção nova precisou ser criada só
pra isso.

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

## Verificação de comunicação da Migração por `IdTracker`

As listas `ListMonitoredTrackedUnits` e `ListOutdatedTrackedUnits` da SSX
identificam o rastreador pela propriedade `Tracker` (`IdTracker`), distinta
de `TrackerIntegrationCode`. O botão Verificar comunicação compara esse
`IdTracker` diretamente com o campo `id_equipamento` da ficha, sem traduzir
o código de integração nem recorrer à placa. Veículos sem `id_equipamento`
não são correspondidos nem confirmados; confirmações históricas desses
registros são removidas ao atualizar a lista. Cada lista é consultada uma vez
por verificação.

## Equipamento da Migração preenchido pelo modelo SSX

O campo `equipamento` na ficha representa o nome do modelo do rastreador.
Durante a sincronização, `Vehicle/List.IdModelTracker` é resolvido por
`Tracker/ListTrackerModel` para `TrackerModel`; o nome é gravado em veículos
novos e atualizado nos existentes quando a API retorna um modelo conhecido.
Modelo ausente ou não resolvido não apaga valor já preenchido. Se os códigos
de integração não permitirem localizar um veículo existente, a placa é usada
como último critério de correspondência para evitar duplicá-lo.

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

## Ficha cadastral com modo edição de página inteira (2026-11-26)

A sub-aba "Informações do Cliente" da Visão Geral deixou de ser uma colagem
dos cards da Visão Geral (contatos, Dados cadastrais, Informações
operacionais — com CSM, vendedor e cidade/estado repetidos) e virou uma
ficha cadastral no formato CRM/ERP, com as mesmas seções do formulário de
cadastro e todos os campos dele (Persona, Implantado, Possui Migração e
Código IdCentral não apareciam antes).

Edição: a usuária escolheu **um botão "Editar" para a página toda + "Salvar
alterações"**, em vez de lápis por seção ou edição inline por campo — fora
do modo edição nada é editável. O salvamento usa o mesmo `PUT
/api/clientes/<id>` do modal (payload completo, mesmas travas de admin no
backend); "Implantado" continua indo pelo endpoint próprio
(`PUT .../implantado`, que registra data/quem) só quando muda.

O rascunho da edição fica em memória no JS (`fichaCadastroEdicao`), não nos
inputs, porque a Visão Geral é redesenhada em segundo plano; além disso, a
chegada de chamados/NPS não redesenha mais essa sub-aba (ela não mostra
nenhum dos dois). O modal "Editar cliente" continua existindo (cabeçalho da
Ficha e listas) — salvar por ele descarta um rascunho aberto na ficha do
mesmo cliente.

`descricao_implantacao` ficou fora da ficha cadastral de propósito: já tem
lugar próprio na aba Implantação.

## Fase de vida (Implantação / Onboarding / Ongoing) ativada no cadastro (2026-11-26)

Revisão da decisão "Campo `estagio` (onboarding/ongoing) mantido dormente":
pedido explícito da usuária pra começar a separar os clientes por time. O
`estagio` virou o campo **"Fase de vida"** do cadastro (modal Adicionar/
Editar cliente e Ficha cadastral), com as 3 opções, escolhido à mão. Cada
time ganhou seu grupo no menu lateral — Onboarding e Ongoing — com, por
enquanto, só a lista dos clientes na fase (rotas `/onboarding` e
`/ongoing`, mesma fonte `/api/clientes` da CRM → Clientes, filtrada no
front). É intencionalmente quase um placeholder: a ideia é cada time ter seu
próprio controle depois; agora é só pra começar a colocar os clientes na
fase certa. Nenhuma mudança de schema (a coluna já existia).

**Bug latente corrigido junto:** o `PUT /api/clientes/<id>` caía no padrão
`implantacao` quando o payload não trazia `estagio` (nenhum formulário
mandava) — enquanto o campo era dormente não fazia diferença, mas com ele
ativo qualquer edição devolveria um cliente de Onboarding/Ongoing pra
Implantação. Agora o PUT mantém o `estagio` atual quando o campo não vem, e
o modal e a Ficha cadastral passaram a mandá-lo.

Em aberto: o Controle/Dashboard de Implantação continuam listando todos os
clientes com Implantação, independente da fase de vida (não filtram por
`estagio`) — decidir com a usuária se cliente em Onboarding/Ongoing deve
sair de lá.

## Fase de entrada do cliente — antigos não contam nas fases anteriores (2026-11-26)

As fases de vida são sequenciais (Implantação → Onboarding → Ongoing) para
quem entra hoje, mas clientes antigos são cadastrados direto em Onboarding
ou Ongoing. Decisão da usuária: esses não podem interferir nos dados/KPIs das
fases anteriores — Ongoing não conta em Implantação nem em Onboarding;
Onboarding não conta em Implantação.

Escolhido (com aprovação explícita, por envolver schema) **gravar a fase de
entrada** numa coluna nova `clientes.fase_entrada` (migração
`c7e2a4f8d913`, só `add_column` com `server_default 'implantacao'` — todos
os clientes existentes entraram por Implantação). Preenchida na criação
(`POST /api/clientes` copia a fase escolhida) e nunca alterada pelo PUT.
Regra centralizada em `clientes_sql.fases_entrada_que_contam(fase)` — os
KPIs de Onboarding/Ongoing, quando existirem, devem filtrar por ela. A
alternativa (só documentar e criar a coluna quando houver KPIs de
Onboarding) foi descartada porque os clientes cadastrados até lá ficariam
sem o registro de por onde entraram.

Implantação continua filtrando por `tem_implantacao` (não foi trocado): o
`POST` grava `tem_implantacao=false` para quem nasce em Onboarding/Ongoing,
o que dá o mesmo resultado sem mexer em nenhuma consulta de KPI existente, e
o campo também cobre o caso antigo de cliente criado só pela Migração.

Corrigido junto: o `PUT /api/clientes/<id>` reescrevia `tem_implantacao`
para `True` quando o payload não trazia o campo (nenhum formulário traz) —
editar um cliente nascido só pela Migração o colocava na Implantação. Agora
o PUT preserva o valor atual. E a exclusão pela tela de Migração só apaga o
cliente inteiro se ele for "só de migração" (`tem_implantacao=false` e fase
Implantação); cliente sem Implantação em Onboarding/Ongoing tem só a
migração cancelada.

**Deploy:** a migração `c7e2a4f8d913` precisa rodar no Postgres antes (ou
junto) do código novo — o model passa a ler `fase_entrada` em toda consulta
de cliente.

## Migração: uma ativa + Histórico, sem sincronização SSX (2026-11-26)

Reestruturação pedida pela usuária. Decisões:

- **Uma migração ativa por cliente** (regra que já existia), com **Histórico**
  das anteriores — não projetos simultâneos. Enquanto a migração está ativa,
  tudo que o cliente manda entra nela. A aba Migração da Ficha ganhou
  sub-abas Ativa | Histórico; a aba aparece sempre (antes sumia sem
  migração). `/api/ficha` passou a devolver em `migracao` só a ATIVA (antes
  "a ativa ou a mais recente").
- **Finalização com formulário** (resultado, o que aconteceu, pendências,
  data) e **números congelados** no encerramento. Colunas novas em
  `migracoes` (migração `e5b1d7c3a920`, só `add_column`): `resultado`,
  `resumo`, `pendencias`, `encerrado_por`, `snapshot_encerramento` (JSON).
  Cancelamento também grava snapshot e vai pro Histórico como "Cancelada".
- **Migração encerrada é só leitura**: trava central em `app.py`
  (`_bloquear_escrita_em_migracao_encerrada`, `before_request` sobre
  `/api/clientes/<id>/migracoes/<id>/...`) — cobre todas as rotas de escrita
  de uma vez, inclusive as que não buscavam a migração antes de gravar.
- **Migração nunca cria cliente.** "+ Adicionar migração" escolhe um cliente
  já cadastrado; "Possui Migração?" saiu do formulário do cliente e virou
  só leitura na Ficha cadastral. Com isso, "Excluir" no Controle de Migração
  passou a ser só cancelar (a regra "apaga o cliente inteiro se ele existir
  só por causa da migração", ajustada mais cedo hoje, deixou de existir). O
  único cliente de produção que nasceu pela Migração continua cadastrado
  normalmente.
- **Sincronização de veículos com a SSX removida** (botão, rotas, worker,
  funções de diff e testes). Motivo: ao puxar da plataforma, misturava
  veículos de outras migrações e o que o cliente preencheu sozinho. Veículos
  entram só pela planilha; a conferência é pela Verificação de comunicação,
  que só consulta. A tabela `migracao_ssx_sync_jobs` e o model ficaram
  (desativados) pra não exigir migração destrutiva.
- **Chave da verificação mantida**: ID do equipamento da planilha ==
  `IdTracker` das listas de comunicação (a usuária falou em "códigos de
  integração"; foi confirmado manter o IdTracker, porque traduzir código de
  integração exigiria consultar o cadastro de veículos da SSX).

**Deploy:** a migração `e5b1d7c3a920` precisa rodar no Postgres antes (ou
junto) do código novo — o model passa a ler as colunas novas de `migracoes`.
