# Documentação Funcional

> Regras de negócio e comportamento de cada módulo. Ler em conjunto com
> `DOCUMENTACAO_CENTRAL_PROJETO.md` (propósito e princípios) e
> `docs/DOCUMENTACAO_TECNICA.md` (como isso é implementado).

## Regra de negócio central: Cliente / Implantação / Migração

- Todo cliente tem um **ID Central único** e uma **fase de vida**
  (`estagio`): `implantacao`, `onboarding` ou `ongoing`. É um campo do
  cadastro ("Fase de vida", no formulário do cliente e na Ficha cadastral),
  escolhido manualmente — não muda sozinho por marco/conclusão. Cliente novo
  nasce em Implantação. Cada fase seguinte tem seu grupo no menu lateral
  (Onboarding, Ongoing) com, por enquanto, só a lista dos clientes naquela
  fase (mesmo formato da CRM → Clientes; clicar abre a Ficha). O controle
  próprio de cada time (equivalente ao Controle de Implantação) é a próxima
  etapa, ainda não implementada. A CRM → Clientes continua mostrando todas
  as fases.
- As fases são **sequenciais**: hoje o cliente entra por Implantação, vai pra
  Onboarding e depois Ongoing. Clientes antigos (de antes desse fluxo) podem
  ser cadastrados direto em Onboarding ou Ongoing — pelo "+ Adicionar
  cliente" da lista da fase, ou da CRM → Clientes com o filtro de etapa
  escolhido; a Fase de vida vem preenchida conforme a lista de origem.
- **Fase de entrada** (`fase_entrada`): fase em que o cliente entrou no
  sistema, gravada na criação e nunca alterada (aparece só leitura na Ficha
  cadastral). Regra de dados/KPIs: **cada fase só conta clientes que
  entraram nela ou numa fase anterior** — quem entrou em Ongoing não conta em
  Implantação nem em Onboarding; quem entrou em Onboarding não conta em
  Implantação. Cliente que entrou em Implantação e avançou continua contando
  nas fases por onde passou.
- Cliente criado direto em Onboarding/Ongoing nasce com `tem_implantacao =
  false`: fica fora do Controle e do Dashboard de Implantação, não recebe o
  objetivo universal "IMPLANTAÇÃO" e a Ficha não mostra a aba Implantação.
- **Marcos:** usa o plano de marcos (Marco 1 a 5) quem passou pela
  Implantação **ou entrou direto em Onboarding** — este usa os 5 marcos, com
  prazo contado da data de entrada (cliente antigo aparece atrasado, por
  decisão da usuária). Quem entrou direto em Ongoing (ou existe só pela
  Migração) não usa marcos: sem aba Marcos, sem tag de atraso e fora dos
  blocos de marcos do Dashboard (Atrasados, Parados, Tempo nos marcos,
  Funil). Regra centralizada em `clienteUsaMarcos` (static/script.js).
- **Cliente em Onboarding ou Ongoing é sempre implantado.** Ao criar ou
  salvar um cliente nessas fases, o backend marca "implantado" sozinho (com
  data, quem e registro na auditoria). O switch "Cliente implantado?" fica
  travado em "Sim" nessas fases; pra desmarcar, a fase de vida tem que
  voltar pra Implantação.
- **Implantação e Migração são processos paralelos e independentes**, não um
  sub-estágio um do outro. Um cliente pode estar em qualquer etapa de
  relacionamento e, paralelamente, ter ou não um processo de Migração.
- **Nunca duplicar cliente**: o cadastro em `clientes` (por ID Central) é a
  fonte única. Se o mesmo cliente está em Implantação e também tem Migração,
  ele aparece nos dois controles — é o mesmo registro, não dois. Criar
  cliente com ID Central já existente é bloqueado.
- Um processo de Migração nasce como subcoleção do cliente
  (`clientes/<id>/migracoes/<id>`), nunca como uma entidade de cliente
  separada.
- **Terminologia**: quando o cliente pede uma migração, nasce um *processo*
  de migração — nunca chamar isso de "tentativa" na interface. Se
  cancelado, o processo "ficou cancelado" (não foi "só uma tentativa"); se
  concluído, é um processo que chegou ao fim.
- **Uma migração ativa por vez** por cliente; as anteriores ficam no
  Histórico (ver "Controle de Migração"). Migração **nunca cria cliente**: é
  sempre adicionada a um cliente já cadastrado.

## Dashboard

Tela inicial com acesso rápido às três grandes áreas: Controle de
Implantação, Controle de Migração e Ferramentas Auxiliares.

## CRM

