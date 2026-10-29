"""Lógica pura de comparação entre `MigracaoVeiculo` (nosso banco) e os dados
da SSX (Vehicle/List + Tracker/ListMonitoredTrackedUnits/ListOutdatedTrackedUnits).

Não acessa o banco nem a API — só recebe listas já carregadas e devolve dicts
de diff/status. Quem grava é `migracoes_sql.py` (mesmo padrão de
`conversor_veiculos.py`, que também é lógica pura separada do SQL).

Chave de correspondência: `MigracaoVeiculo.id_equipamento` é o `IdTracker`
(Tracker ID) da SSX — não `TrackerIntegrationCode` (código de integração, que
é OPCIONAL na SSX e por isso não é confiável pra casar as linhas: um
rastreador real, com IdTracker normal, pode simplesmente não ter esse código
preenchido) e não a placa (veículo pode não ter placa ainda). `TrackerIntegrationCode`
continua guardado em `codigo_integracao_rastreador_ssx`, mas só como dado
informativo — nunca usado pra casar linha nenhuma. Veículo sem
`id_equipamento` localmente é normal (nem todo veículo tem rastreador) e é
simplesmente ignorado pela sincronização — não é erro.
"""


def _normalizar_codigo(valor) -> str:
    return str(valor or "").strip()


def _codigo_local(veiculo: dict) -> str:
    """Tracker ID (IdTracker) já persistido na ficha — chave de correspondência
    com a SSX. Usado na sincronização com Vehicle/List e na detecção de
    rastreadores não cadastrados."""
    return _normalizar_codigo(veiculo.get("id_equipamento"))


def _id_rastreador_local(veiculo: dict) -> str:
    """ID do rastreador informado na ficha, usado pelas listas de comunicação."""
    return _normalizar_codigo(veiculo.get("id_equipamento"))


def _codigos_possiveis_local(veiculo: dict) -> list:
    """Todas as chaves que podem identificar essa linha num item da SSX —
    tracker ID primeiro (mais confiável), veículo como alternativa pra
    veículo sem rastreador associado ainda (caso normal, não é erro)."""
    codigos = [_codigo_local(veiculo), _normalizar_codigo(veiculo.get("codigo_integracao_veiculo_ssx"))]
    return [c for c in codigos if c]


def _indexar_por_codigo(itens_ssx: list, campo_codigo: str) -> dict:
    indice = {}
    for item in itens_ssx:
        codigo = _normalizar_codigo(item.get(campo_codigo))
        if codigo:
            indice[codigo] = item
    return indice


# Campos locais atualizáveis diretamente pelos campos correspondentes na
# resposta da SSX (Vehicle/List). O nome do equipamento é resolvido abaixo
# por `IdModelTracker` + `Tracker/ListTrackerModel`. `id_equipamento` entra
# aqui pra autocorrigir quem foi casado por VehicleIntegrationCode/placa (sem
# id_equipamento local ainda, ou com valor desatualizado) — preenche/corrige
# com o IdTracker real da SSX, a chave de correspondência.
_CAMPOS_ATUALIZAVEIS = {
    "veiculo": "LicensePlate",
    "numero_linha": "PhoneNumber",
    "apn": "APNDomain",
    "id_equipamento": "IdTracker",
}


def _indexar_modelos_rastreador(modelos_ssx: list) -> dict:
    indice = {}
    for modelo in modelos_ssx:
        id_modelo = _normalizar_codigo(modelo.get("IdTrackerModel"))
        nome_modelo = _normalizar_codigo(modelo.get("TrackerModel"))
        if id_modelo and nome_modelo:
            indice[id_modelo] = nome_modelo
    return indice


