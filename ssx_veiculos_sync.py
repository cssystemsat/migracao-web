"""Lógica pura da Verificação de comunicação da Migração: compara os
veículos da migração (`MigracaoVeiculo`, vindos da planilha) com as listas de
comunicação da SSX (Tracker/ListMonitoredTrackedUnits e
ListOutdatedTrackedUnits). Não acessa o banco nem a API — só recebe listas já
carregadas e devolve o status de cada veículo; quem grava é `migracoes_sql.py`.

Chave de correspondência: `MigracaoVeiculo.id_equipamento` (ID do
equipamento informado na planilha) == `Tracker` (`IdTracker`) da SSX — não
`TrackerIntegrationCode` (opcional na SSX, não confiável pra casar linhas) e
não a placa. Veículo sem `id_equipamento` não é correspondido.

A antiga sincronização de veículos com a SSX (Vehicle/List -> criar/atualizar
veículos da migração) foi removida em 2026-11-26: puxava dado de outras
migrações e do que o cliente cadastrou sozinho. Ver
docs/HISTORICO_DECISOES.md.
"""


def _normalizar_codigo(valor) -> str:
    return str(valor or "").strip()


def _id_rastreador_local(veiculo: dict) -> str:
    """ID do rastreador informado na ficha, usado pelas listas de comunicação."""
    return _normalizar_codigo(veiculo.get("id_equipamento"))


def _indexar_por_codigo(itens_ssx: list, campo_codigo: str) -> dict:
    indice = {}
    for item in itens_ssx:
        codigo = _normalizar_codigo(item.get(campo_codigo))
        if codigo:
            indice[codigo] = item
    return indice


def calcular_status_comunicacao(
    veiculos_locais: list,
    monitorados: list,
    desatualizados: list,
) -> dict:
    """Confirmação de evento único ("já comunicou pela primeira vez depois da
    migração?"), não monitoramento contínuo — isso é papel do próprio SSX.

    - As listas da SSX são indexadas por `Tracker` (`IdTracker`), comparado
      diretamente com o `id_equipamento` informado na ficha.
    - Sem `id_equipamento`, não há correspondência: a placa e os códigos de
      integração não são usados como fallback.
    - Presente em `ListMonitoredTrackedUnits` -> comunicando agora.
    - Presente em `ListOutdatedTrackedUnits` com `EventDate` preenchido ->
      já comunicou antes e parou (confirmado também, contra dado real: a
      central tem casos legítimos de equipamento nunca usado que fica
      "desatualizado" com EventDate nulo desde o cadastro — não é bug do
      campo, é um estado real do equipamento).
    - Presente em `ListOutdatedTrackedUnits` com `EventDate` nulo, ou ausente
      das duas listas -> nunca comunicou, migração ainda não confirmada.

    Devolve {veiculo_id: {"status": "atualizado"|"desatualizado"|"sem_dado",
    "confirma_migracao": bool, "detalhe": {...dado bruto da SSX...}}}.
    """
    indice_monitorados = _indexar_por_codigo(monitorados, "Tracker")
    indice_desatualizados = _indexar_por_codigo(desatualizados, "Tracker")

    resultado = {}
    for veiculo in veiculos_locais:
        id_rastreador = _id_rastreador_local(veiculo)
        item_monitorado = indice_monitorados.get(id_rastreador) if id_rastreador else None
        item_desatualizado = indice_desatualizados.get(id_rastreador) if id_rastreador else None

        if item_monitorado:
            resultado[veiculo["id"]] = {
                "status": "atualizado",
                "confirma_migracao": True,
                "detalhe": item_monitorado,
            }
            continue

        if item_desatualizado:
            ja_comunicou = item_desatualizado.get("EventDate") is not None
            resultado[veiculo["id"]] = {
                "status": "desatualizado",
                "confirma_migracao": ja_comunicou,
                "detalhe": item_desatualizado,
            }
            continue

        resultado[veiculo["id"]] = {"status": "sem_dado", "confirma_migracao": False, "detalhe": None}

    return resultado
