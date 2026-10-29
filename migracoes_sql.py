"""Acesso SQL a Migração (tentativa de migração de um Cliente) + Veículos +
Modelos de comando locais por migração. Substitui clientes/<id>/migracoes/<id>
(+ subcoleções veiculos/modelos_comando) do Firestore.

`senha_acesso_origem` é cifrada (criptografia.py) — o dict devolvido pra
app.py sempre traz a senha em texto puro na mesma chave de antes, a rota não
precisa saber que existe criptografia.
"""
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, or_

import criptografia
from db_sql import obter_sessao, obter_sessao_leitura
import migracao_status
from models import Migracao, MigracaoModeloComando, MigracaoSsxSyncJob, MigracaoVeiculo


def _migracao_para_dict(m):
    return {
        "id": m.id,
        "cliente_id": m.cliente_id,
        "plataforma_origem": m.plataforma_origem,
        "link_planilha": m.link_planilha,
        "link_acesso_origem": m.link_acesso_origem,
        "login_acesso_origem": m.login_acesso_origem,
        "senha_acesso_origem": criptografia.decifrar(m.senha_acesso_origem_cifrada),
        "qtd_clientes": m.qtd_clientes,
        "qtd_placas": m.qtd_placas,
        "percentual_migracao": m.percentual_migracao,
        "percentual_atualizado_em": m.percentual_atualizado_em,
        "etapa": m.etapa,
        "status": m.status,
        "data_inicio": m.data_inicio,
        "data_fim": m.data_fim,
        "motivo": m.motivo,
    }


def _veiculo_para_dict(v):
    return {
        "id": v.id, "cliente": v.cliente, "veiculo": v.veiculo,
        "equipamento": v.equipamento, "id_equipamento": v.id_equipamento,
        "apn": v.apn, "ls_apn": v.ls_apn, "numero_linha": v.numero_linha,
        "comando": v.comando, "ultima_comunicacao": v.ultima_comunicacao,
        "status": v.status,
        "codigo_integracao_veiculo_ssx": v.codigo_integracao_veiculo_ssx,
        "codigo_integracao_rastreador_ssx": v.codigo_integracao_rastreador_ssx,
        "cliente_ssx": v.cliente_ssx,
        "migracao_confirmada_ssx": v.migracao_confirmada_ssx,
        "migracao_confirmada_em": v.migracao_confirmada_em,
    }


def _modelo_para_dict(m):
    return {"id": m.id, "modelo": m.modelo, "porta": m.porta, "comando_template": m.comando_template}


# --- Migração ---

def listar_migracoes(cliente_id):
    with obter_sessao_leitura() as sessao:
        migs = sessao.query(Migracao).filter(Migracao.cliente_id == cliente_id).all()
        lista = [_migracao_para_dict(m) for m in migs]
    lista.sort(key=lambda m: m.get("data_inicio") or "", reverse=True)
    return lista


def listar_migracoes_todas_por_cliente():
    """Mesmo dado de `listar_migracoes`, mas pra TODOS os clientes de uma vez
    só (1 SELECT) — usado pela listagem da tela de Migração
    (`_carregar_clientes_migracao` em app.py), que senão faria 1 SELECT por
    cliente num loop em Python (N+1: lenta e escala mal com a base de
    clientes). Devolve {cliente_id: [migrações, mais recente primeiro]}."""
    with obter_sessao_leitura() as sessao:
        migs = sessao.query(Migracao).all()
        lista = [_migracao_para_dict(m) for m in migs]
    por_cliente = {}
    for m in lista:
        por_cliente.setdefault(m["cliente_id"], []).append(m)
    for migracoes in por_cliente.values():
        migracoes.sort(key=lambda m: m.get("data_inicio") or "", reverse=True)
    return por_cliente


def tem_migracao_em_andamento(cliente_id):
    with obter_sessao_leitura() as sessao:
        return sessao.query(Migracao.id).filter(
            Migracao.cliente_id == cliente_id, Migracao.status == "em_andamento"
        ).first() is not None


def iniciar_migracao(cliente_id, plataforma_origem, link_planilha, data_inicio):
    nova = Migracao(
        cliente_id=cliente_id, plataforma_origem=plataforma_origem,
        link_planilha=link_planilha, data_inicio=data_inicio,
    )
    with obter_sessao() as sessao:
        sessao.add(nova)
        sessao.flush()
        return _migracao_para_dict(nova)


