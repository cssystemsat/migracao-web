#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_rastreadores.py
--------------------------
Motor de transformação e exportação da planilha de Importação de
Rastreadores da SSX (ver manual "SSX - Importação de Rastreadores").
Entra em ação depois que a planilha já foi lida e mapeada (ver app.py,
bloco "CONVERSOR DE PLANILHA DE RASTREADORES") — este módulo não sabe ler
Excel/CSV nem nada de Flask, só trabalha com `registros` já no formato
{"indice": int, "original": {...}, "dados": {...}}, onde "dados" usa as
mesmas chaves internas de validador_importacao.tipo_rastreador.CAMPOS_RASTREADOR.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui. Mesmo molde de conversor_veiculos.py
(ver esse arquivo pro padrão original sendo replicado aqui).
"""
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_rastreador import TIPO_RASTREADOR

CAMPOS_RASTREADOR = TIPO_RASTREADOR.campos

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
# Não bloqueia a exportação: hoje só "atenção" (IMEI com quantidade de
# dígitos estranha — ver _regra_imei_tamanho em tipo_rastreador.py).
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


_CAMPOS_NUMERICOS_LIMPAVEIS = {"iccid1", "iccid2", "imei"}


def limpar_campo_numerico(alvo, alterados, campo: str) -> dict:
    """Remove espaço/hífen/pontuação de `campo`, deixando só os dígitos —
    usado em ICCID1/ICCID2/IMEI, que costumam vir formatados de jeitos
    diferentes conforme a planilha de origem. Não valida o resultado (nº de
    caracteres etc.) — só limpa formatação, quem confere é o motor oficial
    (CAMPOS_RASTREADOR) depois."""
    if campo not in _CAMPOS_NUMERICOS_LIMPAVEIS:
        raise ValueError(f"Campo não suportado para limpeza: {campo!r}")
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get(campo, ""))
        if not bruto:
            continue
        novo = _apenas_digitos(bruto)
        if novo != bruto:
            dados[campo] = novo
            ajustados += 1
            alterados.add(r["indice"])
    return {"ajustados": ajustados}


# Campos prefixados pelo padrão GT06: "Identificação" é o principal, mas
# "Código de integração" costuma guardar o mesmo valor (ver botão
# "Identificação → Código de integração") — sem isso os dois saem de
# sincronia depois de aplicar/limpar o padrão, já que cada linha passa a ter
# um "0" só na frente de um dos dois.
_CAMPOS_PADRAO_GT06 = ("identificacao", "codigo_integracao")


def aplicar_padrao_gt06(alvo, alterados, templates) -> dict:
    """Acrescenta "0" no início de "Identificação" E "Código de
    integração" (ver `_CAMPOS_PADRAO_GT06`) em toda linha de `alvo` cujo
    "Template" seja um dos `templates` selecionados (nomes exatos, vindos
    da lista de templates distintos montada no front — ver botão "Padrão
    GT06") — não mexe em template nem em mais nenhum outro campo da linha.
    Idempotente: campo que já começa com "0" (de uma execução anterior, ou
    já veio assim na planilha) não recebe outro zero. Campo vazio não tem o
    que prefixar, fica como está — os dois campos são independentes entre
    si (uma linha pode ter só um dos dois preenchido). Oposto de
    `limpar_padrao_gt06` — as duas são independentes, pra dar pra corrigir
    um valor que recebeu o padrão por engano. Mesmo padrão de
    conversor_veiculos.aplicar_padrao_gt06, mais o Código de integração."""
    templates_selecionados = {_texto(t) for t in templates}
    ajustados = {campo: 0 for campo in _CAMPOS_PADRAO_GT06}
    for r in alvo:
        dados = r["dados"]
        template = _texto(dados.get("template", ""))
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
    return {"ajustados": ajustados["identificacao"], "ajustados_codigo_integracao": ajustados["codigo_integracao"]}


def limpar_padrao_gt06(alvo, alterados, templates) -> dict:
    """Remove só o PRIMEIRO "0" do início de "Identificação" E "Código de
    integração" (ver `_CAMPOS_PADRAO_GT06`) em toda linha de `alvo` cujo
    "Template" esteja em `templates` — `templates` vazio/None significa
    TODOS os templates (o botão "Limpar padrão GT06" sem nenhum marcado
    pede confirmação no front e manda a lista vazia de propósito, pra
    limpar o arquivo inteiro). Campo que não começa com "0" não é alterado.
    Nunca remove mais de um zero por execução — "0012345678" vira
    "012345678", não "12345678". Oposto de `aplicar_padrao_gt06`. Mesmo
    padrão de conversor_veiculos.limpar_padrao_gt06, mais o Código de
    integração."""
    templates_selecionados = {_texto(t) for t in templates} if templates else None
    ajustados = {campo: 0 for campo in _CAMPOS_PADRAO_GT06}
    for r in alvo:
        dados = r["dados"]
        if templates_selecionados is not None:
            template = _texto(dados.get("template", ""))
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
    return {"ajustados": ajustados["identificacao"], "ajustados_codigo_integracao": ajustados["codigo_integracao"]}


def repetir_campo(alvo, alterados, origem: str, destino: str) -> dict:
    """Copia o valor de `origem` para `destino` em cada linha de `alvo` —
    mesmo comportamento de conversor_veiculos.repetir_campo."""
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
    que já tinham algo diferente — útil pra Template/Status/Código do
    cliente, que normalmente valem o mesmo pra toda uma leva de rastreadores
    importada de uma vez. Mesmo comportamento de
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


def verificar_duplicidade_ssx(alvo, rastreadores_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `rastreadores_ssx` — lista de
    dicts vinda direto de `POST /Administration/Tracker/List` da própria SSX
    (ver `LISTAGENS["rastreadores"]` em app.py) — por "Código de integração"
    e por "Identificação" (os dois jeitos documentados de identificar um
    rastreador já existente na SSX).

    Só gera AVISO, nunca erro: a planilha pode ter duplicata de propósito
    (reimportação pra atualizar um rastreador que já existe — o próprio
    manual descreve isso como comportamento esperado) e quem decide é a
    usuária, não o sistema. Mesmo padrão de
    conversor_veiculos.verificar_duplicidade_ssx."""
    por_codigo, por_identificacao = {}, {}
    for t in rastreadores_ssx or []:
        nome = _texto(t.get("IdTracker")) or _texto(t.get("TrackerIntegrationCode")) or "(sem identificação)"
        codigo = _texto(t.get("TrackerIntegrationCode"))
        identificacao = _texto(t.get("IdTracker"))
        if codigo:
            por_codigo.setdefault(codigo, nome)
        if identificacao:
            por_identificacao.setdefault(identificacao, nome)

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        codigo = _texto(dados.get("codigo_integracao", ""))
        if codigo and codigo in por_codigo:
            avisos.append({
                "campo": "Código de integração", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe rastreador na SSX com "Código de integração" = "{codigo}" ({por_codigo[codigo]}).',
            })

        identificacao = _texto(dados.get("identificacao", ""))
        if identificacao and identificacao in por_identificacao:
            avisos.append({
                "campo": "Identificação", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe rastreador na SSX com "Identificação" = "{identificacao}" ({por_identificacao[identificacao]}).',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def verificar_referencias_ssx(alvo, templates_ssx, status_ssx, clientes_ssx, simcards_ssx) -> dict:
    """O oposto de `verificar_duplicidade_ssx`: ali o esperado é que o
    código AINDA NÃO exista na SSX; aqui o esperado é que o código JÁ
    exista — "Template", "Status do rastreador", "Código de integração do
    cliente" e os dois ICCID são todos referências a cadastros que precisam
    existir na SSX ANTES da importação, senão a SSX rejeita a linha (o
    próprio manual é explícito sobre ICCID1/ICCID2: "é necessário que o SIM
    Card já esteja cadastrado no sistema"). `templates_ssx`/`status_ssx`/
    `clientes_ssx`/`simcards_ssx` vêm direto de
    `POST /Administration/Tracker/ListTemplate` / `Tracker/ListStatusTracker`
    / `Client/List` / `SimCard/List` (ver `LISTAGENS` em app.py).

    Só gera AVISO, nunca erro: a central pode cadastrar o que falta depois
    de importar. Mesmo padrão de conversor_veiculos.verificar_referencias_ssx."""
    # Template e Status não são case sensitive na SSX — compara em caixa
    # normalizada (.casefold()), mas sempre mostra o valor ORIGINAL da
    # planilha na mensagem (mesmo ajuste de conversor_veiculos pro Template
    # de rastreador).
    templates_validos = {_texto(t.get("TrackerTemplateIntegrationCode")).casefold() for t in (templates_ssx or [])}
    status_validos = {_texto(s.get("TrackerStatusIntegrationCode")).casefold() for s in (status_ssx or [])}
    clientes_validos = {_texto(c.get("ClientIntegrationCode")) for c in (clientes_ssx or [])}
    iccids_validos = {_texto(s.get("ICCID")) for s in (simcards_ssx or [])}
    for conjunto in (templates_validos, status_validos, clientes_validos, iccids_validos):
        conjunto.discard("")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        template = _texto(dados.get("template", ""))
        if template and template.casefold() not in templates_validos:
            avisos.append({
                "campo": "Código de integração do template de rastreador", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'"Template" = "{template}" não foi encontrado entre os templates de rastreador cadastrados na SSX.',
            })

        status = _texto(dados.get("status", ""))
        if status and status.casefold() not in status_validos:
            avisos.append({
                "campo": "Código de integração do status de rastreador", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'"Status" = "{status}" não foi encontrado entre os status de rastreador cadastrados na SSX.',
            })

        codigo_cliente = _texto(dados.get("codigo_integracao_cliente", ""))
        if codigo_cliente and codigo_cliente not in clientes_validos:
            avisos.append({
                "campo": "Código de integração do cliente", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'Código de integração do cliente "{codigo_cliente}" não foi encontrado entre os clientes cadastrados na SSX.',
            })

        for chave, rotulo in (("iccid1", "ICCID1"), ("iccid2", "ICCID2")):
            valor = _texto(dados.get(chave, ""))
            if valor and valor not in iccids_validos:
                avisos.append({
                    "campo": rotulo, "categoria": "nao_cadastrado_ssx",
                    "mensagem": f'"{rotulo}" = "{valor}" não foi encontrado entre os SIM cards cadastrados na SSX.',
                })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def listar_templates_e_status(registros, templates_ssx, status_ssx) -> dict:
    """Pro botão "Templates": duas listas (Template de rastreador e Status
    de rastreador — os 2 cadastros que precisam existir na SSX ANTES da
    importação dar certo) com TODOS os valores distintos usados na planilha
    inteira, marcando quais já estão cadastrados na SSX e quais ainda
    faltam. `templates_ssx`/`status_ssx`: mesmas listas de
    `verificar_referencias_ssx` (`POST /Administration/Tracker/ListTemplate`
    / `Tracker/ListStatusTracker`, ver `LISTAGENS` em app.py). Mesmo padrão
    de conversor_veiculos.listar_templates_e_apns."""
    templates_planilha, status_planilha = set(), set()
    for r in registros:
        dados = r["dados"]
        valor = _texto(dados.get("template", ""))
        if valor:
            templates_planilha.add(valor)
        valor = _texto(dados.get("status", ""))
        if valor:
            status_planilha.add(valor)

    templates_validos = {_texto(t.get("TrackerTemplateIntegrationCode")).casefold() for t in (templates_ssx or [])}
    templates_validos.discard("")
    status_validos = {_texto(s.get("TrackerStatusIntegrationCode")).casefold() for s in (status_ssx or [])}
    status_validos.discard("")

    def _montar_lista(valores, validos):
        # Falta cadastrar (cadastrado=False) primeiro; dentro de cada grupo,
        # ordem alfabética.
        return sorted(
            ({"valor": v, "cadastrado": v.casefold() in validos} for v in valores),
            key=lambda item: (item["cadastrado"], item["valor"].casefold()),
        )

    return {
        "templates": _montar_lista(templates_planilha, templates_validos),
        "status": _montar_lista(status_planilha, status_validos),
    }


# "Código de integração" já é checado como ERRO pelo motor oficial
# (TIPO_RASTREADOR.chaves_unicas) — não repete aqui pra não mostrar o mesmo
# problema duas vezes com cores diferentes. Os campos abaixo não têm essa
# garantia oficial, mas repetir entre linhas da MESMA planilha quase sempre
# indica erro de preenchimento (identificadores físicos únicos).
_CAMPOS_DUPLICIDADE_INTERNA = (
    ("identificacao", "Identificação"),
    ("imei", "IMEI"),
    ("iccid1", "ICCID1"),
    ("iccid2", "ICCID2"),
)


def verificar_duplicidade_interna(registros) -> dict:
    """Confere se "Identificação", "IMEI", "ICCID1" ou "ICCID2" se repetem
    entre LINHAS da PRÓPRIA planilha sendo trabalhada agora — diferente de
    `verificar_duplicidade_ssx`, que compara contra a base da SSX. Só gera
    AVISO (categoria "duplicado_planilha"), nunca bloqueia. IMEI/ICCID são
    comparados só pelos dígitos (ignora formatação). Mesmo padrão de
    conversor_veiculos.verificar_duplicidade_interna."""
    vistos = {chave: {} for chave, _ in _CAMPOS_DUPLICIDADE_INTERNA}
    por_indice = {}
    for r in registros:
        dados = r["dados"]
        avisos = []
        for chave, rotulo in _CAMPOS_DUPLICIDADE_INTERNA:
            bruto = dados.get(chave, "")
            valor = _apenas_digitos(bruto) if chave in ("imei", "iccid1", "iccid2") else _texto(bruto)
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
    erros_motor = _motor.validar_planilha(TIPO_RASTREADOR, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', uma linha por rastreador, na ordem
    oficial de TIPO_RASTREADOR.campos (mesmo molde do manual, seção
    "Formato") — campo não preenchido mantém a posição vazia. Mesma
    convenção de conversor_veiculos.gerar_arquivo_oficial()."""
    linhas_texto = []
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_RASTREADOR:
            valor = _remover_acentos(_texto(dados.get(campo.chave, "")))
            valor = valor.replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    if not linhas_texto:
        return ""
    return "\r\n".join(linhas_texto) + "\r\n"
