# Documentação Central do Projeto — Migração/Implantação Systemsat

> Este é o documento de referência permanente do projeto. Qualquer decisão de
> implementação — nova tela, novo campo, nova regra — deve ser avaliada à luz
> do que está escrito aqui. Ver também a seção "Documentação complementar" no
> final.

## 1. Contexto do negócio

A Systemsat desenvolve e opera uma plataforma de rastreamento veicular (SSX).
Essa plataforma é vendida/entregue para **centrais de rastreamento e empresas
de gestão de frota**, que por sua vez têm seus próprios clientes finais e
veículos monitorados. Ou seja, existem duas camadas de cliente:

- O cliente da Systemsat (a central de rastreamento/empresa de gestão).
- Os clientes finais dessa central (donos dos veículos monitorados) — fora do
  escopo direto deste sistema.

Este projeto (`migracao-web`) **não é a plataforma SSX**. É uma ferramenta
interna, separada, que dá suporte ao trabalho das equipes da Systemsat que
colocam uma central nova pra funcionar na SSX e que trazem a base de dados
dessa central de outra plataforma para dentro da SSX.

## 2. Público-alvo

Funcionários da Systemsat das áreas de:

- **Implantação**
- **Migração**
- **Pós-vendas / sucesso do cliente** (acompanhamento do cliente já
  implantado)

Não é uma ferramenta para as centrais de rastreamento nem para os donos dos
veículos monitorados — eles nunca fazem login neste sistema. É uma ferramenta
de trabalho interna, de bastidor.

## 3. Objetivo do sistema

Centralizar e facilitar a rotina operacional dessas equipes: organizar
clientes (centrais), acompanhar processos, executar tarefas, registrar
informações, controlar pendências e deixar claro o próximo passo de cada
cliente — em vez de depender de planilhas soltas, conversas de chat e memória
de quem está cuidando de cada caso.

## 4. Escopo de Migração

Processo de trazer a base de uma central que já operava em outra plataforma
(ex.: Getrak, Traquimi) para dentro da SSX. Cobre:

- Levantamento e tratamento de planilhas da plataforma de origem.
- Padronização e validação dos dados (CPF/CNPJ, login/senha, campos
  obrigatórios da SSX).
- Conversão para o layout oficial de importação da SSX e importação via
  arquivo ou direto pela API (Clientes, Veículos, Rastreadores, SIM Cards,
  Unidades Organizacionais, Áreas).
- Conferência da base importada (listagens, validador de planilha,
  verificação de duplicidade).
- Configuração de rastreadores (modelos, parâmetros e comandos por
  fabricante/modelo) e envio de comandos (individual e em massa).
- Acompanhamento da comunicação dos equipamentos depois de migrados.

No sistema, um cliente com Migração em andamento vive como um **processo de
migração** vinculado ao cadastro único do cliente (nunca um cadastro
duplicado) — ver regra de negócio detalhada na Documentação Funcional.

## 5. Escopo de Implantação

Organização e configuração da operação de uma central nova na plataforma:

- Cadastro do cliente (central) com ID Central único.
- Acompanhamento das etapas da implantação.
- Controle de tarefas e pendências relacionadas ao cliente.
- Linha do tempo (histórico) do que já aconteceu com aquele cliente.
- Identificação de motivo de atraso quando a implantação não anda.

Implantação e Migração são **processos paralelos e independentes** de um
mesmo cliente — ver Documentação Funcional, seção de regras de negócio.

## 6. Pós-vendas e sucesso do cliente

Depois que o cliente está implantado, o sistema continua útil para:

- Consultar o histórico/linha do tempo do cliente (o que já foi feito, quem
  fez, quando).
- Acompanhar tarefas abertas relacionadas ao cliente, com dono e prazo.
- Registrar acontecimentos relevantes manualmente (eventos da timeline).
- Identificar, pela lista de clientes implantados e pelas tarefas, quais
  processos estão parados e quais são os próximos passos.
- Acompanhar comunicados/avisos internos entre a equipe (Feed).

Hoje o sistema já tem a base disso construída (Tarefas, Histórico do cliente,
Feed); o que ainda não existe é uma etapa de relacionamento pós-implantação
com tela própria — o cadastro do cliente já prevê os valores `onboarding` e
`ongoing` além de `implantacao`, mas essa transição de etapa ainda não é
controlada por nenhuma tela (campo "dormente", por decisão deliberada, até
que haja uma definição mais completa do fluxo de pós-vendas).

## 7. Limites do escopo

- **Treinamento das centrais é responsabilidade de outra equipe**, fora deste
  sistema. Uma futura integração com a plataforma de treinamento pode ser
  considerada no futuro, mas isso não deve desviar o foco das funcionalidades
  operacionais atuais de Migração/Implantação/Pós-vendas.
- Este sistema não substitui a SSX nem duplica suas funcionalidades de
  rastreamento em si — ele prepara, valida e envia dados para a SSX, e apoia
  o trabalho de quem faz isso, mas a operação de rastreamento continua sendo
  feita na SSX.
- Áreas com tela ainda **"em construção"** (placeholder, sem funcionalidade
  real) no momento desta documentação: Conversor de Viagens, Conversor de
  Abastecimento e Conversor de Colaboradores. Não tratar essas telas como
  funcionalidade entregue.

## 8. Problemas que o sistema precisa resolver

Identificados nos requisitos, no histórico de decisões e na forma como o
código resolve cada um (ver `docs/HISTORICO_DECISOES.md` para o detalhe de
cada correção):