Novo grupo no sidebar, com 3 sub-telas (`/crm/dashboard`, `/crm/clientes`,
`/crm/churn`). Visão de cliente que cruza todos os estágios de uma vez (ao
contrário de Implantação/Migração, que olham só o processo específico).

- **Dashboard CRM** (`/crm/dashboard`): visão geral de TODOS os clientes da
  empresa, independente do estágio — total de clientes, distribuição por
  estágio (implantação/onboarding/ongoing), ranking por CS responsável e por
  Comercial responsável, e valor total em contrato. Dado vem de
  `/api/dashboard-crm` (`clientes_sql.estatisticas_dashboard_crm`).
- **Clientes** (`/crm/clientes`): lista única com todos os clientes de
  qualquer estágio (reaproveita `/api/clientes`, já usado por outras telas) —
  nome, IdCentral, CS responsável, Comercial responsável e etapa atual, com
  busca por nome/IdCentral e filtro por etapa/CS/Comercial. Clicar na linha
  abre a Ficha do cliente (mesma função `irParaFicha` das outras listas).
  Onboarding e ongoing aparecem aqui só como o nome da etapa — ainda não têm
  um controle próprio (equivalente ao Controle de Implantação) por trás; ver
  decisão acima e `docs/HISTORICO_DECISOES.md`.
- **Churn** (`/crm/churn`): lê a aba "CHURNS" da mesma planilha de CS
  (`/api/churn`, cache de 5 min) — KPIs (cancelamentos no período, média de
  tempo de casa, cliente mais antigo, total de boletos), 3 gráficos de barra
  (tempo de casa/tipo/persona), tabela filtrável (período com atalhos ou
  seleção manual de mês/ano, cliente, CSM, vendedor, persona) e exportar
  Excel (`/api/churn/exportar`). Inspirada na tela Churn de outro projeto
  interno (ver `docs/HISTORICO_DECISOES.md`) — sem o botão de análise por IA
  nem edição de motivo/persona/boleto (que escreveriam na planilha), fora do
  escopo combinado nesta rodada.

## Dashboard de Implantação

Sub-tela própria do grupo "Implantação" no sidebar (`/implantacao/dashboard`),
separada do Dashboard geral (tela inicial). Central de gestão da responsável
pelo Controle de Implantação: camada analítica sobre os processos que já
existem (Ficha do cliente, Objetivos de Implantação, marcos), sem criar
controle paralelo.

**Filtro de período** (mês atual/trimestre atual/ano atual/personalizado/tudo)
no topo da tela. Cada indicador usa a data que faz sentido pra ele —
implantações iniciadas usa `data_entrada`, objetivos/implantações concluídas
usam a data de conclusão correspondente; "objetivos atrasados" é sempre um
corte do presente (hoje vs. data prevista), não é afetado pelo período.

KPIs:

- Carteira: clientes em implantação ativos, implantações iniciadas no
  período. Marco deixou de ser parâmetro de Implantação (passa a ser de
  Onboarding, ver `docs/HISTORICO_DECISOES.md`) — "implantações concluídas
  (marcos)" e "clientes com marco atrasado" saíram deste dashboard.
- **TTFV (Time to First Value)** — KPI principal da responsável por
  Implantação (tile em destaque, substituiu "Clientes sem objetivo
  cadastrado"): dias entre `Cliente.data_entrada` e a conclusão do primeiro
  objetivo ESPECÍFICO do cliente (nunca o universal "Implantação"). Meta:
  14 dias — mostra também % de clientes dentro da meta. Independente da
  regra de "implantação concluída" (por marcos ou por todos os objetivos):
  mede velocidade até o primeiro resultado, não o fim do processo. Origem:
  `objetivos_sql.estatisticas_dashboard_implantacao`.
- Tempo e duração: tempo médio de implantação das concluídas (`data_entrada`
  → `concluido_em` do cliente, só marcos), tempo médio/mediano de conclusão
  de objetivo, objetivos atrasados (prazo individual vencido), ranking dos
  objetivos com maior tempo médio de conclusão.
- Objetivos de Implantação (ligado direto à aba Implantação da Ficha do
  cliente): total concluído, progresso médio por cliente, ranking dos
  objetivos mais recorrentes (usados/concluídos/pendentes/atrasados/% de
  conclusão/tempo médio) — origem:
  `objetivos_sql.estatisticas_dashboard_implantacao`. Objetivo concluído
  antes da data de conclusão existir (legado) conta na quantidade mas fica
  fora das médias de tempo — a tela avisa quantos são.
- **"Implantação concluída (por objetivos)"**: métrica própria desta tela —
  cliente com pelo menos 1 objetivo e todos concluídos. É DIFERENTE da
  "Implantação concluída" pelos marcos (`Cliente.etapa`), que continua sendo
  a regra oficial em todo o resto do sistema — ver
  `docs/HISTORICO_DECISOES.md`.
- Envelhecimento da carteira: clientes ativos agrupados por dias em
  implantação (até 15 / 16–30 / 31–60 / 61–90 / mais de 90) — classificação
  de tempo, não indica atraso por si só.

**Objetivo universal fora do ranking**: "Ranking dos objetivos mais
recorrentes", "Objetivos com maior tempo médio de conclusão",
"Clientes com objetivo cadastrado" e "Implantação concluída (por
objetivos)" nunca contam o objetivo universal "Implantação" — ele tem
métrica própria e separada (concluído/atrasados) logo abaixo do ranking,
sem se misturar com os objetivos específicos contratados.

