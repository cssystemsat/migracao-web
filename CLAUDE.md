# Instruções do projeto — migracao-web

Antes de executar qualquer tarefa nova neste projeto:

1. Consultar `DOCUMENTACAO_CENTRAL_PROJETO.md` — propósito do sistema,
   público-alvo, problemas que ele resolve e princípios obrigatórios de
   desenvolvimento. Toda implementação deve respeitar esses princípios.
2. Consultar a documentação complementar pertinente à tarefa:
   - `docs/DOCUMENTACAO_FUNCIONAL.md` — regras de negócio e comportamento de
     cada módulo/tela.
   - `docs/DOCUMENTACAO_TECNICA.md` — arquitetura, stack, integrações e
     padrões técnicos (ex.: padrão dos Conversores).
   - `docs/HISTORICO_DECISOES.md` — decisões já tomadas e por quê, antes de
     alterar algo que pareça inconsistente à primeira vista.
3. Quando uma decisão tomada durante a tarefa for permanente (mudança de
   regra de negócio, de arquitetura ou de escopo), atualizar o documento
   correspondente na mesma rodada de trabalho.
4. Sinalizar ao usuário qualquer conflito ou ambiguidade relevante entre o
   pedido atual e a documentação existente antes de tomar decisões
   irreversíveis (ex.: apagar dados, remover funcionalidade, mudar schema).

A documentação central não existe para bloquear mudanças legítimas pedidas
explicitamente pelo usuário — existe para manter a coerência do projeto e
evitar retrabalho.
