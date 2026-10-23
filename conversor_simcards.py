#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_simcards.py
-----------------------
Motor de transformação e exportação da planilha de Importação de SIM Cards
da SSX (ver manual "SSX - Importação de SIM Cards"). Entra em ação depois
que a planilha já foi lida e mapeada (ver app.py, bloco "CONVERSOR DE
PLANILHA DE SIM CARDS") — este módulo não sabe ler Excel/CSV nem nada de
Flask, só trabalha com `registros` já no formato {"indice": int,
"original": {...}, "dados": {...}}, onde "dados" usa as mesmas chaves
internas de validador_importacao.tipo_simcard.CAMPOS_SIMCARD.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui. Mesmo molde de conversor_veiculos.py
(ver esse arquivo pro padrão original sendo replicado aqui). Domínio bem
mais simples que Veículo/Rastreador: SIM Card não tem nenhum campo que
referencie um cadastro que precise já existir na SSX (o "Domínio da APN" é
só um dado do próprio chip, não uma referência a um catálogo separado) —
por isso não tem função `verificar_referencias_ssx` nem botão "Templates"
(ver conversor_padrao-gotchas / decisão de domínio no pedido original).
"""
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_simcard import TIPO_SIMCARD

CAMPOS_SIMCARD = TIPO_SIMCARD.campos

# Categorias do motor que impedem um registro de entrar em "exportar só
# válidos" — as 3 exceções documentadas no manual da SSX ("Regras e
# exceções") mais duplicidade dentro da própria planilha.
CATEGORIAS_ERRO = {
    _motor.CAMPO_NAO_INFORMADO,
    _motor.TAMANHO_INCORRETO,
    _motor.FORMATO_INCORRETO,
    _motor.INCONSISTENCIA,
    _motor.DUPLICIDADE,
}
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


def limpar_campo_iccid(alvo, alterados) -> dict:
    """Remove espaço/hífen/pontuação do ICCID, deixando só os dígitos —
    costuma vir formatado de jeitos diferentes conforme a planilha de
    origem. Não valida o resultado (nº de caracteres etc.) — só limpa
    formatação, quem confere é o motor oficial (CAMPOS_SIMCARD) depois.
    Mesmo padrão de conversor_rastreadores.limpar_campo_numerico, mas sem
    allow-list de campo (só existe um candidato aqui)."""
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get("iccid", ""))
        if not bruto:
            continue
        novo = _apenas_digitos(bruto)
        if novo != bruto:
            dados["iccid"] = novo
            ajustados += 1
            alterados.add(r["indice"])
    return {"ajustados": ajustados}


def _dividir_numero_telefone(telefone_bruto: str, ddi_atual: str, ddd_atual: str, ddd_padrao: str):
    """Separa um número de telefone em (ddi, ddd, telefone), a partir do que
    já estiver preenchido em "ddi_atual"/"ddd_atual" — usado quando a
    planilha de origem traz o número todo junto em "Telefone" (DDD e número
    juntos, às vezes com o 55 do Brasil na frente) em vez de já vir
    separado nos 3 campos do layout oficial da SSX. Mesma lógica de
    conversor_veiculos._dividir_numero_chip, só que pra um slot único (aqui
    o chip inteiro É a linha, não um dos 4 slots de um veículo). Só mexe no
    que estiver vazio — nunca sobrescreve um DDI/DDD que a pessoa já
    preencheu."""
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


def ajustar_telefone(alvo, alterados, ddd_padrao="55") -> dict:
    """Roda `_dividir_numero_telefone` em cada linha de `alvo` — limpa a
    formatação do número, separa DDI/DDD/Telefone pra cada campo (nunca
    mistura as 3 informações num campo só) e, quando o DDI continuar vazio
    depois disso mas a linha tiver alguma informação de telefone (DDD e/ou
    número já preenchidos), completa com "55" (Brasil) automaticamente.
    Nunca sobrescreve um DDI/DDD/Telefone que a pessoa já preencheu com
    outro valor — só completa o que está vazio. Mesmo padrão de
    conversor_veiculos.ajustar_chips, mas pra um único chip por linha."""
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        ddi_atual = _texto(dados.get("ddi", ""))
        ddd_atual = _texto(dados.get("ddd", ""))
        tel_bruto = _texto(dados.get("telefone", ""))

        ddi_novo, ddd_novo, tel_novo = ddi_atual, ddd_atual, tel_bruto
        if tel_bruto:
            ddi_novo, ddd_novo, tel_novo = _dividir_numero_telefone(tel_bruto, ddi_atual, ddd_atual, ddd_padrao)

        # DDI em branco com DDD e/ou telefone preenchidos — Brasil é o único
        # DDI usado pela SSX até hoje, então completa sozinho.
        if not ddi_novo and (ddd_novo or tel_novo):
            ddi_novo = "55"

        mudou = False
        if ddi_novo != ddi_atual:
            dados["ddi"] = ddi_novo
            mudou = True
        if ddd_novo != ddd_atual:
            dados["ddd"] = ddd_novo
            mudou = True
        if tel_novo != tel_bruto:
            dados["telefone"] = tel_novo
            mudou = True
        if mudou:
            ajustados += 1
            alterados.add(r["indice"])
    return {"linhas_ajustadas": ajustados}


# Campos liberados pra "preencher pra todas as linhas" — Domínio da APN e
# Dia de corte normalmente valem o mesmo pra toda uma leva de chips
# importada de uma vez (mesmo plano/operadora). Mesma ideia de
# conversor_veiculos.CAMPOS_STATUS_MAPA, mas a allow-list fica em app.py
# (CONVERSOR_SIMCARDS_CAMPOS_PREENCHIVEIS), não aqui — este módulo só
# expõe o helper genérico.
def preencher_campo_todas_linhas(alvo, alterados, campo: str, valor: str) -> dict:
    """Preenche `campo` com `valor` em TODAS as linhas de `alvo`, mesmo as
    que já tinham algo diferente. Mesmo comportamento de
    conversor_veiculos.preencher_campo_todas_linhas."""
    valor = _texto(valor)
    preenchidos = 0
    for r in alvo:
        dados = r["dados"]
        if dados.get(campo) != valor:
            dados[campo] = valor
            preenchidos += 1
            alterados.add(r["indice"])
    return {"preenchidos": preenchidos}


def verificar_duplicidade_ssx(alvo, simcards_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `simcards_ssx` — lista de
    dicts vinda direto de `POST /Administration/SimCard/List` da própria
    SSX (ver `LISTAGENS["simcards"]` em app.py) — por ICCID, o único campo
    que identifica um SIM card.

    Só gera AVISO, nunca erro: o próprio manual descreve reimportar um
    ICCID já existente como comportamento esperado (atualiza em vez de
    duplicar) — quem decide se é um problema de verdade é a usuária. Mesmo
    padrão de conversor_veiculos.verificar_duplicidade_ssx."""
    por_iccid = {}
    for s in simcards_ssx or []:
        iccid = _texto(s.get("ICCID"))
        if iccid:
            por_iccid.setdefault(iccid, _texto(s.get("APNDomain")) or "(sem domínio de APN)")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        iccid = _texto(dados.get("iccid", ""))
        if iccid and iccid in por_iccid:
            por_indice[r["indice"]] = {"erros": [], "avisos": [{
                "campo": "ICCID", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe SIM card na SSX com "ICCID" = "{iccid}" (APN: {por_iccid[iccid]}).',
            }]}
    return por_indice


def verificar_duplicidade_interna(registros) -> dict:
    """Confere se o número de telefone completo (DDI+DDD+Telefone) se
    repete entre LINHAS da PRÓPRIA planilha sendo trabalhada agora —
    diferente de `verificar_duplicidade_ssx`, que compara contra a base da
    SSX. "ICCID" já é checado como ERRO pelo motor oficial
    (TIPO_SIMCARD.chaves_unicas), não repete aqui. Só gera AVISO (categoria
    "duplicado_planilha"), nunca bloqueia — dois chips com o mesmo número
    completo cadastrados de uma vez quase sempre é erro de preenchimento,
    mas não impossível (linha reserva, portabilidade em andamento etc.).
    Mesmo padrão de conversor_veiculos.verificar_duplicidade_interna."""
    vistos = {}
    por_indice = {}
    for r in registros:
        dados = r["dados"]
        ddi = _apenas_digitos(dados.get("ddi", ""))
        ddd = _apenas_digitos(dados.get("ddd", ""))
        telefone = _apenas_digitos(dados.get("telefone", ""))
        if not telefone:
            continue
        chave = f"{ddi}-{ddd}-{telefone}"
        bruto = f"{_texto(dados.get('ddi', ''))} {_texto(dados.get('ddd', ''))} {_texto(dados.get('telefone', ''))}".strip()
        if chave in vistos:
            por_indice[r["indice"]] = {"erros": [], "avisos": [{
                "campo": "Telefone", "categoria": "duplicado_planilha",
                "mensagem": f'"DDI/DDD/Telefone" = "{bruto}" também aparece na linha {vistos[chave]} desta planilha.',
            }]}
        else:
            vistos[chave] = r["indice"]
    return por_indice


def validar_registros(registros):
    """`registros`: lista de dicts {"dados": {chave: valor}, ...}, na ordem
    em que devem aparecer no arquivo final. Roda o motor oficial
    (validador_importacao) e devolve {indice_no_registros: {"erros": [...],
    "avisos": [...]}} — só entram no dict os registros com algum problema."""
    linhas = [r["dados"] for r in registros]
    erros_motor = _motor.validar_planilha(TIPO_SIMCARD, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', uma linha por SIM card, na ordem
    oficial de TIPO_SIMCARD.campos (mesmo molde do manual, seção "Formato")
    — campo não preenchido mantém a posição vazia. Mesma convenção de
    conversor_veiculos.gerar_arquivo_oficial()."""
    linhas_texto = []
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_SIMCARD:
            valor = _remover_acentos(_texto(dados.get(campo.chave, "")))
            valor = valor.replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    if not linhas_texto:
        return ""
    return "\r\n".join(linhas_texto) + "\r\n"