**Drill-down dos tiles do topo**: "Objetivos atrasados" e "Implantações
concluídas (por objetivos)" são clicáveis — abrem a lista correspondente,
clicar no registro abre a ficha.

**Drill-down de impedimentos**: clicar numa linha de "Por responsabilidade"
ou de "Maiores categorias de impedimento" abre um modal com os impedimentos
daquele filtro (cliente, objetivo, categoria, status, data de início) —
clicar num registro abre a ficha do cliente.

**Drill-down do ranking de objetivos**: clicar num objetivo do "Ranking dos
objetivos mais recorrentes" ou de "Objetivos com maior tempo médio de
conclusão" abre um modal com os clientes que usam aquele objetivo (status:
concluído/atrasado/em andamento) — clicar no cliente abre a ficha dele
direto.

**Impedimentos e gargalos** (novo bloco): impedimentos ativos, tempo médio
de resolução (só impedimentos já resolvidos), ranking por responsabilidade
(cliente/Systemsat/terceiro) e por categoria, e lista de clientes com mais
dias de impedimento ATIVO agora (soma por cliente dos dias mesclados de
cada objetivo com impedimento em aberto — não conta impedimento já
resolvido, que é histórico, não atraso atual). Clicar num cliente da lista
abre a ficha dele.

**Ativação e prevenção de churn** (recalculado em cima do checklist, já que
`cliente_ativacao` não existe mais): taxa de ativação, tempo médio e lista
de clientes perto do vencimento (`data_entrada + 30 dias`, calculado na
hora) sem ter marcado a sub-atividade "Primeiro valor percebido" do
objetivo universal — ver `docs/HISTORICO_DECISOES.md`.

Consulta sem período fica cacheada 5 min (mesmo racional do `/api/dashboard`,
ver `docs/DOCUMENTACAO_TECNICA.md`), invalidada automaticamente por qualquer
escrita em `/api/`; consulta com período não é cacheada.

### Prazo e conclusão do objetivo (aba Implantação da Ficha do cliente)

Cada objetivo tem um prazo individual opcional, em dias (ex.: Rastreamento
básico 5 dias, Telemetria 10 dias) — a data prevista de conclusão é
`criado_em + prazo_dias`, calculada na hora, nunca guardada. A conclusão do
objetivo (checkbox "Concluído" + data de conclusão) é **sempre manual e
independente das sub-atividades**, mesmo quando o objetivo tem sub-atividades
cadastradas — elas continuam servindo de checklist de apoio na Ficha, mas não
determinam mais a conclusão do objetivo nem entram em nenhum KPI do Dashboard
de Implantação. A data de conclusão é preenchida automaticamente ao marcar
"Concluído" (se ainda vazia) e pode ser editada livremente depois; os
indicadores de duração/prazo do dashboard sempre recalculam a partir do valor
atual desse campo. Ver `docs/HISTORICO_DECISOES.md` para o antes/depois dessa
regra.

## Controle de Implantação

- Cadastro de clientes em implantação: ID Central, dados do cliente,
  responsável (CSM), consultor comercial, etc.
- Linha do tempo (histórico) do cliente, com modal em tela cheia: eventos
  manuais, ações de auditoria e tarefas aparecem numa mesma timeline.
- Motivo de atraso: campo explícito quando a implantação não está andando.
- Objetivos de Implantação com sub-atividades: administradores gerenciam
  modelos em Configurações → Templates de Objetivos; analistas e
  administradores podem copiar um modelo ou criar objetivos personalizados
  na Ficha do cliente. Cada cópia é independente do modelo, e a conclusão
  das etapas determina o progresso do objetivo. Objetivos legados sem etapas
  continuam podendo ser concluídos diretamente.