def _dados_criacao_a_partir_do_ssx(item_ssx: dict, modelos_por_id: dict) -> dict:
    """Monta os campos de uma linha NOVA de `MigracaoVeiculo` a partir de um
    veículo da SSX que não tem nenhuma linha local correspondente ainda —
    é o caso normal logo após zerar a tabela (ver "Passo 0" do plano) ou de
    um veículo que a central já tem cadastrado e a planilha nunca trouxe.

    `cliente` (titular, texto livre) nasce igual a `cliente_ssx`
    (ClientTradingName) por falta de outra fonte — pode ser renomeado depois
    manualmente, como qualquer outra linha. `veiculo` (placa) cai pra
    Identification/código do rastreador quando não tem placa ainda (mesmo
    fallback já usado em planilha_migracao.py pra veículo 0km/sem placa) —
    a coluna não pode ficar vazia (é parte da chave de upsert)."""
    placa = _normalizar_codigo(item_ssx.get("LicensePlate"))
    identificacao = _normalizar_codigo(item_ssx.get("Identification"))
    tracker_id = _normalizar_codigo(item_ssx.get("IdTracker"))
    codigo_rastreador = _normalizar_codigo(item_ssx.get("TrackerIntegrationCode"))
    codigo_veiculo_ssx = _normalizar_codigo(item_ssx.get("VehicleIntegrationCode"))
    cliente_ssx = _normalizar_codigo(item_ssx.get("ClientTradingName"))
    return {
        "cliente": cliente_ssx or "(cliente SSX não identificado)",
        # Sem placa/identificação (0km, veículo sem rastreador ainda), cai pro
        # código que tiver disponível — nunca fica vazio (é parte da chave de upsert).
        "veiculo": placa or identificacao or tracker_id or codigo_veiculo_ssx,
        "equipamento": modelos_por_id.get(_normalizar_codigo(item_ssx.get("IdModelTracker")), ""),
        "id_equipamento": tracker_id,
        "numero_linha": _normalizar_codigo(item_ssx.get("PhoneNumber")),
        "apn": _normalizar_codigo(item_ssx.get("APNDomain")),
        "codigo_integracao_veiculo_ssx": codigo_veiculo_ssx,
        "codigo_integracao_rastreador_ssx": codigo_rastreador,
        "cliente_ssx": cliente_ssx,
    }


