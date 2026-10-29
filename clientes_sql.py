"""Acesso SQL a Cliente (Postgres) — substitui a coleção "clientes" do
Firestore em app.py (ver docs/HISTORICO_DECISOES.md).

`csm`/`vendedor` eram texto livre no Firestore; aqui ganham FK de verdade
pra Usuario (nullable — nem todo CS/vendedor tem login). `resolver_responsavel`
é o ponto único que resolve nome -> (usuario_id ou None, nome denormalizado),
reusado tanto por criar/atualizar_cliente quanto pela sincronização da
planilha de CS. O dropdown da tela manda o NOME (não o id — confirmado em
static/script.js, popularSelectUsuariosPorArea: `opt.value = u.nome`), então
hoje só o caminho "resolver por nome" é exercido de verdade.
"""
from decimal import Decimal

from sqlalchemy import func

from db_sql import obter_sessao, obter_sessao_leitura
from models import Cliente, Usuario


class IdCentralEmUsoError(Exception):
    """Já existe outro cliente com esse IdCentral."""


def resolver_responsavel(nome):
    nome = (nome or "").strip()
    if not nome:
        return None, ""
    with obter_sessao_leitura() as sessao:
        usuario = (
            sessao.query(Usuario)
            .filter(func.lower(Usuario.nome_responsavel) == nome.lower())
            .first()
        )
        return (usuario.id, nome) if usuario else (None, nome)


def _cliente_para_dict(c):
    return {
        "id": c.id,
        "idcentral": c.idcentral,
        "cliente": c.cliente,
        "tem_implantacao": c.tem_implantacao,
        "data_entrada": c.data_entrada,
        "objetivo": c.objetivo,
        "valor_contrato": float(c.valor_contrato),
        "responsavel_usuario_id": c.responsavel_usuario_id,
        "csm": c.csm_nome,
        "vendedor_usuario_id": c.vendedor_usuario_id,
        "vendedor": c.vendedor_nome,
        "etapa": c.etapa,
        "estagio": c.estagio,
        "momento": c.momento,
        "flag": c.flag,
        "persona": c.persona,
        "decisor_nome": c.decisor_nome,
        "decisor_whatsapp": c.decisor_whatsapp,
        "decisor_estado": c.decisor_estado,
        "decisor_cidade": c.decisor_cidade,
        "implantado": c.implantado,
        "implantado_em": c.implantado_em,
        "implantado_por": c.implantado_por,
        "concluido_em": c.concluido_em,
        "concluido_por": c.concluido_por,
        "marcos_concluidos": c.marcos_concluidos,
        "marcos_concluidos_em": c.marcos_concluidos_em,
        "marcos_atualizado_em": c.marcos_atualizado_em,
        "marcos_itens_feitos": c.marcos_itens_feitos,
        "marcos_itens_extras": c.marcos_itens_extras,
        "marcos_concluidos_manual": c.marcos_concluidos_manual,
        "marcos_prioridades": c.marcos_prioridades,
        "motivo_atraso": c.motivo_atraso,
        "ultima_acao": c.ultima_acao,
        "ultima_acao_data": c.ultima_acao_data,
        "codigo_idcentral": c.codigo_idcentral,
        "dados_planilha": c.dados_planilha,
    }


def listar_clientes():
    with obter_sessao_leitura() as sessao:
        clientes = sessao.query(Cliente).all()
        lista = [_cliente_para_dict(c) for c in clientes]
    lista.sort(key=lambda c: c["ultima_acao_data"], reverse=True)
    return lista


def contar_clientes_implantacao():
    """Total de clientes com implantação e quantos ainda estão ativos (etapa
    != "concluido") — usado pelo card "Implantação" do /api/dashboard.
    Substitui a contagem que lia direto do Firestore (coleção legada
    IMPLANTACAO_CLIENTES_COLLECTION, sem cliente novo desde a virada pra
    Postgres — ficava parada/errada). `tem_implantacao` filtra fora os
    clientes que só têm migração (criados pela tela de Migração, sem par em
    Implantação)."""
    with obter_sessao_leitura() as sessao:
        total = sessao.query(func.count(Cliente.id)).filter(Cliente.tem_implantacao.is_(True)).scalar() or 0
        concluidos = (
            sessao.query(func.count(Cliente.id))
            .filter(Cliente.tem_implantacao.is_(True), Cliente.etapa == "concluido")
            .scalar() or 0
        )
    return total, total - concluidos