- **Objetivo universal "IMPLANTAÇÃO"**: todo cliente novo com Implantação
  recebe automaticamente, na criação, uma cópia do template fixo
  "IMPLANTAÇÃO" (`ObjetivoTemplate.universal=True`) — régua básica que todo
  cliente percorre, independente dos objetivos específicos contratados. Não
  pode ser excluído (nem o template, nem a cópia na ficha do cliente), só
  editado. Não entra na futura regra de "todos os objetivos específicos
  concluídos" nem substitui a regra oficial de implantação (marcos). Aparece
  em TODO cliente de Implantação, inclusive os cadastrados antes dessa
  mudança — backfill preguiçoso ao abrir a ficha pela primeira vez depois
  dela (ver `docs/HISTORICO_DECISOES.md`).
- Lista de clientes implantados (separada da lista "em andamento").
- Importação de clientes em lote por planilha (preview antes de confirmar).
- Credencial da SSX do cliente, para autenticar operações na plataforma em
  nome dele quando necessário.
- E-mail de boas-vindas.
- Documentos do cliente (sub-aba "Informações do Cliente" da Ficha): PDF da
  ficha de entrada assinada e do contrato, um de cada por cliente (enviar de
  novo substitui o anterior). Guardado em tabela própria (`cliente_documentos`),
  não na linha do cliente — mantém a consulta do cadastro leve mesmo com
  PDFs anexados (ver `docs/DOCUMENTACAO_TECNICA.md`).
- Ficha cadastral (sub-aba "Informações do Cliente" da Visão Geral da Ficha):
  cadastro do cliente no formato CRM/ERP, com as mesmas seções e campos do
  formulário de cadastro (inclusive Fase de vida, em Identificação) — Identificação, Relacionamento, Contrato & momento,
  Localização — mais Situação da implantação (calculada, só leitura) e
  Indicadores da planilha de CS (só leitura, com a fonte indicada). Lateral
  com contatos rápidos (WhatsApp), completude do cadastro (12 campos
  principais, só informativo — nenhum é obrigatório além do IdCentral),
  Documentos e Credencial SSX (a credencial fica só aqui, não aparece mais
  na sub-aba Visão Geral). Abre em modo leitura; o botão "Editar" põe a
  página inteira em modo edição e "Salvar alterações" grava tudo de uma vez
  (sem edição por campo/seção). IdCentral e Código IdCentral continuam só
  para administrador. "Migração" aparece só leitura (em andamento ou
  nenhuma) — não é mais campo do cadastro. Sair da sub-aba/aba/cliente com alteração não salva
  pede confirmação. A descrição da implantação continua na aba Implantação.

### Jornada de ativação (primeiros 30 dias) — virou checklist do objetivo universal

Não existe mais como controle separado (`cliente_ativacao` foi removida —
ver `docs/HISTORICO_DECISOES.md`). As métricas da jornada viraram
sub-atividades com data do próprio checklist do objetivo universal
"Implantação", reaproveitando `ClienteObjetivoItem.concluido_em` (carimbado
ao marcar a etapa como feita, igual qualquer outra sub-atividade):

- "Orientar sobre o primeiro acesso" → data do primeiro acesso.
- "Iniciou os treinamentos" (antes "Realizar treinamento inicial") → data do
  primeiro treinamento.
- "Finalizou esteira de treinamentos" → data de conclusão da capacitação.
- "Primeiro valor percebido" → inclui teste com equipamento de demonstração.

Não existe mais campo de "situação de ativação", "motivo pelo qual não
iniciou" nem "próxima ação de ativação" como campos próprios — atraso real
(bloqueio externo) é registrado como impedimento do objetivo (seção
seguinte), e a "próxima ação" é, na prática, a próxima sub-atividade não
concluída do checklist. "Primeiro vencimento" também não é mais campo
nenhum — quando precisar, é sempre `data_entrada + 30 dias`, calculado na
hora.

### Diagnóstico de prontidão

Painel próprio na aba Implantação da Ficha (fora do card de qualquer
objetivo, entre as informações gerais e os Objetivos): 6 perguntas sobre as
condições iniciais do cliente
(equipamentos, chips, operação definida, clientes próprios, equipe
disponível pra treinamento, estrutura pra operar), cada uma Sim/Não/Não
avaliado. Classificação calculada (nunca guardada): "Pronto para iniciar"
(todas Sim), "Não preparado para iniciar" (todas Não), "Parcialmente
preparado" (mistura) ou "Não avaliado" (nenhuma respondida ainda) — não
avaliado não conta como negativo, é só falta de dado. **Nota de 0 a 10**
(proporção de "Sim" entre as respondidas, campo não avaliado não entra na
conta) — serve de apoio pro CS num eventual churn, mostrando com um número
que as condições de entrada já eram frágeis. Campo de observações livre.
Não é um checklist de tarefas (não tem data de conclusão por pergunta) — é
uma fotografia das condições do cliente, atualizável a qualquer momento.