- **Informações dispersas em planilhas e ferramentas diferentes** — antes do
  Conversor, a equipe organizava manualmente planilhas de outras plataformas
  no Excel para encaixar no layout da SSX, copiando colunas e corrigindo
  formato à mão.
- **Excesso de controles manuais e tarefas repetitivas** — geração de
  login/senha, correção de CPF/CNPJ, conferência de campo obrigatório feitas
  à mão, com risco de erro humano.
- **Dificuldade de acompanhar vários clientes ao mesmo tempo** — sem uma lista
  única e um painel central, cada analista sabia só do seu próprio caso.
- **Falta de clareza sobre etapas, pendências e próximos passos** — resolvido
  parcialmente por Tarefas (com responsável e prazo), linha do tempo do
  cliente e motivo de atraso explícito no cadastro.
- **Risco de atrasos e esquecimentos** — tarefas com prazo e contagem visível
  em "Minha conta"; motivo de atraso obrigatório quando aplicável.
- **Dificuldade de consultar histórico e identificar impedimentos** — linha do
  tempo por cliente (eventos manuais + auditoria + tarefas) permite ver o que
  já aconteceu sem depender da memória de quem atendeu.
- **Falta de padronização e de visibilidade sobre o andamento dos processos**
  — unificação do cadastro de cliente por ID Central (sem duplicar entre
  Implantação e Migração) e padronização de terminologia visível ao usuário
  (ex.: processo de migração nunca é chamado de "tentativa").
- **Interfaces complexas que dificultam o trabalho diário** — padrão único de
  fluxo nos Conversores (upload → mapear → editar → validar → exportar) para
  reduzir a curva de aprendizado entre um conversor e outro.
- **Timeout de operações longas em produção** (Render) — importações e envios
  em massa rodam em thread de fundo com polling de status, em vez de travar a
  requisição.
- **Erro humano no envio de comando a rastreadores** — geração de comando
  padronizada por modelo, com histórico de autenticação e envio em massa
  controlado.

Novos problemas concretos identificados durante o trabalho devem ser
adicionados a esta lista.

## 9. Princípios obrigatórios de desenvolvimento

1. Toda funcionalidade deve ser pensada para os funcionários que usam o
   sistema no dia a dia — não para a central de rastreamento nem para o
   cliente final.
2. A prioridade é facilitar o trabalho, reduzir retrabalho e aumentar a
   produtividade — não acrescentar sofisticação pela sofisticação.
3. Implantação e Migração mantêm suas particularidades mesmo quando
   compartilham recursos (mesmo cadastro de cliente, mesmas tabelas de
   auditoria/histórico) — ver regra de negócio na Documentação Funcional.
4. Os dados, as tarefas, o histórico e o progresso de cada cliente devem
   ficar organizados de forma coerente, sob um único cadastro por ID Central
   — nunca duplicar cliente entre controles.
5. O sistema deve deixar claros os impedimentos e os próximos passos de cada
   cliente/processo (motivo de atraso, tarefa pendente, status do processo).
6. A interface deve ser intuitiva, objetiva e consistente — sem burocracia
   nem telas a mais que não resolvem um problema real.
7. Funcionalidades e requisitos já definidos não devem ser removidos ou
   alterados sem avaliar a justificativa original (ver histórico de
   decisões antes de reverter algo que parece "estranho").
8. Nova funcionalidade precisa resolver um problema real, não apenas
   acrescentar tela, campo ou controle porque "pode ser útil".
9. Decisões devem considerar o fluxo de trabalho completo do analista
   (Implantação → Migração → Pós-vendas), não uma funcionalidade isolada.
10. Mudanças futuras devem preservar a finalidade central do projeto — apoiar
    o trabalho interno de Implantação/Migração/Pós-vendas — salvo decisão
    explícita de alterar esse escopo.

## 10. Critérios para avaliar qualquer nova solicitação

Antes de implementar qualquer pedido novo:

1. Identificar o problema real que está sendo resolvido (não só o pedido
   literal — "o que trava o trabalho do analista hoje?").
2. Entender quem vai usar a funcionalidade e em qual tela/contexto do fluxo
   (Implantação, Migração, Ferramentas Auxiliares, Pós-vendas).
3. Verificar se já existe solução parecida no sistema (ex.: antes de criar um
   conversor novo, checar o padrão já usado pelos conversores existentes em
   `docs/DOCUMENTACAO_TECNICA.md`).
4. Analisar o impacto sobre telas, módulos e dados existentes — em especial
   sobre o cadastro único de cliente e as tabelas de auditoria/histórico.
5. Priorizar a solução mais simples que atenda à necessidade real.
6. Preservar requisitos anteriores que não foram explicitamente alterados
   pelo pedido atual.
7. Identificar conflitos entre o pedido novo e requisitos/decisões já
   registrados — sinalizar antes de decidir por conta própria.
8. Atualizar a documentação (central, funcional, técnica ou histórico de
   decisões, conforme o caso) quando a decisão for permanente.

Isso orienta a decisão e mantém a coerência do projeto — **não existe para
bloquear mudanças legítimas que o usuário pediu explicitamente.**

## 11. Documentação complementar

- `docs/DOCUMENTACAO_FUNCIONAL.md` — módulos, telas e regras de negócio de
  cada um.
- `docs/DOCUMENTACAO_TECNICA.md` — arquitetura, stack, integrações e padrões
  técnicos (ex.: padrão dos Conversores).
- `docs/HISTORICO_DECISOES.md` — decisões relevantes já tomadas e por quê,
  para não serem revertidas sem avaliação.

Quando uma decisão permanente mudar o projeto, atualize o documento
correspondente nesta mesma rodada de trabalho.
