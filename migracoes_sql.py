"""Acesso SQL a Migração (tentativa de migração de um Cliente) + Veículos +
Modelos de comando locais por migração. Substitui clientes/<id>/migracoes/<id>
(+ subcoleções veiculos/modelos_comando) do Firestore.

`senha_acesso_origem` é cifrada (criptografia.py) — o dict devolvido pra
app.py sempre traz a senha em texto puro na mesma chave de antes, a rota não
precisa saber que existe criptografia.
"""
from sqlalchemy import func

import criptografia
from db_sql import obter_sessao, obter_sessao_leitura
from models import Migracao, MigracaoModeloComando, MigracaoVeiculo


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


def atualizar_veiculo(veiculo_id, campos):
    with obter_sessao() as sessao:
        alvo = sessao.get(MigracaoVeiculo, veiculo_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
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
            campos["status"] = v.get("status", "Aguardando")
            existente = existentes.get((cliente, veiculo))
            if existente:
                for campo, valor in campos.items():
                    setattr(existente, campo, valor)
            else:
                novo = MigracaoVeiculo(migracao_id=migracao_id, cliente=cliente, veiculo=veiculo, **campos)
                sessao.add(novo)
                existentes[(cliente, veiculo)] = novo


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
    return _contar_por_coluna(MigracaoVeiculo.status, valores, padrao)