def listar_clientes_resumo():
    """Igual a `listar_clientes`, mas só com as colunas usadas pela listagem
    de clientes em Migração (`_carregar_clientes_migracao` em app.py) — essa
    tela não precisa de `objetivo` (Text) nem dos JSON pesados (`marcos_*`,
    `dados_planilha`, linha crua da planilha de CS), então evita puxar essas
    colunas de TODOS os clientes só pra descartar na hora de montar a
    resposta."""
    with obter_sessao_leitura() as sessao:
        linhas = sessao.query(
            Cliente.id, Cliente.cliente, Cliente.idcentral, Cliente.csm_nome, Cliente.tem_implantacao,
        ).all()
    return [
        {"id": i, "cliente": nome, "idcentral": idcentral, "csm": csm, "tem_implantacao": tem_implantacao}
        for i, nome, idcentral, csm, tem_implantacao in linhas
    ]


def buscar_cliente_por_id(cliente_id):
    with obter_sessao_leitura() as sessao:
        c = sessao.get(Cliente, cliente_id)
        return _cliente_para_dict(c) if c else None


def buscar_cliente_por_idcentral(idcentral):
    with obter_sessao_leitura() as sessao:
        c = sessao.query(Cliente).filter(Cliente.idcentral == idcentral).first()
        return _cliente_para_dict(c) if c else None


def idcentral_em_uso(idcentral, excluir_id=None):
    with obter_sessao_leitura() as sessao:
        consulta = sessao.query(Cliente.id).filter(Cliente.idcentral == idcentral)
        if excluir_id is not None:
            consulta = consulta.filter(Cliente.id != excluir_id)
        return consulta.first() is not None


def idcentrals_existentes():
    """Set de todos os idcentral já cadastrados — usado pela importação em
    massa (1 consulta pra validar o arquivo inteiro, em vez de 1 por linha)."""
    with obter_sessao_leitura() as sessao:
        return {idc for (idc,) in sessao.query(Cliente.idcentral).all()}


def _aplicar_campos(alvo, campos):
    campos = dict(campos)
    if "csm" in campos:
        responsavel_usuario_id, csm_nome = resolver_responsavel(campos.pop("csm"))
        campos["responsavel_usuario_id"] = responsavel_usuario_id
        campos["csm_nome"] = csm_nome
    if "vendedor" in campos:
        vendedor_usuario_id, vendedor_nome = resolver_responsavel(campos.pop("vendedor"))
        campos["vendedor_usuario_id"] = vendedor_usuario_id
        campos["vendedor_nome"] = vendedor_nome
    valor_contrato = campos.get("valor_contrato")
    if valor_contrato is not None:
        campos["valor_contrato"] = Decimal(str(valor_contrato))
    for campo, valor in campos.items():
        setattr(alvo, campo, valor)


def criar_cliente(campos):
    with obter_sessao() as sessao:
        if sessao.query(Cliente.id).filter(Cliente.idcentral == campos["idcentral"]).first():
            raise IdCentralEmUsoError()
        novo = Cliente(idcentral=campos["idcentral"], cliente=campos.get("cliente", ""))
        _aplicar_campos(novo, {k: v for k, v in campos.items() if k not in ("idcentral",)})
        sessao.add(novo)
        sessao.flush()  # popula novo.id (serial) antes de montar o dict
        return _cliente_para_dict(novo)


def atualizar_cliente(cliente_id, campos):
    """Seta só os atributos passados em `campos` (dict com os mesmos nomes de
    chave que o dict de retorno usa — ex.: "csm"/"vendedor" como texto,
    resolvidos pra FK internamente). Levanta IdCentralEmUsoError se trocar
    pra um idcentral de outro cliente."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Cliente, cliente_id)
        if not alvo:
            return None
        novo_idcentral = campos.get("idcentral")
        if novo_idcentral is not None and novo_idcentral != alvo.idcentral:
            conflito = (
                sessao.query(Cliente.id)
                .filter(Cliente.idcentral == novo_idcentral, Cliente.id != cliente_id)
                .first()
            )
            if conflito:
                raise IdCentralEmUsoError()
        _aplicar_campos(alvo, campos)
        return _cliente_para_dict(alvo)


def contar_por_estagio(valores, padrao):
    # 1 SELECT só (ver mesmo ajuste em migracoes_sql._contar_por_coluna):
    # `estagio` nunca é NULL, então o total é a soma dos grupos.
    with obter_sessao_leitura() as sessao:
        linhas = dict(sessao.query(Cliente.estagio, func.count(Cliente.id)).group_by(Cliente.estagio).all())
    total = sum(linhas.values())
    contagem = {v: linhas.get(v, 0) for v in valores}
    contagem[padrao] = contagem.get(padrao, 0) + sum(c for v, c in linhas.items() if v not in valores)
    return contagem, total


def excluir_cliente(cliente_id):
    """ON DELETE CASCADE cuida de cliente_eventos/migracoes(+veiculos/modelos)/
    credenciais_cliente/tarefas sozinho; feed_posts.cliente_id é SET NULL (o
    post sobrevive, só perde o vínculo). Ler as tarefas ANTES de chamar isso
    se precisar registrar auditoria por tarefa (ver tarefas_sql.listar_por_cliente)
    — o cascade não dispara nenhum log."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Cliente, cliente_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True
