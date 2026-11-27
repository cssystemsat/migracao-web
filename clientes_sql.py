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

import objetivos_sql
from db_sql import obter_sessao, obter_sessao_leitura
from models import Cliente, Migracao, Usuario


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


# Fases de vida, em ordem (Implantação -> Onboarding -> Ongoing). Regra pros
# dados/KPIs de cada fase: só contam clientes que ENTRARAM nela ou numa fase
# anterior — cliente antigo cadastrado direto em Ongoing não entra em
# Implantação nem em Onboarding; direto em Onboarding não entra em
# Implantação. (Implantação, hoje, já filtra por `tem_implantacao`, que
# coincide com isso pra cliente novo; usar esta função nos KPIs de
# Onboarding/Ongoing quando eles existirem.)
FASES_VIDA_ORDEM = ["implantacao", "onboarding", "ongoing"]


def fases_entrada_que_contam(fase):
    """Valores de `fase_entrada` que contam nos dados da `fase` dada."""
    return FASES_VIDA_ORDEM[: FASES_VIDA_ORDEM.index(fase) + 1]


def _cliente_para_dict(c):
    return {
        "id": c.id,
        "idcentral": c.idcentral,
        "cliente": c.cliente,
        "tem_implantacao": c.tem_implantacao,
        "data_entrada": c.data_entrada,
        "objetivo": c.objetivo,
        "descricao_implantacao": c.descricao_implantacao,
        "valor_contrato": float(c.valor_contrato),
        "responsavel_usuario_id": c.responsavel_usuario_id,
        "csm": c.csm_nome,
        "vendedor_usuario_id": c.vendedor_usuario_id,
        "vendedor": c.vendedor_nome,
        "etapa": c.etapa,
        "estagio": c.estagio,
        "fase_entrada": c.fase_entrada,
        "momento": c.momento,
        "flag": c.flag,
        "persona": c.persona,
        "decisor_nome": c.decisor_nome,
        "decisor_whatsapp": c.decisor_whatsapp,
        "estado": c.estado,
        "cidade": c.cidade,
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
        "marcos_itens_datas": c.marcos_itens_datas,
        "marcos_concluidos_manual": c.marcos_concluidos_manual,
        "objetivos_implantacao": c.objetivos_implantacao,
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
        # "tem_migracoes": tem ou já teve migração (ativa ou no histórico) —
        # é o que decide se a Ficha mostra a aba Migração, e vem já na lista
        # pra lateral da Ficha nascer certa (ver abasFichaDoCliente no JS).
        com_migracao = {cid for (cid,) in sessao.query(Migracao.cliente_id).distinct()}
    for c in lista:
        c["tem_migracoes"] = c["id"] in com_migracao
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


def buscar_cliente_por_idcentral_wootric(idcentral_resposta):
    """Caminho inverso de `listar_avaliacoes_wootric_cliente` (que busca na
    Wootric por `codigo_idcentral or idcentral`) — aqui a Wootric já mandou o
    idcentral da resposta, e precisamos achar de volta o cliente: tenta por
    `codigo_idcentral` primeiro (é o valor usado de fato pra consultar a
    Wootric quando preenchido), senão por `idcentral`."""
    with obter_sessao_leitura() as sessao:
        c = sessao.query(Cliente).filter(Cliente.codigo_idcentral == idcentral_resposta).first()
        if not c:
            c = sessao.query(Cliente).filter(Cliente.idcentral == idcentral_resposta).first()
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
        resultado = _cliente_para_dict(novo)
        tem_implantacao = novo.tem_implantacao
    # Fora do `with` (já comitado) — cliente novo todo cliente de Implantação
    # recebe automaticamente o objetivo universal "IMPLANTAÇÃO" (ver plano
    # aprovado no histórico de decisões). Chamada única aqui cobre os 3 pontos
    # de criação de cliente (cadastro manual, sync de planilha de CS e
    # importação em lote), sem duplicar a lógica em cada um.
    if tem_implantacao:
        objetivos_sql.criar_objetivo_universal_para_cliente(resultado["id"])
    return resultado


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


def estatisticas_dashboard_crm(valores_estagio, padrao_estagio):
    """Totais gerais de todos os clientes (independente de estágio) pro
    Dashboard CRM — contagem por estágio (reaproveita `contar_por_estagio`),
    por CS e por Comercial responsável, soma de `valor_contrato` e contagem
    por estado (`por_uf`, separado por estágio + "geral" com todos — mapa do
    Dashboard CRM)."""
    por_estagio, total = contar_por_estagio(valores_estagio, padrao_estagio)
    with obter_sessao_leitura() as sessao:
        por_csm = dict(
            sessao.query(Cliente.csm_nome, func.count(Cliente.id)).group_by(Cliente.csm_nome).all()
        )
        por_vendedor = dict(
            sessao.query(Cliente.vendedor_nome, func.count(Cliente.id)).group_by(Cliente.vendedor_nome).all()
        )
        valor_contrato_total = sessao.query(func.coalesce(func.sum(Cliente.valor_contrato), 0)).scalar() or 0
        linhas_uf = (
            sessao.query(Cliente.estagio, Cliente.estado, func.count(Cliente.id))
            .group_by(Cliente.estagio, Cliente.estado)
            .all()
        )
    por_csm = {(nome or "Sem CS definido"): qtd for nome, qtd in por_csm.items()}
    por_vendedor = {(nome or "Sem comercial definido"): qtd for nome, qtd in por_vendedor.items()}

    por_uf = {v: {} for v in valores_estagio}
    por_uf["geral"] = {}
    for estagio, estado, qtd in linhas_uf:
        if not estado:
            continue
        estagio = estagio if estagio in valores_estagio else padrao_estagio
        por_uf.setdefault(estagio, {})
        por_uf[estagio][estado] = por_uf[estagio].get(estado, 0) + qtd
        por_uf["geral"][estado] = por_uf["geral"].get(estado, 0) + qtd

    return dict(
        total=total,
        por_estagio=por_estagio,
        por_csm=por_csm,
        por_vendedor=por_vendedor,
        valor_contrato_total=float(valor_contrato_total),
        por_uf=por_uf,
    )


def contar_por_etapa_implantacao(valores, padrao):
    """Igual a `contar_por_estagio`, mas agrupando por `etapa` (marco do
    Playbook) e só entre clientes com Implantação (`tem_implantacao`) — usado
    pelo Dashboard de Implantação."""
    with obter_sessao_leitura() as sessao:
        linhas = dict(
            sessao.query(Cliente.etapa, func.count(Cliente.id))
            .filter(Cliente.tem_implantacao.is_(True))
            .group_by(Cliente.etapa)
            .all()
        )
    total = sum(linhas.values())
    contagem = {v: linhas.get(v, 0) for v in valores}
    contagem[padrao] = contagem.get(padrao, 0) + sum(c for v, c in linhas.items() if v not in valores)
    return contagem, total


def contar_clientes_implantacao_iniciados(data_de=None, data_ate=None):
    """Clientes com Implantação cuja `data_entrada` cai dentro do período —
    "Implantações iniciadas" do Dashboard de Implantação. Sem período, conta
    todos (mesmo total de contar_clientes_implantacao)."""
    with obter_sessao_leitura() as sessao:
        consulta = sessao.query(func.count(Cliente.id)).filter(
            Cliente.tem_implantacao.is_(True), Cliente.data_entrada != "",
        )
        if data_de:
            consulta = consulta.filter(Cliente.data_entrada >= data_de.isoformat())
        if data_ate:
            consulta = consulta.filter(Cliente.data_entrada <= data_ate.isoformat())
        return consulta.scalar() or 0


def tempo_medio_implantacao():
    """Dias corridos entre `data_entrada` e `concluido_em`, só dos clientes já
    implantados (os dois campos são "AAAA-MM-DD" — ver Cliente). Clientes sem
    uma das duas datas (implantados antes de `concluido_em` existir, ver
    salvar_marcos_cliente em app.py) ficam fora da média, não zerados."""
    from datetime import date

    with obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(Cliente.data_entrada, Cliente.concluido_em)
            .filter(Cliente.tem_implantacao.is_(True), Cliente.etapa == "concluido")
            .all()
        )
    dias = []
    for data_entrada, concluido_em in linhas:
        if not data_entrada or not concluido_em:
            continue
        try:
            d1 = date.fromisoformat(data_entrada)
            d2 = date.fromisoformat(concluido_em)
        except ValueError:
            continue
        diferenca = (d2 - d1).days
        if diferenca >= 0:
            dias.append(diferenca)
    if not dias:
        return None, 0
    return round(sum(dias) / len(dias)), len(dias)


