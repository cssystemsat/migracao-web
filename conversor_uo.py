#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_uo.py
----------------
Motor de transformação e validação da planilha de Importação de Unidades
Organizacionais da SSX. Entra em ação depois que a planilha já foi lida e
mapeada (ver app.py, bloco "CONVERSOR DE PLANILHA DE UNIDADES
ORGANIZACIONAIS") — este módulo não sabe ler Excel/CSV nem nada de Flask,
só trabalha com `registros` já no formato {"indice": int, "original":
{...}, "dados": {...}}, onde "dados" usa as mesmas chaves internas de
validador_importacao.tipo_uo.CAMPOS_UO.

Usa validador_importacao/ como única fonte de verdade do layout (campos,
ordem, obrigatoriedade) e do motor de validação — não redeclara nem
duplica nada disso aqui. Mesmo molde de conversor_rastreadores.py/
conversor_simcards.py.

SEM `gerar_arquivo_oficial`: diferente dos outros 4 conversores, Unidade
Organizacional não tem layout de arquivo — a SSX só aceita o cadastro via
`POST /Administration/OrganizationalUnit/Insert` (ver tipo_uo.py). Por
isso este Conversor só oferece "Importar via API", nunca "Baixar arquivo".
"""
from validador_importacao import motor as _motor
from validador_importacao.tipo_uo import TIPO_UO

CAMPOS_UO = TIPO_UO.campos

CATEGORIAS_ERRO = {
    _motor.CAMPO_NAO_INFORMADO,
    _motor.TAMANHO_INCORRETO,
    _motor.FORMATO_INCORRETO,
    _motor.INCONSISTENCIA,
    _motor.DUPLICIDADE,
}
CATEGORIAS_AVISO = {_motor.ATENCAO}


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


def preencher_campo_todas_linhas(alvo, alterados, campo: str, valor: str) -> dict:
    """Preenche `campo` com `valor` em TODAS as linhas de `alvo`, mesmo as
    que já tinham algo diferente — útil para "Tipo da Unidade
    Organizacional", "Código de integração do cliente" e "Código de
    integração da Unidade Organizacional pai", que normalmente valem o
    mesmo para toda uma leva de UOs importada de uma vez (mesmo
    cliente/hierarquia). Mesmo comportamento de
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


def verificar_duplicidade_ssx(alvo, uos_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `uos_ssx` — lista de dicts
    vinda direto de `POST /Administration/OrganizationalUnit/List` da
    própria SSX (ver `LISTAGENS["uos"]` em app.py) — por "Código de
    integração", o único campo que identifica uma UO.

    Só gera AVISO, nunca erro: reimportar um código já existente não é
    necessariamente um problema (pode ser uma atualização intencional) —
    quem decide é a usuária. Mesmo padrão de
    conversor_rastreadores.verificar_duplicidade_ssx."""
    por_codigo = {}
    for u in uos_ssx or []:
        codigo = _texto(u.get("OrganizationalUnitIntegrationCode"))
        if codigo:
            por_codigo.setdefault(codigo, _texto(u.get("Name")) or "(sem nome)")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        codigo = _texto(dados.get("codigo_integracao", ""))
        if codigo and codigo in por_codigo:
            por_indice[r["indice"]] = {"erros": [], "avisos": [{
                "campo": "Código de integração", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe Unidade Organizacional na SSX com "Código de integração" = "{codigo}" ({por_codigo[codigo]}).',
            }]}
    return por_indice


def verificar_referencias_ssx(alvo, uos_ssx, clientes_ssx) -> dict:
    """O oposto de `verificar_duplicidade_ssx`: ali o esperado é que o
    código AINDA NÃO exista na SSX; aqui o esperado é que o código JÁ
    exista — "Código de integração da Unidade Organizacional pai" e
    "Código de integração do cliente" são referências a cadastros que
    precisam existir na SSX ANTES da importação, senão a API rejeita a
    linha. `uos_ssx`/`clientes_ssx` vêm direto de
    `POST /Administration/OrganizationalUnit/List` / `Client/List` (ver
    `LISTAGENS` em app.py).

    "Tipo da Unidade Organizacional" NÃO é checado aqui — o próprio schema
    da API (`OrganizationalUnitInsertParameter`, confirmado no Swagger)
    documenta que o sistema cria o tipo automaticamente quando ele ainda
    não existe, diferente de Template/Status de rastreador (que a SSX
    rejeita se não existirem). "Código de integração do cliente" também
    é opcional por natureza — vazio significa UO da própria central, não
    um valor que falta cadastrar.

    Só gera AVISO, nunca erro: a central pode cadastrar o que falta depois
    de importar. Mesmo padrão de conversor_rastreadores.verificar_referencias_ssx."""
    uos_validas = {_texto(u.get("OrganizationalUnitIntegrationCode")) for u in (uos_ssx or [])}
    clientes_validos = {_texto(c.get("ClientIntegrationCode")) for c in (clientes_ssx or [])}
    uos_validas.discard("")
    clientes_validos.discard("")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        pai = _texto(dados.get("unidade_pai", ""))
        if pai and pai not in uos_validas:
            avisos.append({
                "campo": "Código de integração da Unidade Organizacional pai", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'Código de integração da Unidade Organizacional pai "{pai}" não foi encontrado entre as Unidades Organizacionais cadastradas na SSX.',
            })

        codigo_cliente = _texto(dados.get("codigo_integracao_cliente", ""))
        if codigo_cliente and codigo_cliente not in clientes_validos:
            avisos.append({
                "campo": "Código de integração do cliente", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'Código de integração do cliente "{codigo_cliente}" não foi encontrado entre os clientes cadastrados na SSX.',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def validar_registros(registros):
    """`registros`: lista de dicts {"dados": {chave: valor}, ...}, na ordem
    em que devem aparecer no arquivo final. Roda o motor oficial
    (validador_importacao) e devolve {indice_no_registros: {"erros": [...],
    "avisos": [...]}} — só entram no dict os registros com algum problema."""
    linhas = [r["dados"] for r in registros]
    erros_motor = _motor.validar_planilha(TIPO_UO, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice
