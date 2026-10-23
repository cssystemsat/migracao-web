#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_areas.py
-------------------
Motor de transformação e exportação da planilha de Importação de Áreas da
SSX, caminho "via planilha" — dados digitados ou exportados de outro
sistema, SEM passar por um arquivo de mapa (.kml/.kmz). Entra em ação
depois que a planilha já foi lida e mapeada (ver app.py, bloco "CONVERSOR
DE PLANILHA DE ÁREAS") — este módulo não sabe ler Excel/CSV nem nada de
Flask, só trabalha com `registros` já no formato {"indice": int,
"original": {...}, "dados": {...}}, onde "dados" usa as mesmas chaves
internas de validador_importacao.tipo_area.CAMPOS_AREA.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui. Mesmo molde de
conversor_rastreadores.py/conversor_simcards.py.

O caminho "via arquivo de mapa" continua em conversorkml.py, que roda
inteiro no navegador (não usa este módulo) — os dois caminhos exportam o
mesmo layout de arquivo (ver gerar_arquivo_oficial), mas não compartilham
código: domínio pequeno o bastante pra manter os dois self-contained, cada
um no seu próprio arquivo, mesma convenção dos outros conversores deste
projeto (nenhum deles importa transformação de outro).
"""
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_area import TIPO_AREA, parse_coordenadas

CAMPOS_AREA = TIPO_AREA.campos

CATEGORIAS_ERRO = {
    _motor.CAMPO_NAO_INFORMADO,
    _motor.TAMANHO_INCORRETO,
    _motor.FORMATO_INCORRETO,
    _motor.INCONSISTENCIA,
    _motor.DUPLICIDADE,
}
CATEGORIAS_AVISO = {_motor.ATENCAO}

# Tipo (texto) -> código esperado pelo layout oficial de arquivo (mesmo
# enum de conversorkml._TIPO_CSV: Área=1, Rota=2, Ponto=3).
_TIPO_PARA_CODIGO = {"Área": "1", "Rota": "2", "Ponto": "3"}
_CABECALHO_OFICIAL = ("Nome;Descricao;Tipo;Coordenadas;Tolerancia;"
                      "Cod.integracao;Cod.categoria;Cod.grupo;Cod.cor;")


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


def _remover_acentos(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def preencher_campo_todas_linhas(alvo, alterados, campo: str, valor: str) -> dict:
    """Preenche `campo` com `valor` em TODAS as linhas de `alvo` — útil pra
    Categoria/Grupo/Cor, que normalmente valem o mesmo pra toda uma leva de
    áreas importada de uma vez. Mesmo comportamento de
    conversor_rastreadores.preencher_campo_todas_linhas."""
    valor = _texto(valor)
    preenchidos = 0
    for r in alvo:
        dados = r["dados"]
        if dados.get(campo) != valor:
            dados[campo] = valor
            preenchidos += 1
            alterados.add(r["indice"])
    return {"preenchidos": preenchidos}


def fechar_anel(alvo, alterados) -> dict:
    """Fecha o polígono (1º ponto repetido no final) de toda linha de
    `alvo` cujo "Tipo" seja "Área" e cujas coordenadas ainda não estejam
    fechadas — conveniência equivalente ao toggle "Forçar áreas" do
    Conversor KML, mas aqui sob demanda (botão), já que neste caminho quem
    decide o Tipo é a própria pessoa, não uma inferência de geometria."""
    fechados = 0
    for r in alvo:
        dados = r["dados"]
        if _texto(dados.get("tipo")) != "Área":
            continue
        bruto = _texto(dados.get("coordenadas"))
        if not bruto:
            continue
        try:
            pontos = parse_coordenadas(bruto)
        except ValueError:
            continue  # formato inválido: quem reporta é o motor oficial
        if len(pontos) < 2 or pontos[0] == pontos[-1]:
            continue
        pontos.append(pontos[0])
        dados["coordenadas"] = ",".join(f"{lon} {lat}" for lon, lat in pontos)
        fechados += 1
        alterados.add(r["indice"])
    return {"fechados": fechados}


def padronizar_coordenadas(alvo, alterados) -> dict:
    """Reescreve "coordenadas" no formato exato do manual: "longitude
    latitude" (um espaço) por ponto, pontos separados por uma vírgula, sem
    espaços nem casas decimais extras — útil quando a planilha de origem
    veio com espaçamento inconsistente (múltiplos espaços, espaço depois
    da vírgula, etc.). Linha cujo formato já está inválido (ex.: faltando
    um dos dois números) não é alterada — quem aponta isso é o motor
    oficial na validação; esta transformação só padroniza o que já dá pra
    interpretar."""
    padronizados = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get("coordenadas"))
        if not bruto:
            continue
        try:
            pontos = parse_coordenadas(bruto)
        except ValueError:
            continue
        novo = ",".join(f"{lon} {lat}" for lon, lat in pontos)
        if novo != bruto:
            dados["coordenadas"] = novo
            padronizados += 1
            alterados.add(r["indice"])
    return {"padronizados": padronizados}


def inverter_lat_long(alvo, alterados) -> dict:
    """Troca a ordem de cada ponto de "coordenadas" (latitude/longitude
    por longitude/latitude, ou vice-versa) — útil quando a planilha de
    origem vem com a ordem invertida da esperada pelo manual (primeiro a
    longitude, depois a latitude). Reaproveita parse_coordenadas só pra
    separar os pontos (ele já exige 2 números por ponto); não valida qual
    dos dois é lat/long nem o intervalo depois de trocado — quem confere
    isso é o motor oficial na validação seguinte. Linha com formato
    inválido não é alterada."""
    invertidos = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get("coordenadas"))
        if not bruto:
            continue
        try:
            pontos = parse_coordenadas(bruto)
        except ValueError:
            continue
        novo = ",".join(f"{b} {a}" for a, b in pontos)
        if novo != bruto:
            dados["coordenadas"] = novo
            invertidos += 1
            alterados.add(r["indice"])
    return {"invertidos": invertidos}


def verificar_referencias_ssx(alvo, categorias_ssx, grupos_ssx) -> dict:
    """"Categoria" e "Grupo" são referências a cadastros que precisam
    existir na SSX ANTES da importação (a própria API de
    Geography/Insert rejeita com 409 se o código não existir) —
    `categorias_ssx`/`grupos_ssx` vêm direto de
    `POST /Administration/Geography/ListCategories` /
    `Geography/ListGroups` (ver LISTAGENS em app.py). "Categoria" pode ser
    uma lista separada por vírgula (ListCategoryIntegrationCode aceita
    "45,10,25,80") — cada código da lista é conferido individualmente.

    Só gera AVISO, nunca erro: a central pode cadastrar o que falta depois
    de importar. Mesmo padrão de conversor_rastreadores.verificar_referencias_ssx."""
    categorias_validas = {_texto(c.get("CategoryIntegrationCode")) for c in (categorias_ssx or [])}
    grupos_validos = {_texto(g.get("GroupIntegrationCode")) for g in (grupos_ssx or [])}
    categorias_validas.discard("")
    grupos_validos.discard("")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        categoria = _texto(dados.get("categoria", ""))
        if categoria:
            faltantes = [c.strip() for c in categoria.split(",") if c.strip() and c.strip() not in categorias_validas]
            if faltantes:
                avisos.append({
                    "campo": "Categoria", "categoria": "nao_cadastrado_ssx",
                    "mensagem": f'Código(s) de categoria não encontrado(s) na SSX: {", ".join(faltantes)}.',
                })

        grupo = _texto(dados.get("grupo", ""))
        if grupo and grupo not in grupos_validos:
            avisos.append({
                "campo": "Grupo", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'"Grupo" = "{grupo}" não foi encontrado entre os grupos de área cadastrados na SSX.',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def listar_categorias_e_grupos(registros, categorias_ssx, grupos_ssx) -> dict:
    """Pro botão "Categorias/Grupos": duas listas com todos os valores
    distintos usados na planilha inteira, marcando quais já estão
    cadastrados na SSX e quais ainda faltam. Mesmo padrão de
    conversor_rastreadores.listar_templates_e_status."""
    categorias_planilha, grupos_planilha = set(), set()
    for r in registros:
        dados = r["dados"]
        for c in _texto(dados.get("categoria", "")).split(","):
            if c.strip():
                categorias_planilha.add(c.strip())
        valor = _texto(dados.get("grupo", ""))
        if valor:
            grupos_planilha.add(valor)

    categorias_validas = {_texto(c.get("CategoryIntegrationCode")) for c in (categorias_ssx or [])}
    categorias_validas.discard("")
    grupos_validos = {_texto(g.get("GroupIntegrationCode")) for g in (grupos_ssx or [])}
    grupos_validos.discard("")

    def _montar_lista(valores, validos):
        return sorted(
            ({"valor": v, "cadastrado": v in validos} for v in valores),
            key=lambda item: (item["cadastrado"], item["valor"].casefold()),
        )

    return {
        "categorias": _montar_lista(categorias_planilha, categorias_validas),
        "grupos": _montar_lista(grupos_planilha, grupos_validos),
    }


def validar_registros(registros):
    """`registros`: lista de dicts {"dados": {chave: valor}, ...}, na ordem
    em que devem aparecer no arquivo final. Roda o motor oficial
    (validador_importacao) e devolve {indice_no_registros: {"erros": [...],
    "avisos": [...]}} — só entram no dict os registros com algum problema."""
    linhas = [r["dados"] for r in registros]
    erros_motor = _motor.validar_planilha(TIPO_AREA, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', COM cabeçalho (diferente dos outros
    conversores: o layout oficial de Áreas/página 2 do manual já nasce com
    cabeçalho — ver conversorkml._CSV_CABECALHO, mesmo texto aqui) — uma
    linha por área/rota/ponto, na ordem oficial de TIPO_AREA.campos. "Tipo"
    sai como código (1/2/3), não como o rótulo editado na tela."""
    linhas_texto = [_CABECALHO_OFICIAL]
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_AREA:
            valor = _texto(dados.get(campo.chave, ""))
            if campo.chave == "tipo":
                valor = _TIPO_PARA_CODIGO.get(valor, valor)
            valor = _remover_acentos(valor).replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    return "\r\n".join(linhas_texto) + "\r\n"