def buscar_migracao(migracao_id):
    with obter_sessao_leitura() as sessao:
        m = sessao.get(Migracao, migracao_id)
        return _migracao_para_dict(m) if m else None


def editar_migracao(migracao_id, campos):
    campos = dict(campos)
    if "senha_acesso_origem" in campos:
        campos["senha_acesso_origem_cifrada"] = criptografia.cifrar(campos.pop("senha_acesso_origem"))
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
        return _migracao_para_dict(alvo)


def finalizar_migracao(migracao_id, data_fim):
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if not alvo:
            return None
        alvo.status = "concluida"
        alvo.data_fim = data_fim
        return _migracao_para_dict(alvo)


def cancelar_migracao(migracao_id, data_fim, motivo):
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if not alvo:
            return None
        alvo.status = "cancelada"
        alvo.data_fim = data_fim
        alvo.motivo = motivo
        return _migracao_para_dict(alvo)


def atualizar_link_planilha(migracao_id, link):
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if alvo:
            alvo.link_planilha = link


def atualizar_contagens(migracao_id, qtd_clientes=None, qtd_placas=None, percentual_migracao=None):
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if not alvo:
            return None
        if qtd_clientes is not None:
            alvo.qtd_clientes = qtd_clientes
        if qtd_placas is not None:
            alvo.qtd_placas = qtd_placas
        if percentual_migracao is not None:
            alvo.percentual_migracao = percentual_migracao
        return _migracao_para_dict(alvo)


def atualizar_percentual(migracao_id, percentual, atualizado_em):
    with obter_sessao() as sessao:
        alvo = sessao.get(Migracao, migracao_id)
        if alvo:
            alvo.percentual_migracao = percentual
            alvo.percentual_atualizado_em = atualizado_em


# --- Veículos ---

def listar_veiculos(migracao_id):
    with obter_sessao_leitura() as sessao:
        veiculos = (
            sessao.query(MigracaoVeiculo)
            .filter(MigracaoVeiculo.migracao_id == migracao_id)
            .order_by(MigracaoVeiculo.cliente, MigracaoVeiculo.veiculo)
            .all()
        )
        return [_veiculo_para_dict(v) for v in veiculos]


# Campo pedido pela tela (ordenação de coluna) -> coluna real do model. Só os
# campos que a tabela da tela deixa clicar pra ordenar (ver
# CAMPOS_ORDENACAO_VEICULOS em script.js) entram aqui.
_COLUNAS_ORDENACAO_VEICULOS = {
    "status": MigracaoVeiculo.status,
    "migracao_confirmada_ssx": MigracaoVeiculo.migracao_confirmada_ssx,
    "cliente": MigracaoVeiculo.cliente,
    "veiculo": MigracaoVeiculo.veiculo,
    "equipamento": MigracaoVeiculo.equipamento,
    "id_equipamento": MigracaoVeiculo.id_equipamento,
    "apn": MigracaoVeiculo.apn,
    "ls_apn": MigracaoVeiculo.ls_apn,
    "numero_linha": MigracaoVeiculo.numero_linha,
    "comando": MigracaoVeiculo.comando,
    "ultima_comunicacao": MigracaoVeiculo.ultima_comunicacao,
}


# Colunas de texto com caixa de filtro "contém" própria embaixo do cabeçalho
# (estilo Excel) — ver trFiltros em script.js. Fora daqui: "status" (já tem
# os chips) e "migracao_confirmada_ssx" (booleano, sem texto pra conter).
_COLUNAS_FILTRAVEIS_POR_COLUNA = {
    "cliente": MigracaoVeiculo.cliente,
    "veiculo": MigracaoVeiculo.veiculo,
    "equipamento": MigracaoVeiculo.equipamento,
    "id_equipamento": MigracaoVeiculo.id_equipamento,
    "apn": MigracaoVeiculo.apn,
    "ls_apn": MigracaoVeiculo.ls_apn,
    "numero_linha": MigracaoVeiculo.numero_linha,
    "comando": MigracaoVeiculo.comando,
    "ultima_comunicacao": MigracaoVeiculo.ultima_comunicacao,
}