O botão do painel já mostra a nota e a classificação sem precisar abrir
(carregadas assim que a ficha abre); o formulário fica fechado por padrão e
recolhe de novo automaticamente depois de salvar. O card "IdCentral/Etapa/
Implantado/Responsável" no topo da aba também mostra a nota+classificação
num campo próprio ("Score de implantação"), no lugar de "Última ação"
(removido desse card — continua disponível na timeline completa).

### Impedimentos de objetivo

Cada objetivo específico (não o universal) pode ter impedimentos — bloqueios
externos que atrasam a execução sem ser culpa da equipe (ex.: cliente sem
chip pro equipamento). Um impedimento tem categoria (lista fixa por
responsabilidade — cliente/Systemsat/terceiro, ver `impedimentos_sql.
CATEGORIAS`), descrição, data de início, status (ativo/resolvido), data de
resolução, impacto e próxima ação. Nunca é excluído — só editado ou
resolvido/reaberto —, pra preservar o histórico de atraso.

O prazo do objetivo nunca é sobrescrito: a Ficha mostra o prazo original
(`prazo_dias`) e, quando há dias de impedimento, um **prazo ajustado**
(`prazo_ajustado_dias` = original - dias de impedimento, calculado na hora,
nunca guardado) ao lado — impedimentos que se sobrepõem no tempo não
descontam o mesmo dia duas vezes. Toda criação/resolução de impedimento gera
auditoria e evento na timeline do cliente (setor "Implantação"), igual à
conclusão de objetivo.

## Controle de Migração

- **Criar migração:** "+ Adicionar migração" no Controle de Migração abre
  uma busca de clientes **já cadastrados** (nome ou IdCentral) — não existe
  mais criar cliente pela Migração. Cliente com migração ativa aparece
  desabilitado. A migração nasce na etapa Análise e o resto (plataforma,
  planilha, acesso à origem) é preenchido na aba Migração da Ficha. Também dá
  pra criar pela Ficha ("Iniciar migração", quando não há ativa). O campo
  "Possui Migração?" saiu do formulário do cliente.
- **Controle de Migração (Kanban/lista):** só migrações **ativas**. "Excluir"
  no Controle = cancelar a migração (nunca apaga o cliente).
- **Aba Migração da Ficha — sub-abas Ativa | Histórico.** Só aparece pra
  cliente que tem ou já teve migração (quem nunca teve começa pelo
  "+ Adicionar migração" do Controle):
  - *Ativa:* a migração em andamento (veículos, informações, planilha,
    importar, finalizar/cancelar). Tudo que o cliente mandar enquanto ela
    está ativa entra nela. Sem ativa: "Nenhuma migração ativa no momento" +
    "Iniciar migração".
  - *Histórico:* um card por migração encerrada (concluída ou cancelada):
    plataforma de origem, período, quem encerrou, planilha usada, números de
    veículos (válidos, comunicando, não comunicando, sem rastreador,
    progresso) **congelados no encerramento**, e o relatório de finalização
    (ou o motivo do cancelamento). "Ver veículos" abre a lista só leitura.
- **Formulário de finalização:** Resultado (Concluída / Concluída com
  pendências), "O que aconteceu" (obrigatório), Pendências/problemas
  (obrigatório se "com pendências") e Data de término (padrão hoje). Quem
  finalizou, plataforma, planilha e números são automáticos. Cancelar pede só
  o motivo (opcional) e também vai pro Histórico.
- **Migração encerrada é só leitura:** o backend recusa qualquer alteração
  (veículos, modelos, planilha, verificação, informações).
- Ficha do cliente com aba de planilha de veículos: upsert por
  Cliente + Veículo, edição em lote, envio de comando por linha.
- Modelos de comando por fabricante/modelo de rastreador, vinculados ao
  processo de migração do cliente; editar o modelo já atualiza o comando dos
  veículos cadastrados com aquele equipamento.
- Verificação de comunicação dos veículos usa a identificação `IdTracker` da
  SSX (`Tracker` nas listas de atualizados/desatualizados), comparada com o
  campo `ID do equipamento` da ficha, sem usar código de integração ou placa.
  Veículos sem ID do rastreador não são correspondidos nem confirmados; ao
  atualizar a lista, confirmações antigas desses veículos são removidas.
