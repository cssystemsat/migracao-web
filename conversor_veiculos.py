#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_veiculos.py
----------------------
Motor de transformação e exportação da planilha de Importação de Veículos da
SSX (ver manual "SSX - Importação de Veículos"). Entra em ação depois que a
planilha já foi lida e mapeada (ver app.py, bloco "CONVERSOR DE PLANILHA DE
VEÍCULOS") — este módulo não sabe ler Excel/CSV nem nada de Flask, só
trabalha com `registros` já no formato {"indice": int, "original": {...},
"dados": {...}}, onde "dados" usa as mesmas chaves internas de
validador_importacao.tipo_veiculo.CAMPOS_VEICULO.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui. Mesmo molde de conversor_clientes.py
(ver esse arquivo pro padrão original sendo replicado aqui).
"""
import re
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_veiculo import TIPO_VEICULO

CAMPOS_VEICULO = TIPO_VEICULO.campos

# Categorias do motor que impedem um registro de entrar em "exportar só
# válidos" — as 3 exceções documentadas no manual da SSX ("Regras e
# exceções") mais inconsistência de regra cruzada e duplicidade dentro da
# própria planilha.
CATEGORIAS_ERRO = {
    _motor.CAMPO_NAO_INFORMADO,
    _motor.TAMANHO_INCORRETO,
    _motor.FORMATO_INCORRETO,
    _motor.INCONSISTENCIA,
    _motor.DUPLICIDADE,
}
# Não bloqueia a exportação: hoje só "atenção" (ex.: IMEI com quantidade de
# dígitos estranha — ver _regra_imei_tamanho em tipo_veiculo.py).
CATEGORIAS_AVISO = {_motor.ATENCAO}


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


def _remover_acentos(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _apenas_digitos(valor) -> str:
    return "".join(c for c in _texto(valor) if c.isdigit())


def _apenas_alfanumerico_maiusculo(valor) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", _texto(valor)).upper()


_CAMPOS_ALFANUMERICOS_LIMPAVEIS = {"placa"}


def limpar_campo_alfanumerico(alvo, alterados, campo: str) -> dict:
    """Remove espaço/hífen/pontuação e deixa maiúsculo — usado na "Placa",
    que costuma vir formatada de forma diferente conforme a planilha de
    origem (com espaço, hífen, minúsculo: "abc-1234", "ABC 1234"). Não valida
    o resultado (nº de caracteres etc.) — só limpa formatação, quem confere
    é o motor oficial (CAMPOS_VEICULO) depois."""
    if campo not in _CAMPOS_ALFANUMERICOS_LIMPAVEIS:
        raise ValueError(f"Campo não suportado para limpeza: {campo!r}")
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get(campo, ""))
        if not bruto:
            continue
        novo = _apenas_alfanumerico_maiusculo(bruto)
        if novo != bruto:
            dados[campo] = novo
            ajustados += 1
            alterados.add(r["indice"])
    return {"ajustados": ajustados}


# Os 4 "slots" de SIM card do layout oficial (2 rastreadores, 2 chips cada —
# ver CAMPOS_VEICULO) — cada um com DDI/DDD/Telefone em campos JÁ separados
# (diferente do Conversor de Clientes, que tem só "Telefone"/"Celular" com o
# DDD embutido no mesmo campo).
_SLOTS_CHIP = (
    ("rastreador1_ddi1", "rastreador1_ddd1", "rastreador1_telefone1"),
    ("rastreador1_ddi2", "rastreador1_ddd2", "rastreador1_telefone2"),
    ("rastreador2_ddi1", "rastreador2_ddd1", "rastreador2_telefone1"),
    ("rastreador2_ddi2", "rastreador2_ddd2", "rastreador2_telefone2"),
)


def _dividir_numero_chip(telefone_bruto: str, ddi_atual: str, ddd_atual: str, ddd_padrao: str):
    """Separa um número de telefone de chip em (ddi, ddd, telefone), a partir
    do que já estiver preenchido em "ddi_atual"/"ddd_atual" — usado quando a
    planilha de origem traz o número todo junto em "Telefone" (DDD e número
    juntos, às vezes com o 55 do Brasil na frente) em vez de já vir separado
    nos 3 campos do layout oficial da SSX. Mesma lógica de classificação por
    quantidade de dígitos do Conversor de Clientes
    (ver conversor_clientes._classificar_telefone), adaptada pra escrever em
    3 campos em vez de alternar entre 2. Só mexe no que estiver vazio — nunca
    sobrescreve um DDI/DDD que a pessoa já preencheu."""
    digitos = _apenas_digitos(telefone_bruto)
    ddi_novo, ddd_novo = ddi_atual, ddd_atual

    if not ddi_atual and len(digitos) in (12, 13) and digitos.startswith("55"):
        digitos = digitos[2:]
        ddi_novo = "55"

    if not ddd_atual:
        if len(digitos) in (10, 11):
            ddd_novo = digitos[:2]
            digitos = digitos[2:]
        elif len(digitos) in (8, 9):
            ddd_novo = ddd_padrao

    return ddi_novo, ddd_novo, digitos


def ajustar_chips(alvo, alterados, ddd_padrao="55") -> dict:
    """Roda `_dividir_numero_chip` nos 4 slots de SIM card (_SLOTS_CHIP) de
    cada linha de `alvo` — limpa a formatação do número, separa DDI/DDD/
    Telefone pra cada campo (nunca mistura as 3 informações num campo só) e,
    quando o DDI continuar vazio depois disso mas o slot tiver alguma
    informação de chip (DDD e/ou telefone já preenchidos), completa com "55"
    (Brasil) automaticamente. Nunca sobrescreve um DDI/DDD/Telefone que a
    pessoa já preencheu com outro valor — só completa o que está vazio."""
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        mudou = False
        for ddi_chave, ddd_chave, tel_chave in _SLOTS_CHIP:
            ddi_atual = _texto(dados.get(ddi_chave, ""))
            ddd_atual = _texto(dados.get(ddd_chave, ""))
            tel_bruto = _texto(dados.get(tel_chave, ""))

            ddi_novo, ddd_novo, tel_novo = ddi_atual, ddd_atual, tel_bruto
            if tel_bruto:
                ddi_novo, ddd_novo, tel_novo = _dividir_numero_chip(tel_bruto, ddi_atual, ddd_atual, ddd_padrao)

            # DDI em branco com DDD e/ou telefone preenchidos — Brasil é o
            # único DDI usado pela SSX até hoje, então completa sozinho.
            if not ddi_novo and (ddd_novo or tel_novo):
                ddi_novo = "55"

            if ddi_novo != ddi_atual:
                dados[ddi_chave] = ddi_novo
                mudou = True
            if ddd_novo != ddd_atual:
                dados[ddd_chave] = ddd_novo
                mudou = True
            if tel_novo != tel_bruto:
                dados[tel_chave] = tel_novo
                mudou = True
        if mudou:
            ajustados += 1
            alterados.add(r["indice"])
    return {"linhas_ajustadas": ajustados}


# Campos de Rastreador 1 prefixados pelo padrão GT06: "Identificação" é o
# principal, mas "Código de integração" costuma guardar o mesmo valor —
# sem isso os dois saem de sincronia depois de aplicar/limpar o padrão, já
# que cada linha passa a ter um "0" só na frente de um dos dois. Rastreador
# 2 não entra aqui de propósito — o padrão GT06 é só pro Rastreador 1.
_CAMPOS_PADRAO_GT06 = ("rastreador1_identificacao", "rastreador1_codigo_integracao")


def aplicar_padrao_gt06(alvo, alterados, templates) -> dict:
    """Acrescenta "0" no início de "Rastreador 1 - Identificação" E
    "Rastreador 1 - Código de integração" (ver `_CAMPOS_PADRAO_GT06`) em
    toda linha de `alvo` cujo "Rastreador 1 - Template" seja um dos
    `templates` selecionados (nomes exatos, vindos da lista de templates
    distintos montada no front — ver botão "Padrão GT06") — não mexe em
    template nem em mais nenhum outro campo da linha. Idempotente: campo
    que já começa com "0" (de uma execução anterior, ou já veio assim na
    planilha) não recebe outro zero. Campo vazio não tem o que prefixar,
    fica como está — os dois campos são independentes entre si (uma linha
    pode ter só um dos dois preenchido). Oposto de `limpar_padrao_gt06` —
    as duas são independentes, pra dar pra corrigir um valor que recebeu o
    padrão por engano."""
    templates_selecionados = {_texto(t) for t in templates}
    ajustados = {campo: 0 for campo in _CAMPOS_PADRAO_GT06}
    for r in alvo:
        dados = r["dados"]
        template = _texto(dados.get("rastreador1_template", ""))
        if template not in templates_selecionados:
            continue
        mudou = False
        for campo in _CAMPOS_PADRAO_GT06:
            valor = _texto(dados.get(campo, ""))
            if not valor or valor.startswith("0"):
                continue
            dados[campo] = "0" + valor
            ajustados[campo] += 1
            mudou = True
        if mudou:
            alterados.add(r["indice"])
    return {
        "ajustados": ajustados["rastreador1_identificacao"],
        "ajustados_codigo_integracao": ajustados["rastreador1_codigo_integracao"],
    }


def limpar_padrao_gt06(alvo, alterados, templates) -> dict:
    """Remove só o PRIMEIRO "0" do início de "Rastreador 1 - Identificação"
    E "Rastreador 1 - Código de integração" (ver `_CAMPOS_PADRAO_GT06`) em
    toda linha de `alvo` cujo "Rastreador 1 - Template" esteja em
    `templates` — `templates` vazio/None significa TODOS os templates (o
    botão "Limpar padrão GT06" sem nenhum marcado pede confirmação no front
    e manda a lista vazia de propósito, pra limpar o arquivo inteiro).
    Campo que não começa com "0" não é alterado. Nunca remove mais de um
    zero por execução — "0012345678" vira "012345678", não "12345678".
    Oposto de `aplicar_padrao_gt06`."""
    templates_selecionados = {_texto(t) for t in templates} if templates else None
    ajustados = {campo: 0 for campo in _CAMPOS_PADRAO_GT06}
    for r in alvo:
        dados = r["dados"]
        if templates_selecionados is not None:
            template = _texto(dados.get("rastreador1_template", ""))
            if template not in templates_selecionados:
                continue
        mudou = False
        for campo in _CAMPOS_PADRAO_GT06:
            valor = _texto(dados.get(campo, ""))
            if not valor.startswith("0"):
                continue
            dados[campo] = valor[1:]
            ajustados[campo] += 1
            mudou = True
        if mudou:
            alterados.add(r["indice"])
    return {
        "ajustados": ajustados["rastreador1_identificacao"],
        "ajustados_codigo_integracao": ajustados["rastreador1_codigo_integracao"],
    }


def repetir_campo(alvo, alterados, origem: str, destino: str) -> dict:
    """Copia o valor de `origem` para `destino` em cada linha de `alvo` —
    usado tanto pra repetir a "Placa" na "Identificação" (comum quando a
    frota usa a própria placa como nome de exibição do veículo) quanto pra
    repetir a "Identificação" do rastreador 1 no "Código de integração" dele
    (comum quando o código de integração é o mesmo identificador físico do
    equipamento). Sempre sobrescreve o que já estiver em `destino` — mesmo
    comportamento de conversor_clientes.repetir_campo."""
    repetidos = 0
    for r in alvo:
        dados = r["dados"]
        valor_origem = _texto(dados.get(origem, ""))
        if not valor_origem:
            continue
        if dados.get(destino) != valor_origem:
            dados[destino] = valor_origem
            repetidos += 1
            alterados.add(r["indice"])
    return {"repetidos": repetidos}


def preencher_campo_todas_linhas(alvo, alterados, campo: str, valor: str) -> dict:
    """Preenche `campo` com `valor` em TODAS as linhas de `alvo`, mesmo as
    que já tinham algo diferente — útil pros campos que normalmente valem o
    mesmo pra toda a planilha importada de uma vez (ícone/cor do mapa,
    combustível, template dos rastreadores, código do cliente, unidade
    organizacional — a frota inteira costuma pertencer ao mesmo cliente e
    usar o mesmo ícone/template). Mesmo comportamento de
    conversor_clientes.preencher_campo_todas_linhas."""
    valor = _texto(valor)
    preenchidos = 0
    for r in alvo:
        dados = r["dados"]
        if dados.get(campo) != valor:
            dados[campo] = valor
            preenchidos += 1
            alterados.add(r["indice"])
    return {"preenchidos": preenchidos}


# Os 4 campos "Exibir status ..." do layout oficial (CAMPOS_VEICULO) — os
# únicos liberados pro preenchimento em massa marcado por checkbox.
CAMPOS_STATUS_MAPA = (
    "exibir_status_ignicao", "exibir_status_operacional",
    "exibir_status_gps", "exibir_status_violacao",
)


def preencher_status_mapa(alvo, alterados, campos_marcados) -> dict:
    """Preenche os 4 campos de status do mapa (CAMPOS_STATUS_MAPA) em TODAS
    as linhas de `alvo` de uma vez só: os marcados em `campos_marcados`
    recebem "1", os demais (não marcados) recebem "0" — nenhum dos 4 fica
    "intocado", o resultado do clique é sempre previsível e não depende do
    que já estava preenchido antes."""
    preenchidos_por_campo = {}
    for campo in CAMPOS_STATUS_MAPA:
        valor = "1" if campo in campos_marcados else "0"
        extra = preencher_campo_todas_linhas(alvo, alterados, campo, valor)
        preenchidos_por_campo[campo] = extra["preenchidos"]
    return {"preenchidos_por_campo": preenchidos_por_campo}


def verificar_duplicidade_ssx(alvo, veiculos_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `veiculos_ssx` — lista de dicts
    vinda direto de `POST /Administration/Vehicle/List` da própria SSX (ver
    `LISTAGENS["veiculos"]` em app.py) — por código de integração do veículo
    e por placa.

    Só gera AVISO, nunca erro: a planilha pode ter duplicata de propósito
    (reimportação pra atualizar um veículo que já existe) e quem decide é a
    usuária, não o sistema — por isso não entra em CATEGORIAS_ERRO e não
    bloqueia "exportar/importar só os válidos". Mesmo padrão de
    conversor_clientes.verificar_duplicidade_ssx."""
    por_codigo, por_placa = {}, {}
    for v in veiculos_ssx or []:
        nome = (
            _texto(v.get("Identification")) or _texto(v.get("LicensePlate"))
            or _texto(v.get("VehicleIntegrationCode")) or "(sem identificação)"
        )
        codigo = _texto(v.get("VehicleIntegrationCode"))
        placa = _apenas_alfanumerico_maiusculo(v.get("LicensePlate"))
        if codigo:
            por_codigo.setdefault(codigo, nome)
        if placa:
            por_placa.setdefault(placa, nome)

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        codigo = _texto(dados.get("codigo_integracao_veiculo", ""))
        if codigo and codigo in por_codigo:
            avisos.append({
                "campo": "Código de integração do veículo da central", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe veículo na SSX com "Código de integração do veículo da central" = "{codigo}" ({por_codigo[codigo]}).',
            })

        placa_bruta = _texto(dados.get("placa", ""))
        placa = _apenas_alfanumerico_maiusculo(placa_bruta)
        if placa and placa in por_placa:
            avisos.append({
                "campo": "Placa", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe veículo na SSX com a placa "{placa_bruta}" ({por_placa[placa]}).',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


# Valor especial do manual da SSX: veículo pertence à própria central, não a
# um cliente de verdade — nunca existe como "Código de integração" na lista
# de clientes, então não faz sentido conferir esse valor contra ela.
_CODIGO_CLIENTE_CENTRAL = "#$CENTRALSSX#$"

# Os 4 campos de APN do layout oficial (2 rastreadores x 2 SIM cards cada).
_CAMPOS_APN = ("rastreador1_apn1", "rastreador1_apn2", "rastreador2_apn1", "rastreador2_apn2")
_ROTULOS_APN = {
    "rastreador1_apn1": "Rastreador 1 - APN (SIM 1)", "rastreador1_apn2": "Rastreador 1 - APN (SIM 2)",
    "rastreador2_apn1": "Rastreador 2 - APN (SIM 1)", "rastreador2_apn2": "Rastreador 2 - APN (SIM 2)",
}
_CAMPOS_TEMPLATE = ("rastreador1_template", "rastreador2_template")
_ROTULOS_TEMPLATE = {"rastreador1_template": "Rastreador 1 - Template", "rastreador2_template": "Rastreador 2 - Template"}


def verificar_referencias_ssx(alvo, clientes_ssx, templates_ssx, simcards_ssx, pessoas_ssx) -> dict:
    """O oposto de `verificar_duplicidade_ssx`: ali o esperado é que o
    código AINDA NÃO exista na SSX (senão é duplicata); aqui o esperado é
    que o código JÁ exista — "Código de integração do cliente", "Template"
    dos rastreadores, "APN" dos chips e "Cód. de int. do responsável" são
    todos referências a cadastros que precisam existir na SSX ANTES da
    importação, senão a SSX rejeita a linha. `clientes_ssx`/`templates_ssx`/
    `simcards_ssx`/`pessoas_ssx` vêm direto de
    `POST /Administration/Client/List` / `Tracker/ListTemplate` /
    `SimCard/List` / `Person/ListPerson` (ver `LISTAGENS` em app.py).

    Não existe um catálogo próprio de "APN" na API da SSX — o domínio da
    APN é um campo (`APNDomain`) de cada chip já cadastrado, então a
    checagem aqui é "esse domínio está em uso por algum SIM card
    cadastrado", não "está registrado num cadastro de APN".

    Só gera AVISO, nunca erro: a central pode cadastrar o que falta depois
    de importar, a ordem não é obrigatoriamente "cadastra tudo, importa
    depois" — quem decide se é um problema de verdade é a usuária."""
    clientes_validos = {_texto(c.get("ClientIntegrationCode")) for c in (clientes_ssx or [])}
    # Template não é case sensitive na SSX ("jt16" cadastrado conta como o
    # mesmo "JT16" da planilha) — compara em caixa normalizada
    # (.casefold(), mais correto que .upper() pra acento/Unicode em geral),
    # mas sempre mostra o valor ORIGINAL da planilha na mensagem.
    templates_validos = {_texto(t.get("TrackerTemplateIntegrationCode")).casefold() for t in (templates_ssx or [])}
    apns_validos = {_texto(s.get("APNDomain")) for s in (simcards_ssx or [])}
    pessoas_validas = {_texto(p.get("PersonIntegrationCodeClient")) for p in (pessoas_ssx or [])}
    for conjunto in (clientes_validos, templates_validos, apns_validos, pessoas_validas):
        conjunto.discard("")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        codigo_cliente = _texto(dados.get("codigo_integracao_cliente", ""))
        if codigo_cliente and codigo_cliente != _CODIGO_CLIENTE_CENTRAL and codigo_cliente not in clientes_validos:
            avisos.append({
                "campo": "Código de integração do cliente", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'Código de integração do cliente "{codigo_cliente}" não foi encontrado entre os clientes cadastrados na SSX.',
            })

        for chave in _CAMPOS_TEMPLATE:
            valor = _texto(dados.get(chave, ""))
            if valor and valor.casefold() not in templates_validos:
                rotulo = _ROTULOS_TEMPLATE[chave]
                avisos.append({
                    "campo": rotulo, "categoria": "nao_cadastrado_ssx",
                    "mensagem": f'"{rotulo}" = "{valor}" não foi encontrado entre os templates de rastreador cadastrados na SSX.',
                })

        for chave in _CAMPOS_APN:
            valor = _texto(dados.get(chave, ""))
            if valor and valor not in apns_validos:
                rotulo = _ROTULOS_APN[chave]
                avisos.append({
                    "campo": rotulo, "categoria": "nao_cadastrado_ssx",
                    "mensagem": f'"{rotulo}" = "{valor}" não foi encontrado em nenhum SIM card cadastrado na SSX.',
                })

        codigo_responsavel_bruto = _texto(dados.get("codigo_responsavel", ""))
        if codigo_responsavel_bruto:
            faltando = [
                c.strip() for c in codigo_responsavel_bruto.split(",")
                if c.strip() and c.strip() not in pessoas_validas
            ]
            if faltando:
                avisos.append({
                    "campo": "Cód. de int. do responsável", "categoria": "nao_cadastrado_ssx",
                    "mensagem": f'"Cód. de int. do responsável" = "{codigo_responsavel_bruto}" tem código(s) não encontrado(s) entre as pessoas cadastradas na SSX: {", ".join(faltando)}.',
                })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def listar_templates_e_apns(registros, templates_ssx, simcards_ssx) -> dict:
    """Pro botão "Templates": duas listas (Template de rastreador e APN —
    os 2 cadastros que precisam existir na SSX ANTES da importação dar
    certo, diferente de Cliente/Responsável, que normalmente já existem)
    com TODOS os valores distintos usados na planilha inteira (rastreador 1
    E 2 juntos pra Template; os 4 campos de SIM card juntos pra APN),
    marcando quais já estão cadastrados na SSX e quais ainda faltam — pra
    virar um checklist do que precisa ser cadastrado antes de importar,
    sem precisar rodar a verificação pesada de duplicidade/referência da
    planilha inteira só pra ver isso.

    `templates_ssx`/`simcards_ssx`: mesmas listas de
    `verificar_referencias_ssx` (`POST /Administration/Tracker/ListTemplate`
    / `SimCard/List`, ver `LISTAGENS` em app.py)."""
    templates_planilha, apns_planilha = set(), set()
    for r in registros:
        dados = r["dados"]
        for chave in _CAMPOS_TEMPLATE:
            valor = _texto(dados.get(chave, ""))
            if valor:
                templates_planilha.add(valor)
        for chave in _CAMPOS_APN:
            valor = _texto(dados.get(chave, ""))
            if valor:
                apns_planilha.add(valor)

    # Template não é case sensitive na SSX — compara em caixa normalizada
    # (ver mesmo ajuste em verificar_referencias_ssx), mas a lista mostrada
    # sempre usa o valor ORIGINAL da planilha.
    templates_validos = {_texto(t.get("TrackerTemplateIntegrationCode")).casefold() for t in (templates_ssx or [])}
    templates_validos.discard("")
    apns_validos = {_texto(s.get("APNDomain")) for s in (simcards_ssx or [])}
    apns_validos.discard("")

    def _montar_lista(valores, validos, case_insensitive=False):
        # Falta cadastrar (cadastrado=False) primeiro — é o que interessa
        # ver de cara; dentro de cada grupo, ordem alfabética.
        def _cadastrado(v):
            return (v.casefold() if case_insensitive else v) in validos
        return sorted(
            ({"valor": v, "cadastrado": _cadastrado(v)} for v in valores),
            key=lambda item: (item["cadastrado"], item["valor"].casefold()),
        )

    return {
        "templates": _montar_lista(templates_planilha, templates_validos, case_insensitive=True),
        "apns": _montar_lista(apns_planilha, apns_validos),
    }


# "Código de integração do veículo" e "Placa" já são checados como ERRO pelo
# motor oficial (TIPO_VEICULO.chaves_unicas) — não repete aqui pra não
# mostrar o mesmo problema duas vezes com cores diferentes. Os campos abaixo
# não têm essa garantia oficial, mas repetir entre linhas da MESMA planilha
# quase sempre indica erro de preenchimento (chassi/IMEI são identificadores
# físicos únicos).
_CAMPOS_DUPLICIDADE_INTERNA = (
    ("identificacao", "Identificação"),
    ("chassi", "Chassi"),
    ("rastreador1_imei", "Rastreador 1 - IMEI"),
    ("rastreador2_imei", "Rastreador 2 - IMEI"),
)


def verificar_duplicidade_interna(registros) -> dict:
    """Confere se "Identificação", "Chassi" ou os IMEIs dos rastreadores se
    repetem entre LINHAS da PRÓPRIA planilha sendo trabalhada agora —
    diferente de `verificar_duplicidade_ssx`, que compara contra a base da
    SSX. Só gera AVISO (categoria "duplicado_planilha"), nunca bloqueia: pode
    ser coincidência (identificação genérica tipo "Caminhão 1" repetida de
    propósito) ou intencional. IMEI é comparado só pelos dígitos (ignora
    formatação). Mesmo padrão de conversor_clientes.verificar_duplicidade_interna."""
    vistos = {chave: {} for chave, _ in _CAMPOS_DUPLICIDADE_INTERNA}
    por_indice = {}
    for r in registros:
        dados = r["dados"]
        avisos = []
        for chave, rotulo in _CAMPOS_DUPLICIDADE_INTERNA:
            bruto = dados.get(chave, "")
            valor = _apenas_digitos(bruto) if chave.endswith("imei") else _texto(bruto)
            if not valor:
                continue
            if valor in vistos[chave]:
                avisos.append({
                    "campo": rotulo, "categoria": "duplicado_planilha",
                    "mensagem": f'"{rotulo}" = "{_texto(bruto)}" também aparece na linha {vistos[chave][valor]} desta planilha.',
                })
            else:
                vistos[chave][valor] = r["indice"]
        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def validar_registros(registros):
    """`registros`: lista de dicts {"dados": {chave: valor}, ...}, na ordem
    em que devem aparecer no arquivo final. Roda o motor oficial
    (validador_importacao) e devolve {indice_no_registros: {"erros": [...],
    "avisos": [...]}} — só entram no dict os registros com algum problema."""
    linhas = [r["dados"] for r in registros]
    erros_motor = _motor.validar_planilha(TIPO_VEICULO, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', uma linha por veículo, na ordem oficial
    de TIPO_VEICULO.campos (mesmo molde do manual, seção "Formato") — campo
    não preenchido mantém a posição vazia. Mesma convenção de
    conversor_clientes.gerar_arquivo_oficial(): ASCII sem acento, ';' como
    separador (nunca dentro de um valor), '\\r\\n' entre linhas, ';' final em
    cada linha."""
    linhas_texto = []
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_VEICULO:
            valor = _remover_acentos(_texto(dados.get(campo.chave, "")))
            valor = valor.replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    if not linhas_texto:
        return ""
    return "\r\n".join(linhas_texto) + "\r\n"
