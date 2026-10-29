"""Regras de status e contagem dos veículos em processo de migração."""

STATUS_VEICULO_SEM_RASTREADOR = "Sem rastreador"
STATUS_VEICULO_CANCELADO = "Cancelado"
STATUS_VEICULO_FORA_DA_CONTAGEM = {
    STATUS_VEICULO_SEM_RASTREADOR,
    STATUS_VEICULO_CANCELADO,
}

_STATUS_PARA_COLUNA_RESUMO = {
    "Aguardando": "aguardando",
    "Enviar": "enviar",
    "Enviado": "enviado",
    "Migrado": "comunicou",
}


def normalizar_status_veiculo(status, id_equipamento):
    """Deriva o estado sem rastreador do ID informado na ficha.

    Cancelado é uma decisão explícita e prevalece mesmo quando não há
    rastreador. Ao cadastrar um ID num veículo marcado sem rastreador, ele
    volta para Aguardando, sem alterar os demais status válidos.
    """
    status = str(status or "Aguardando").strip()
    if status == STATUS_VEICULO_CANCELADO:
        return status
    if not str(id_equipamento or "").strip():
        return STATUS_VEICULO_SEM_RASTREADOR
    if status == STATUS_VEICULO_SEM_RASTREADOR:
        return "Aguardando"
    return status


def normalizar_confirmacao_sem_rastreador(confirmada, confirmada_em, id_equipamento):
    """Remove confirmações que não podem ser sustentadas sem ID do rastreador."""
    if not str(id_equipamento or "").strip():
        return False, None
    return bool(confirmada), confirmada_em


def veiculo_conta_na_migracao(status):
    return status not in STATUS_VEICULO_FORA_DA_CONTAGEM


def calcular_resumo_modelos(linhas):
    por_modelo = {}
    total_geral = {"aguardando": 0, "enviar": 0, "enviado": 0, "comunicou": 0, "total": 0}
    for equipamento, status in linhas:
        if not veiculo_conta_na_migracao(status):
            continue
        modelo = equipamento or "(sem modelo)"
        bucket = por_modelo.setdefault(modelo, {"aguardando": 0, "enviar": 0, "enviado": 0, "comunicou": 0, "total": 0})
        campo = _STATUS_PARA_COLUNA_RESUMO.get(status)
        if campo:
            bucket[campo] += 1
            total_geral[campo] += 1
        bucket["total"] += 1
        total_geral["total"] += 1

    resumo = []
    for modelo in sorted(por_modelo):
        contagem = por_modelo[modelo]
        pct = round(100 * contagem["comunicou"] / contagem["total"]) if contagem["total"] else 0
        resumo.append({"modelo": modelo, "percentual": f"{pct}%", **contagem})

    pct_total = round(100 * total_geral["comunicou"] / total_geral["total"]) if total_geral["total"] else 0
    resumo.append({"modelo": "Total", "percentual": f"{pct_total}%", **total_geral})
    return resumo