def listar_clientes_implantacao_atrasados():
    """Clientes ativos (não concluídos) com `motivo_atraso` registrado —
    usado pelo Dashboard de Implantação. `motivo_atraso` só vale enquanto
    preso ao marco em que foi registrado (ver salvar_motivo_atraso_cliente em
    app.py); aqui só contamos quantos têm o campo preenchido, sem comparar
    marco (a comparação fina já existe no front, em motivoAtrasoAtual)."""
    with obter_sessao_leitura() as sessao:
        total = (
            sessao.query(func.count(Cliente.id))
            .filter(
                Cliente.tem_implantacao.is_(True),
                Cliente.etapa != "concluido",
                Cliente.motivo_atraso.isnot(None),
            )
            .scalar() or 0
        )
    return total


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


def listar_clientes_do_usuario(usuario_id):
    """Carteira de um funcionário pra página da Equipe: clientes em que ele é
    o responsável (CS) e/ou o consultor comercial (vendedor)."""
    with obter_sessao_leitura() as sessao:
        clientes = (
            sessao.query(Cliente)
            .filter((Cliente.responsavel_usuario_id == usuario_id) | (Cliente.vendedor_usuario_id == usuario_id))
            .all()
        )
        lista = []
        for c in clientes:
            papeis = []
            if c.responsavel_usuario_id == usuario_id:
                papeis.append("responsavel")
            if c.vendedor_usuario_id == usuario_id:
                papeis.append("comercial")
            lista.append({
                "id": c.id, "idcentral": c.idcentral, "cliente": c.cliente,
                "estagio": c.estagio, "cidade": c.cidade, "estado": c.estado, "papeis": papeis,
            })
    lista.sort(key=lambda c: (c["cliente"] or "").lower())
    return lista