def listar_veiculos_pagina(
    migracao_id, pagina=0, tamanho=100, busca="", status="", ordenar_por=None, ordem_asc=True, filtros_coluna=None,
):
    """Igual a `listar_veiculos`, mas filtra/ordena/pagina no banco em vez de
    trazer tudo pra memória — essencial pra central grande (ex. Cartracking),
    onde buscar e ordenar a lista inteira no front travava a tela. Devolve
    (itens_da_pagina, total_depois_do_filtro).

    `filtros_coluna` é {campo: texto} (uma caixa de filtro por coluna, estilo
    Excel — ver trFiltros em script.js), combinado em E com `busca` (busca
    geral) e `status` (chip)."""
    with obter_sessao_leitura() as sessao:
        query = sessao.query(MigracaoVeiculo).filter(MigracaoVeiculo.migracao_id == migracao_id)
        if status:
            query = query.filter(MigracaoVeiculo.status == status)
        if busca:
            padrao = f"%{busca}%"
            query = query.filter(
                (MigracaoVeiculo.cliente.ilike(padrao))
                | (MigracaoVeiculo.veiculo.ilike(padrao))
                | (MigracaoVeiculo.equipamento.ilike(padrao))
            )
        for campo, texto in (filtros_coluna or {}).items():
            coluna_filtro = _COLUNAS_FILTRAVEIS_POR_COLUNA.get(campo)
            if coluna_filtro is not None and texto:
                query = query.filter(coluna_filtro.ilike(f"%{texto}%"))
        total = query.count()
        coluna = _COLUNAS_ORDENACAO_VEICULOS.get(ordenar_por, MigracaoVeiculo.cliente)
        query = query.order_by(
            coluna.asc() if ordem_asc else coluna.desc(),
            MigracaoVeiculo.cliente.asc(), MigracaoVeiculo.veiculo.asc(),
        )
        itens = query.offset(pagina * tamanho).limit(tamanho).all()
        return [_veiculo_para_dict(v) for v in itens], total


def calcular_resumo_veiculos(migracao_id):
    """Contagens agregadas (chips de status + "migrado/total" por cliente)
    calculadas no banco — usadas pela tela em vez de somar a lista inteira em
    memória, que é o que ficava lento em central grande."""
    with obter_sessao_leitura() as sessao:
        por_status = dict(
            sessao.query(MigracaoVeiculo.status, func.count())
            .filter(MigracaoVeiculo.migracao_id == migracao_id)
            .group_by(MigracaoVeiculo.status)
            .all()
        )
        linhas_cliente = (
            sessao.query(
                MigracaoVeiculo.cliente,
                func.count(),
                func.sum(case((MigracaoVeiculo.status == "Migrado", 1), else_=0)),
            )
            .filter(
                MigracaoVeiculo.migracao_id == migracao_id,
                MigracaoVeiculo.status.notin_(["Cancelado", "Sem rastreador"]),
            )
            .group_by(MigracaoVeiculo.cliente)
            .all()
        )
    por_cliente = {
        cliente: {"total": total, "migrado": int(migrado or 0)}
        for cliente, total, migrado in linhas_cliente
        if cliente
    }
    return {"por_status": por_status, "total": sum(por_status.values()), "por_cliente": por_cliente}