- Veículos sem `ID do equipamento` recebem automaticamente o status
  `Sem rastreador`; quando um ID é preenchido, voltam para `Aguardando`.
  `Cancelado` é preservado. Os status `Sem rastreador` e `Cancelado` não
  entram nos totais, no percentual de progresso nem no resumo por modelo da
  migração, mas continuam visíveis e filtráveis na lista de veículos.
- **Veículos entram só pela planilha** que o time envia (importação da
  aba "Migração"). Não existe mais "Sincronizar com SSX" (puxar veículos da
  plataforma): misturava veículos de outras migrações e o que o cliente
  cadastrou sozinho. A conferência é feita pela **Verificação de
  comunicação** (só consulta a SSX e marca os veículos da própria
  migração).
- A planilha de veículos exibe até 100 linhas por página, preservando busca,
  filtros e seleção entre páginas para reduzir travamentos em bases grandes.
- Criação/consulta de planilha de migração no Google Drive por cliente
  (link salvo em `link_planilha`), e importação do que foi preenchido nela.
- Autenticação na SSX em nome do cliente (sessão de uso avulso ou vinculada
  à credencial salva).
- Finalizar (com formulário) ou cancelar a migração — as duas levam ao
  Histórico.

## Central de tarefas

- Tarefas com responsável, prazo, status (aberta/concluída) e vínculo
  opcional a um cliente.
- Concluir/reabrir tarefa.
- Contagem de tarefas abertas visível em "Minha conta" (badge).
- Toda criação/edição/conclusão gera entrada na linha do tempo do cliente
  vinculado (quando houver) e no log de auditoria.

## Ferramentas Auxiliares

### Central de Importação SSX (Conversores)

Converte uma planilha de origem (de outra plataforma, estrutura qualquer)
para o layout oficial de importação da SSX, ou importa direto pela API.
Fluxo padrão, igual em todos os conversores (ver `docs/DOCUMENTACAO_TECNICA.md`
para o detalhe técnico do padrão):

1. Carregar a planilha de origem.
2. Mapear as colunas de origem para os campos oficiais da SSX.
3. Editar manualmente, excluir ou adicionar linha na tabela resultante.
4. Limpar linhas vazias.
5. Aplicar transformações em massa (ex.: limpar/validar CPF-CNPJ, gerar
   e-mail/senha, preencher campos padrão).
6. Validar contra as regras oficiais da SSX.
7. Verificar duplicidade contra a base já existente.
8. Exportar o arquivo pronto (ou, quando o cadastro não tem arquivo de
   importação na SSX, importar direto pela API).

Conversores disponíveis e status:

| Conversor | Status |
|---|---|
| Clientes → SSX | Implementado |
| Veículos → SSX | Implementado |
| Rastreadores → SSX | Implementado |
| SIM Cards → SSX | Implementado |
| Unidades Organizacionais → SSX | Implementado (só API, sem arquivo de importação) |
| Áreas (CSV) → SSX | Implementado |
| Áreas (KML) → SSX | Implementado (`conversorkml.py`) |
| Viagens → SSX | Em construção (placeholder, sem funcionalidade) |
| Abastecimento → SSX | Em construção (placeholder, sem funcionalidade) |
| Colaboradores → SSX | Em construção (placeholder, sem funcionalidade) |

### Operações em massa

Na operação de exclusão, a lista da SSX pode ser filtrada por texto em cada
coluna. Para veículos, a tabela mostra identificação, nome do cliente, ID do
rastreador (`IdTracker`) e código de integração. A seleção em massa alcança
somente os elegíveis que correspondem aos filtros; Shift+clique seleciona ou
desmarca o intervalo visível entre duas linhas, preservando a seleção fora
dos filtros.

### Validador de Planilha de Importação

Valida uma planilha já no layout oficial da SSX contra as regras de cada
tipo de cadastro (cliente, veículo, rastreador, SIM card, UO, área),
reaproveitando as mesmas regras de validação usadas pelos Conversores
(`validador_importacao/`).

### Sincronizar Planilha

Compara a base da plataforma com uma planilha enviada (preview das
diferenças) e aplica as mudanças aceitas.

### Envio de Comandos

- Gerador de comando por modelo de rastreador, ou comando livre.
- Autenticação e consulta de saldo antes do envio.
- Envio individual ou em massa via SMS Market, com acompanhamento de status
  (job em background).

### Quebra-String

