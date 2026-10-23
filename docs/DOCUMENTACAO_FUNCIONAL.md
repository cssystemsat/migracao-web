# Documentação Funcional

> Regras de negócio e comportamento de cada módulo. Ler em conjunto com
> `DOCUMENTACAO_CENTRAL_PROJETO.md` (propósito e princípios) e
> `docs/DOCUMENTACAO_TECNICA.md` (como isso é implementado).

## Regra de negócio central: Cliente / Implantação / Migração

- Todo cliente tem um **ID Central único** e uma etapa de relacionamento
  (`estagio`): `implantacao`, `onboarding` ou `ongoing`. Hoje o sistema só
  controla operacionalmente a Implantação por tela própria — `onboarding` e
  `ongoing` existem no cadastro mas sem tela que os ative ainda (dormentes,
  por decisão deliberada).
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
- A estrutura já comporta múltiplos processos de migração no histórico de um
  mesmo cliente (a subcoleção é uma lista), mesmo que hoje a tela só opere
  com "o processo atual" (em andamento, ou o mais recente).

## Dashboard

Tela inicial com acesso rápido às três grandes áreas: Controle de
Implantação, Controle de Migração e Ferramentas Auxiliares.

## Controle de Implantação

- Cadastro de clientes em implantação: ID Central, dados do cliente,
  responsável (CSM), consultor comercial, etc.
- Linha do tempo (histórico) do cliente, com modal em tela cheia: eventos
  manuais, ações de auditoria e tarefas aparecem numa mesma timeline.
- Motivo de atraso: campo explícito quando a implantação não está andando.
- Lista de clientes implantados (separada da lista "em andamento").
- Importação de clientes em lote por planilha (preview antes de confirmar).
- Credencial da SSX do cliente, para autenticar operações na plataforma em
  nome dele quando necessário.
- E-mail de boas-vindas.

## Controle de Migração

- Lista de clientes com processo de migração ativo (mesclada com a lista de
  Implantação pelo ID Central — ver regra de negócio acima).
- Ficha do cliente com aba de planilha de veículos: upsert por
  Cliente + Veículo, edição em lote, envio de comando por linha.
- Modelos de comando por fabricante/modelo de rastreador, vinculados ao
  processo de migração do cliente; editar o modelo já atualiza o comando dos
  veículos cadastrados com aquele equipamento.
- Criação/consulta de planilha de migração no Google Drive por cliente
  (link salvo em `link_planilha`), e importação do que foi preenchido nela.
- Autenticação na SSX em nome do cliente (sessão de uso avulso ou vinculada
  à credencial salva).
- Finalizar ou cancelar o processo de migração.

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

### Área de Importação e Consulta

- Autenticação na SSX para a central alvo.
- Importação genérica por tipo de cadastro (`/api/import/*`).
- Consultas/listagens com exportação para Excel.
- Deletar veículos em massa e Associar rastreadores em massa (por planilha
  de códigos de integração).

## Feed

Mural interno de comunicados da equipe: posts, curtidas e comentários.
Serve para avisos e alinhamentos que não cabem numa tarefa nem num cliente
específico.

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