def atualizar_veiculo(veiculo_id, campos):
    with obter_sessao() as sessao:
        alvo = sessao.get(MigracaoVeiculo, veiculo_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
        alvo.status = migracao_status.normalizar_status_veiculo(alvo.status, alvo.id_equipamento)
        return _veiculo_para_dict(alvo)


def excluir_veiculo(veiculo_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(MigracaoVeiculo, veiculo_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


CAMPOS_VEICULO_ITEM = [
    "equipamento", "id_equipamento", "apn", "ls_apn", "numero_linha", "comando", "ultima_comunicacao",
]


def salvar_item_veiculo(migracao_id, item):
    """Upsert de 1 veículo por (migracao_id, cliente, veiculo) — substitui o
    hash determinístico do Firestore. `item.get("id")` de um registro
    existente (não "novo-...") permite renomear cliente/veículo preservando
    o `status` já salvo; senão casa pela unique constraint ou cria."""
    cliente = str(item.get("cliente", "")).strip()
    veiculo = str(item.get("veiculo", "")).strip()
    if not cliente or not veiculo:
        return None
    campos = {c: str(item.get(c, "")) for c in CAMPOS_VEICULO_ITEM}
    antigo_id = item.get("id")

    with obter_sessao() as sessao:
        alvo = None
        if antigo_id and not str(antigo_id).startswith("novo-"):
            candidato = sessao.get(MigracaoVeiculo, antigo_id)
            if candidato and candidato.migracao_id == migracao_id:
                alvo = candidato
        if alvo:
            alvo.cliente = cliente
            alvo.veiculo = veiculo
            for campo, valor in campos.items():
                setattr(alvo, campo, valor)
        else:
            existente = sessao.query(MigracaoVeiculo).filter_by(
                migracao_id=migracao_id, cliente=cliente, veiculo=veiculo
            ).first()
            if existente:
                for campo, valor in campos.items():
                    setattr(existente, campo, valor)
                alvo = existente
            else:
                alvo = MigracaoVeiculo(
                    migracao_id=migracao_id, cliente=cliente, veiculo=veiculo,
                    status="Aguardando", **campos,
                )
                sessao.add(alvo)
        alvo.status = migracao_status.normalizar_status_veiculo(alvo.status, alvo.id_equipamento)
        sessao.flush()
        return _veiculo_para_dict(alvo)


def importar_veiculos_planilha(migracao_id, veiculos):
    """Upsert em massa — diferente de salvar_item_veiculo, o `status` SEMPRE
    vem da planilha (nunca preserva o anterior), já que é lá que o time
    marca Aguardando/Enviar/Enviado/Migrado.

    Carrega TODOS os veículos já cadastrados dessa migração numa única
    consulta (em vez de 1 SELECT por linha da planilha dentro do loop, que
    em frota grande virava centenas/milhares de ida-e-volta ao banco) e
    decide em memória o que é update e o que é insert."""
    with obter_sessao() as sessao:
        existentes = {
            (v.cliente, v.veiculo): v
            for v in sessao.query(MigracaoVeiculo).filter(MigracaoVeiculo.migracao_id == migracao_id).all()
        }
        for v in veiculos:
            cliente, veiculo = v["cliente"], v["veiculo"]
            campos = {c: str(v.get(c, "")) for c in CAMPOS_VEICULO_ITEM}
            campos["status"] = migracao_status.normalizar_status_veiculo(
                v.get("status", "Aguardando"),
                campos.get("id_equipamento"),
            )
            existente = existentes.get((cliente, veiculo))
            if existente:
                for campo, valor in campos.items():
                    setattr(existente, campo, valor)
            else:
                novo = MigracaoVeiculo(migracao_id=migracao_id, cliente=cliente, veiculo=veiculo, **campos)
                sessao.add(novo)
                existentes[(cliente, veiculo)] = novo


# --- Sincronização com a SSX (ver ssx_veiculos_sync.py pro cálculo do diff) ---

def aplicar_sincronizacao_ssx(migracao_id, criacoes, atualizacoes):
    """Grava o que o usuário aprovou no modal de confirmação.
    `criacoes` é a lista de dicts {"campos": {...}} (veículo da SSX sem linha
    local ainda — caso normal logo depois de zerar a tabela, ver "Passo 0" do
    plano) e `atualizacoes` é {"veiculo_id", "campos": {campo: (atual,
    novo)}}, ambos devolvidos por `ssx_veiculos_sync.calcular_diff_sincronizacao`
    (ou reenviados do front depois da aprovação). Nunca deleta — só cria o
    que falta e atualiza o que já existe."""
    criadas = 0
    atualizados = 0
    with obter_sessao() as sessao:
        criadas, atualizados = _aplicar_sincronizacao_ssx_na_sessao(
            sessao, migracao_id, criacoes, atualizacoes
        )
    return criadas, atualizados


def _aplicar_sincronizacao_ssx_na_sessao(sessao, migracao_id, criacoes, atualizacoes):
    criadas = 0
    atualizados = 0
    # Evita bater na UniqueConstraint(migracao_id, cliente, veiculo) no meio
    # do lote; uma duplicata não deve abortar as demais criações/atualizações.
    pares_existentes = {
        (cliente, veiculo)
        for cliente, veiculo in sessao.query(MigracaoVeiculo.cliente, MigracaoVeiculo.veiculo)
        .filter(MigracaoVeiculo.migracao_id == migracao_id)
        .all()
    }
    for item in criacoes:
        par = (item["campos"]["cliente"], item["campos"]["veiculo"])
        if par in pares_existentes:
            continue
        campos = dict(item["campos"])
        campos["status"] = migracao_status.normalizar_status_veiculo(
            campos.get("status", "Aguardando"),
            campos.get("id_equipamento"),
        )
        sessao.add(MigracaoVeiculo(migracao_id=migracao_id, **campos))
        pares_existentes.add(par)
        criadas += 1

    if atualizacoes:
        ids = [item["veiculo_id"] for item in atualizacoes]
        veiculos = {
            veiculo.id: veiculo
            for veiculo in sessao.query(MigracaoVeiculo).filter(MigracaoVeiculo.id.in_(ids)).all()
        }
        for item in atualizacoes:
            alvo = veiculos.get(item["veiculo_id"])
            if not alvo:
                continue
            for campo, (_antigo, novo) in item["campos"].items():
                setattr(alvo, campo, novo)
            alvo.status = migracao_status.normalizar_status_veiculo(alvo.status, alvo.id_equipamento)
            atualizados += 1
    return criadas, atualizados


def criar_job_sincronizacao_ssx(migracao_id, job_id):
    """Cria um job durável; jobs antigos são descartados após sete dias."""
    limite = datetime.now(timezone.utc) - timedelta(days=7)
    with obter_sessao() as sessao:
        sessao.query(MigracaoSsxSyncJob).filter(
            MigracaoSsxSyncJob.criado_em < limite
        ).delete(synchronize_session=False)
        sessao.add(MigracaoSsxSyncJob(job_id=job_id, migracao_id=migracao_id, status="rodando"))


def atualizar_job_sincronizacao_ssx(job_id, status, diff=None, erro=None):
    with obter_sessao() as sessao:
        job = sessao.get(MigracaoSsxSyncJob, job_id)
        if not job:
            return False
        job.status = status
        job.diff = diff
        job.erro = erro
        return True


def buscar_job_sincronizacao_ssx(migracao_id, job_id):
    with obter_sessao_leitura() as sessao:
        job = (
            sessao.query(MigracaoSsxSyncJob)
            .filter(
                MigracaoSsxSyncJob.job_id == job_id,
                MigracaoSsxSyncJob.migracao_id == migracao_id,
            )
            .one_or_none()
        )
        if not job:
            return None
        return {
            "status": job.status,
            "diff": job.diff,
            "erro": job.erro,
            "resultado": job.resultado,
        }


def aplicar_job_sincronizacao_ssx(migracao_id, job_id):
    """Aplica a prévia e marca o job na mesma transação para evitar reaplicação."""
    with obter_sessao() as sessao:
        job = (
            sessao.query(MigracaoSsxSyncJob)
            .filter(MigracaoSsxSyncJob.job_id == job_id)
            .with_for_update()
            .one_or_none()
        )
        if not job or job.migracao_id != migracao_id:
            return None, "nao_encontrado"
        if job.status == "aplicado":
            return {**(job.resultado or {}), "ja_aplicado": True}, None
        if job.status != "concluido" or not job.diff:
            return None, "nao_concluido"

        diff = job.diff
        criadas, atualizados = _aplicar_sincronizacao_ssx_na_sessao(
            sessao, migracao_id, diff["a_criar"], diff["a_atualizar"]
        )
        _recalcular_e_persistir_progresso_na_sessao(sessao, migracao_id)
        job.status = "aplicado"
        job.resultado = {
            "criadas": criadas,
            "atualizados": atualizados,
            "nao_cadastrados": diff["nao_cadastrados"],
        }
        job.diff = None
        job.erro = None
        return job.resultado, None


def calcular_resumo_modelos_local(migracao_id):
    """Mesmo formato de `planilha_migracao.ler_resumo_modelos_planilha_migracao`
    (lista de dicts modelo/percentual/aguardando/enviar/enviado/comunicou/total
    + uma linha "Total"), mas calculado em cima de `migracao_veiculos` —
    pedido do usuário pra não depender mais da planilha do Google, já que a
    tabela agora é alimentada pela própria API da SSX. "Migrado" é a coluna
    que conta como "Comunicou" (não existe um status literal "Comunicou" no
    banco, ver STATUS_VEICULO_VALIDOS em app.py)."""
    with obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(MigracaoVeiculo.equipamento, MigracaoVeiculo.status)
            .filter(MigracaoVeiculo.migracao_id == migracao_id)
            .all()
        )

    return migracao_status.calcular_resumo_modelos(linhas)


def recalcular_e_persistir_progresso(migracao_id):
    """Normaliza status e atualiza contagens/progresso, sem incluir cancelados
    nem veículos sem rastreador."""
    with obter_sessao() as sessao:
        return _recalcular_e_persistir_progresso_na_sessao(sessao, migracao_id)


def _sem_id_equipamento(coluna):
    return or_(coluna.is_(None), coluna == "")


def _recalcular_e_persistir_progresso_na_sessao(sessao, migracao_id):
    """Normaliza status/confirmação em 3 UPDATEs em massa (só nas linhas que
    realmente precisam mudar — a imensa maioria já chega normalizada de quem
    grava, ver atualizar_veiculo/_aplicar_sincronizacao_ssx_na_sessao/
    aplicar_status_comunicacao_ssx) e calcula as contagens com agregação SQL.

    Antes carregava TODO veículo da migração pra um objeto Python e reatribuía
    status/confirmação um por um — mesmo sem mudar nada, cada linha entrava no
    UPDATE do commit. Isso roda a cada edição de UM campo de UM veículo (ver
    chamadas em app.py), então numa central grande (ex. Cartracking, milhares
    de linhas) toda edição disparava milhares de UPDATEs individuais — a causa
    real da demora/erro de timeout no painel de Migração em produção."""
    base = sessao.query(MigracaoVeiculo).filter(MigracaoVeiculo.migracao_id == migracao_id)

    # normalizar_status_veiculo: sem id_equipamento -> "Sem rastreador"
    # (Cancelado nunca muda); com id_equipamento, "Sem rastreador" -> "Aguardando".
    base.filter(
        MigracaoVeiculo.status.notin_(["Cancelado", "Sem rastreador"]),
        _sem_id_equipamento(MigracaoVeiculo.id_equipamento),
    ).update({"status": "Sem rastreador"}, synchronize_session=False)
    base.filter(
        MigracaoVeiculo.status == "Sem rastreador",
        MigracaoVeiculo.id_equipamento.isnot(None),
        MigracaoVeiculo.id_equipamento != "",
    ).update({"status": "Aguardando"}, synchronize_session=False)

    # normalizar_confirmacao_sem_rastreador: sem id_equipamento, a confirmação
    # não pode se sustentar — limpa; com id_equipamento, nunca é tocada aqui.
    base.filter(
        MigracaoVeiculo.migracao_confirmada_ssx.is_(True),
        _sem_id_equipamento(MigracaoVeiculo.id_equipamento),
    ).update({"migracao_confirmada_ssx": False, "migracao_confirmada_em": None}, synchronize_session=False)

    incluidos = base.filter(MigracaoVeiculo.status.notin_(["Cancelado", "Sem rastreador"]))
    total = incluidos.count()
    qtd_clientes = incluidos.with_entities(func.count(func.distinct(MigracaoVeiculo.cliente))).scalar() or 0
    qtd_placas = incluidos.with_entities(func.count(func.distinct(MigracaoVeiculo.veiculo))).scalar() or 0
    migrados = incluidos.filter(MigracaoVeiculo.status == "Migrado").count()
    percentual = round(100 * migrados / total) if total else 0

    migracao = sessao.get(Migracao, migracao_id)
    if migracao:
        migracao.qtd_clientes = qtd_clientes
        migracao.qtd_placas = qtd_placas
        migracao.percentual_migracao = percentual
    return {
        "qtd_clientes": qtd_clientes,
        "qtd_placas": qtd_placas,
        "percentual_migracao": percentual,
    }


def aplicar_status_comunicacao_ssx(resultados):
    """`migracao_confirmada_ssx`/`migracao_confirmada_em` são o marco (evento
    único — "já comunicou pela primeira vez") e só são gravados na PRIMEIRA
    vez que um veículo é confirmado; continuam gravados se a consulta futura
    não encontrar o equipamento, mas são limpos pela normalização quando o
    próprio ID do rastreador está vazio.

    Já `status = "Migrado"` (valor válido equivalente a "Comunicou" da
    planilha, ver STATUS_VEICULO_VALIDOS em app.py) é aplicado em TODO
    veículo confirmado nesta chamada, mesmo quem já estava confirmado de
    antes — toda vez que "Verificar comunicação" roda, não só na primeira
    confirmação (pedido explícito do usuário: sem isso, quem confirmou numa
    rodada anterior nunca teria o status corrigido/reafirmado depois)."""
    ids_confirmados = [veiculo_id for veiculo_id, r in resultados.items() if r.get("confirma_migracao")]
    if not ids_confirmados:
        return 0
    with obter_sessao() as sessao:
        confirmados = (
            sessao.query(MigracaoVeiculo).filter(MigracaoVeiculo.id.in_(ids_confirmados)).all()
        )
        agora = time.strftime("%Y-%m-%d %H:%M:%S")
        novos = 0
        for veiculo in confirmados:
            veiculo.status = migracao_status.normalizar_status_veiculo(veiculo.status, veiculo.id_equipamento)
            if not migracao_status.veiculo_conta_na_migracao(veiculo.status):
                continue
            (
                veiculo.migracao_confirmada_ssx,
                veiculo.migracao_confirmada_em,
            ) = migracao_status.normalizar_confirmacao_sem_rastreador(
                veiculo.migracao_confirmada_ssx,
                veiculo.migracao_confirmada_em,
                veiculo.id_equipamento,
            )
            if not veiculo.migracao_confirmada_ssx:
                veiculo.migracao_confirmada_ssx = True
                veiculo.migracao_confirmada_em = agora
                novos += 1
            veiculo.status = "Migrado"
        return novos


# --- Modelos de comando (catálogo local por migração) ---

def listar_modelos(migracao_id):
    with obter_sessao_leitura() as sessao:
        modelos = sessao.query(MigracaoModeloComando).filter(MigracaoModeloComando.migracao_id == migracao_id).all()
        lista = [_modelo_para_dict(m) for m in modelos]
    lista.sort(key=lambda m: (m.get("modelo") or "").lower())
    return lista


def salvar_modelo(migracao_id, modelo_id, dados):
    """modelo_id=None cria; senão edita. Reaplica o comando resolvido nos
    veículos já cadastrados cujo "equipamento" bate (case-insensitive) com o
    modelo. Retorna (dados, veiculos_atualizados), ou None se modelo_id
    informado não existir nessa migração."""
    with obter_sessao() as sessao:
        if modelo_id:
            alvo = sessao.get(MigracaoModeloComando, modelo_id)
            if not alvo or alvo.migracao_id != migracao_id:
                return None
            alvo.modelo = dados["modelo"]
            alvo.porta = dados["porta"]
            alvo.comando_template = dados["comando_template"]
        else:
            alvo = MigracaoModeloComando(migracao_id=migracao_id, **dados)
            sessao.add(alvo)
            sessao.flush()

        comando_resolvido = (dados["comando_template"] or "").replace("{porta}", dados["porta"] or "")
        modelo_norm = dados["modelo"].strip().lower()
        atualizados = (
            sessao.query(MigracaoVeiculo)
            .filter(
                MigracaoVeiculo.migracao_id == migracao_id,
                func.lower(MigracaoVeiculo.equipamento) == modelo_norm,
            )
            .update({"comando": comando_resolvido}, synchronize_session=False)
        )
        return _modelo_para_dict(alvo), atualizados


def excluir_modelo(modelo_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(MigracaoModeloComando, modelo_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


# --- Contagens agregadas (Dashboard) ---

def _contar_por_coluna(coluna, valores, padrao):
    # 1 SELECT só: `coluna` nunca é NULL (sempre tem default no model), então
    # o total é a soma dos grupos — não precisa de uma 2ª consulta repetindo
    # a mesma contagem só pra pegar o agregado total.
    with obter_sessao_leitura() as sessao:
        linhas = dict(sessao.query(coluna, func.count(coluna)).group_by(coluna).all())
    total = sum(linhas.values())
    contagem = {v: linhas.get(v, 0) for v in valores}
    contagem[padrao] = contagem.get(padrao, 0) + sum(c for v, c in linhas.items() if v not in valores)
    return contagem, total


def contar_por_etapa(valores, padrao):
    return _contar_por_coluna(Migracao.etapa, valores, padrao)


def contar_por_status(valores, padrao):
    return _contar_por_coluna(Migracao.status, valores, padrao)


def contar_veiculos_por_status(valores, padrao):
    with obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(MigracaoVeiculo.status, MigracaoVeiculo.id_equipamento, func.count(MigracaoVeiculo.id))
            .group_by(MigracaoVeiculo.status, MigracaoVeiculo.id_equipamento)
            .all()
        )
    contagem = {valor: 0 for valor in valores}
    total = 0
    for status, id_equipamento, quantidade in linhas:
        status = migracao_status.normalizar_status_veiculo(status, id_equipamento)
        if not migracao_status.veiculo_conta_na_migracao(status):
            continue
        contagem[status if status in contagem else padrao] += quantidade
        total += quantidade
    return contagem, total