Interpreta pacotes brutos enviados pelo rastreador (parser por protocolo,
ex.: GT06) para apoiar diagnóstico/configuração.
Inclui relatórios ST300 do Suntech ST310U e ST340UR em texto e Zip. Além de
status, emergência, evento, alerta e keep-alive, o parser interpreta os campos
opcionais de RPM/iButton e localização celular, detalhes de excesso de
velocidade e DPA, e as métricas econômicas do relatório de viagem (HTE). O
ST340UR também inclui dados de dispositivo RS232 (UEX) e seu mapeamento de
entradas/saídas. Inclui também o protocolo ASCII do Absolut (RST), com a base
de tracking, bits de informações adicionais e as mensagens de evento do
rastreador (sensor, bateria, antifurto, macro/formulário, evento embarcado,
viagem/estacionamento). O "Padrão GT06" cobre, além do GT06 clássico
(0x01/0x12/0x13/0x15/0x16/0x1A/0x80), as variantes CRX1 e CRX3 da Concox:
login com modelo/fuso (CRX3), localização 0x22 com ACC/modo de envio/
odômetro, alarme 0x26 com tabela de alarmes estendida (inclui bateria
baixa, violação, porta, SIM trocado etc.), resposta de comando 0x21 e
transmissão de informação 0x94 (cabeçalho 79 79, 2 bytes de tamanho),
LBS múltiplas bases 0x28 e checagem de horário 0x8A. Os protocolos já
suportados permanecem disponíveis.
Comportamento do CRX1 (não é formato de pacote, mas ajuda no diagnóstico):
com o veículo parado — ACC ligado ou desligado — o equipamento não envia
0x12 (filtra dados sem movimento); só envia 0x12 quando há movimento,
usando o intervalo configurado para o estado do ACC no momento. ACC
desligado + movimento também dispara um alarme de vibração (0x16),
como indício de furto. "Modo sleep" é ACC desligado + parado (economia
de GPRS). Ou seja, a ausência de 0x12 durante longos períodos não é
necessariamente falha de comunicação.
O "Padrão GT06" também cobre a localização estendida 0x32 dos rastreadores
Nonus N2/N4 (mesmo pacote 78 78 + CRC-ITU do GT06/Concox, com o mesmo bloco
GPS+LBS do 0x22 e os mesmos campos ACC/modo de envio/reenvio/odômetro, mas
com três campos a mais no fim: tensão principal, tensão da bateria interna
e soma de minutos com ACC ligado — exibido como horímetro).
A cada novo protocolo adicionado, atualizar também a lista "Equipamentos
disponíveis" em `templates/index.html` (modal do Quebra-String).
Inclui também o protocolo AVL da Teltonika (famílias FMB9XX/FMB130/FMM130/
FMC130): pacote de login (IMEI em ASCII, sem preamble) e pacote AVL em
Codec 8/Codec 8 Extended (preamble, CRC-16/IBM, data/hora, GPS, bloco de
elementos de I/O — cada I/O do registro vira uma linha própria na tabela,
com nome/conversão pelos AVL IDs documentados: entradas/saídas digitais e
analógicas, odômetro/combustível/CAN, acelerômetro, sensores BLE (temperatura/
bateria/umidade), geofence (as 50 zonas de evento), condução econômica,
viagem (trip), colisão, jamming, dados de OBD-II, entre outros). IDs sem
mapeamento aparecem como "IO <id>" com o valor bruto. Também decodifica
comandos/respostas em Codec 12 (ex.: `getinfo`, `#GET VERSION`) — mesmo
preamble e CRC do Codec 8, mas com texto ASCII no lugar de registro AVL.
Inclui também o protocolo X3Tech (rastreadores XT40-TM e NT40-6F em modo
"NT20", protocolo próprio da X3Tech — distinto do modo GT06 que esses
mesmos equipamentos também suportam via comando SETLOCX12#): login (0x01),
localização (0x12), heartbeat (0x13), alarme (0x16), os frames novos 0x22
(localização com tensão principal/bateria, hodômetro e horímetro) e 0x25
(mesmo frame 0x22 + identificação de motorista por iButton/RFID), IMSI
(0x90) e ICCID/transmissão geral de informação (0x94). **Importante**: o
X3Tech reaproveita o mesmo formato de pacote do GT06/Concox (78 78/79 79 +
CRC-ITU, inclusive os mesmos números de protocolo 0x01/0x12/0x13/0x16/0x94),
mas com tabela de alarmes e, nos frames 0x22/0x25, layout de campos
totalmente diferentes — não dá pra diferenciar os dois fabricantes só pelo
conteúdo do pacote. Por isso o Quebra-String tem o botão "Escolher
protocolo" (menu suspenso, oculto até o clique) que força a decodificação
por um protocolo específico em vez da detecção automática; é obrigatório
usá-lo pra ler corretamente um pacote X3Tech (a detecção automática sempre
tenta GT06/Concox primeiro nesse formato de pacote).

### Área de Importação e Consulta

- Autenticação na SSX para a central alvo.
- Importação genérica por tipo de cadastro (`/api/import/*`).
- Consultas/listagens com exportação para Excel.
- Deletar veículos em massa e Associar rastreadores em massa (por planilha
  de códigos de integração).

## Feed

Mural interno de comunicados da equipe: posts, curtidas e comentários.
Serve para avisos e alinhamentos que não cabem numa tarefa nem num cliente
específico. Publicação e comentário podem marcar outro usuário com `@`
(autocomplete) — quem é marcado recebe notificação (ver "Notificações").

- Publicação não é vinculada a cliente (o seletor de cliente foi removido em
  2026-11-26; posts antigos com cliente continuam no banco, mas o nome do
  cliente não aparece mais no card).
- Publicação pode ter até 4 imagens (JPG, PNG, WEBP ou GIF), pelo botão
  "Imagem" ou colando (Ctrl+V) no campo de texto. Texto fica opcional quando
  há imagem. As imagens são redimensionadas no navegador (lado maior até
  1600px) antes de enviar; GIF vai como está. Clicar abre em tamanho real.

## Notificações (sininho)

Sem pop-up/toast — só um contador de não lidas no sininho da topbar; a
lista completa aparece ao abrir o painel, e cada notificação é marcada como
lida ao ser clicada (ou todas de uma vez, pelo botão "Marcar todas como
lidas"). Gera notificação quando:

- Alguém cria uma tarefa pra você (responsável).
- Uma tarefa que você criou (delegou) é concluída ou cancelada pelo
  responsável — o texto traz o título da tarefa.
- Uma tarefa sua (responsável) está a 3 dias, a 1 dia, no dia do
  vencimento, ou já passou do prazo sem estar concluída.
- Um cliente seu (responsável/CSM) responde uma avaliação de NPS (Wootric).
- Alguém te marca com `@` numa publicação ou comentário do Feed.
- Alguém comenta ou curte uma publicação sua no Feed.

Quem gera o evento nunca recebe notificação do próprio evento (ex.: criar
tarefa pra si mesmo, curtir o próprio post).

## Equipe (página de cada funcionário)

Menu lateral "Equipe" (`/equipe`): grade com todos os usuários (foto ou
iniciais, nome e área), com busca por nome/área. Clicar abre a página da
pessoa (`/equipe/<usuario_id>`); clicar no nome do autor de uma publicação
do Feed (ou de um comentário), ou num `@nome` marcado num post/comentário,
também leva pra lá.

A página é interna: qualquer usuário logado vê, mas não fica aberta na
internet. Mostra:
- Contato: aniversário, celular (com link de ligação e de WhatsApp) e
  e-mail. Os dados vêm de "Minha conta"; o que estiver vazio aparece como
  "Não informado".
- Clientes da carteira: onde a pessoa é Responsável (CS) e/ou Consultor
  Comercial. Clicar abre a Ficha.
- Tarefas entre vocês: as que você passou pra ela e as que ela passou pra
  você (pendentes; as concluídas aparecem com "Mostrar concluídas"). Na
  própria página esse bloco some, porque as suas tarefas ficam em Minha
  conta.

## Minha conta / Gerenciar usuários

- Perfil do próprio usuário (nome, foto, telefone, aniversário), troca de
  senha, tema claro/escuro.
- Perfis de acesso: `adm`, `analista`, `visualizacao`.
- Área do usuário: `CS`, `Treinamento`, `Suporte` ou `Comercial` — usuário
  com área `Comercial` entra no seletor de "Consultor Comercial" no cadastro
  do cliente.
- Usuário pode estar ligado a um nome da lista de Responsável (CSM) dos
  clientes.

## Auditoria e histórico (transversal a todos os módulos)

- Toda ação de escrita relevante (criar/editar/excluir/concluir/reabrir)
  gera um registro de auditoria **imutável** — não existe rota de editar ou
  excluir um log de auditoria, em nenhum perfil.
- O histórico do cliente (timeline) reúne três origens: eventos manuais
  (editáveis só pelo autor ou um admin), ações de auditoria e tarefas
  (ambas não editáveis diretamente — só mudam via o processo que as gerou).
- Concluir um objetivo de Implantação e concluir um marco geram, além do
  registro de auditoria de sempre, um evento automático na timeline (setor
  "Implantação"). O evento do objetivo fica vinculado ao objetivo de origem e
  é removido quando ele é reaberto. Os eventos de marcos também são removidos
  quando o marco é reaberto; o evento geral de implantação concluída é
  removido se algum marco deixar de estar concluído.