def calcular_diff_sincronizacao(
    veiculos_locais: list,
    veiculos_ssx: list,
    modelos_ssx: list | None = None,
) -> dict:
    """Casa os veículos da SSX (`Vehicle/List`, central inteira — nosso
    "cliente" é a central) contra as linhas locais por código de integração
    do rastreador. Devolve:
      - "a_criar": [{"campos": {...}}]  veículo existe na SSX mas não tem
         linha local nenhuma — normal logo após zerar a tabela (Passo 0) ou
         veículo que a central tem e a planilha nunca trouxe.
      - "a_atualizar": [{"veiculo_id", "campos": {campo: (atual, novo)}}]
         linha local já existe e tem dado divergente da SSX.
      - "nao_cadastrados": [veiculo_id, ...]  linha local tem id_equipamento
         mas NENHUM rastreador com esse código existe na SSX — pendência/erro
         real, não estado neutro (distinto de veículo sem id_equipamento,
         que é normal e é ignorado).
      - "sem_mudanca": contagem de veículos que já batem e não tem nada novo.

    Veículo da SSX sem rastreador associado também é criado/atualizado aqui:
    primeiro casa pelos códigos do rastreador/veículo e, se faltarem, pela
    placa. A placa evita propor duplicatas para veículos já importados sem
    código de integração.
    """
    modelos_por_id = _indexar_modelos_rastreador(modelos_ssx or [])
    indice_local = {}
    for veiculo in veiculos_locais:
        for codigo in _codigos_possiveis_local(veiculo):
            indice_local.setdefault(codigo, veiculo)

    indice_local_por_placa = {}
    for veiculo in veiculos_locais:
        placa = _normalizar_codigo(veiculo.get("veiculo")).upper()
        if placa:
            indice_local_por_placa.setdefault(placa, veiculo)

    a_criar = []
    a_atualizar = []
    sem_mudanca = 0
    ids_combinados = set()

    for item_ssx in veiculos_ssx:
        tracker_id = _normalizar_codigo(item_ssx.get("IdTracker"))
        codigo_rastreador = _normalizar_codigo(item_ssx.get("TrackerIntegrationCode"))
        codigo_veiculo_ssx = _normalizar_codigo(item_ssx.get("VehicleIntegrationCode"))
        # Tracker ID (IdTracker) é a chave principal — sempre existe pra um
        # rastreador de verdade. TrackerIntegrationCode é opcional na SSX, não
        # é usado pra casar (só guardado como informação). A placa é o
        # fallback final pra linhas legadas sem nenhum dos códigos.
        veiculo = None
        if tracker_id:
            veiculo = indice_local.get(tracker_id)
        if not veiculo and codigo_veiculo_ssx:
            veiculo = indice_local.get(codigo_veiculo_ssx)
        if not veiculo:
            placa = _normalizar_codigo(item_ssx.get("LicensePlate") or item_ssx.get("Identification")).upper()
            if placa:
                veiculo = indice_local_por_placa.get(placa)

        if not veiculo:
            a_criar.append({"campos": _dados_criacao_a_partir_do_ssx(item_ssx, modelos_por_id)})
            continue
        ids_combinados.add(veiculo["id"])

        campos_alterados = {}
        for campo_local, campo_ssx in _CAMPOS_ATUALIZAVEIS.items():
            valor_novo = _normalizar_codigo(item_ssx.get(campo_ssx))
            valor_atual = _normalizar_codigo(veiculo.get(campo_local))
            if valor_novo and valor_novo != valor_atual:
                campos_alterados[campo_local] = (valor_atual, valor_novo)

        equipamento_novo = modelos_por_id.get(_normalizar_codigo(item_ssx.get("IdModelTracker")))
        equipamento_atual = _normalizar_codigo(veiculo.get("equipamento"))
        if equipamento_novo and equipamento_novo != equipamento_atual:
            campos_alterados["equipamento"] = (equipamento_atual, equipamento_novo)

        if codigo_veiculo_ssx and codigo_veiculo_ssx != _normalizar_codigo(veiculo.get("codigo_integracao_veiculo_ssx")):
            campos_alterados["codigo_integracao_veiculo_ssx"] = (veiculo.get("codigo_integracao_veiculo_ssx"), codigo_veiculo_ssx)
        if codigo_rastreador and codigo_rastreador != _normalizar_codigo(veiculo.get("codigo_integracao_rastreador_ssx")):
            campos_alterados["codigo_integracao_rastreador_ssx"] = (veiculo.get("codigo_integracao_rastreador_ssx"), codigo_rastreador)

        # Central tem vários clientes finais — mostra de qual cliente SSX
        # (ClientTradingName) é cada veículo, já que o "cliente" local é
        # texto livre do titular, não necessariamente o mesmo nome da SSX.
        cliente_ssx = _normalizar_codigo(item_ssx.get("ClientTradingName"))
        if cliente_ssx and cliente_ssx != _normalizar_codigo(veiculo.get("cliente_ssx")):
            campos_alterados["cliente_ssx"] = (veiculo.get("cliente_ssx"), cliente_ssx)

        if campos_alterados:
            a_atualizar.append({"veiculo_id": veiculo["id"], "campos": campos_alterados})
        else:
            sem_mudanca += 1

    # "Não cadastrado" é especificamente sobre o RASTREADOR (id_equipamento
    # local sem correspondência na SSX) — veículo sem rastreador nunca entra
    # aqui, porque não há o que procurar (ver _codigo_local vs _codigos_possiveis_local).
    nao_cadastrados = [
        veiculo["id"] for veiculo in veiculos_locais
        if _codigo_local(veiculo) and veiculo["id"] not in ids_combinados
    ]

    return {"a_criar": a_criar, "a_atualizar": a_atualizar, "nao_cadastrados": nao_cadastrados, "sem_mudanca": sem_mudanca}


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
