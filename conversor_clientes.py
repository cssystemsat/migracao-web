#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_clientes.py
----------------------
Motor de transformação e exportação da planilha de Importação de Clientes da
SSX (ver manual "SSX - Importação de Clientes"). Entra em ação depois que a
planilha já foi lida e mapeada (ver app.py, bloco "CONVERSOR DE PLANILHA DE
CLIENTES") — este módulo não sabe ler Excel/CSV nem nada de Flask, só
trabalha com `registros` já no formato {"linha": int, "original": {...},
"dados": {...}}, onde "dados" usa as mesmas chaves internas de
validador_importacao.tipo_cliente.CAMPOS_CLIENTE.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui.
"""
import re
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_cliente import TIPO_CLIENTE

CAMPOS_CLIENTE = TIPO_CLIENTE.campos

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
# Não bloqueiam a exportação: "atenção" (ex.: razão social em pessoa física)
# e dígito verificador de CPF/CNPJ (a SSX aceita mesmo errado — é heurística).
CATEGORIAS_AVISO = {_motor.ATENCAO, "digito_verificador"}


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


def _remover_acentos(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def limpar_cpf_cnpj(valor) -> str:
    """Remove tudo que não é dígito. Preserva zeros à esquerda (tratado como
    texto, nunca convertido pra número) — não valida, só limpa formatação."""
    return "".join(c for c in _texto(valor) if c.isdigit())


_EMAIL_CARACTERES_INVALIDOS_RE = re.compile(r"[^a-z0-9.]+")
_EMAIL_PONTOS_REPETIDOS_RE = re.compile(r"\.{2,}")


def _normalizar_para_email(nome: str) -> str:
    sem_acento = _remover_acentos(_texto(nome)).lower()
    sem_acento = re.sub(r"\s+", ".", sem_acento)
    sem_acento = _EMAIL_CARACTERES_INVALIDOS_RE.sub("", sem_acento)
    sem_acento = _EMAIL_PONTOS_REPETIDOS_RE.sub(".", sem_acento).strip(".")
    return sem_acento or "cliente"


def gerar_email(nome, dominio, usados) -> str:
    """`usados`: coleção de e-mails (qualquer caixa) já em uso — gera um
    endereço novo baseado no nome sem colidir, acrescentando um sufixo
    numérico quando precisar. Não garante que a caixa postal exista."""
    base = _normalizar_para_email(nome)
    dominio_limpo = _texto(dominio).strip().lstrip("@")
    usados_lower = {_texto(e).lower() for e in usados}
    candidato = f"{base}@{dominio_limpo}"
    n = 2
    while candidato.lower() in usados_lower:
        candidato = f"{base}{n}@{dominio_limpo}"
        n += 1
    return candidato


def preencher_senha(valor_atual, senha_padrao, sobrescrever) -> str:
    """Se `sobrescrever` for falso, só preenche quando `valor_atual` estiver
    vazio — nunca troca uma senha já informada sem pedido explícito."""
    if not sobrescrever and not _vazio(valor_atual):
        return _texto(valor_atual)
    return _texto(senha_padrao)


def ajustar_tipo_pessoa(alvo, alterados) -> dict:
    """Identifica Pessoa Física (cliente_tipo=1) x Jurídica (cliente_tipo=2)
    pelo tamanho do CPF/CNPJ já limpo (11 dígitos = CPF, 14 = CNPJ — mesmo
    critério de `_regra_cpf_cnpj_tamanho_valido` do validador oficial, sem
    checar dígito verificador: a SSX aceita documento com dígito inválido,
    então isso não deve impedir a classificação). Pessoa jurídica também
    recebe o "nome" copiado pra "razao_social". Documento vazio/incompleto
    (nem 11 nem 14 dígitos) não é alterado — fica pra correção manual.

    `alvo`: lista de registros ({"indice", "dados": {...}}, mesmo formato
    usado pelas outras transformações). `alterados`: set (do chamador) onde
    o índice de cada registro efetivamente modificado é inserido — mesmo
    padrão das transformações acima, pra devolver só quem mudou.

    Devolve a contagem de identificados (muda ou não o valor que já estava
    lá), pro resumo mostrado na tela."""
    pessoas_fisicas = 0
    pessoas_juridicas = 0
    indefinidos = 0
    for r in alvo:
        dados = r["dados"]
        digitos = limpar_cpf_cnpj(dados.get("cpf_cnpj", ""))
        mudou = False
        if len(digitos) == 11:
            pessoas_fisicas += 1
            if dados.get("cliente_tipo") != "1":
                dados["cliente_tipo"] = "1"
                mudou = True
        elif len(digitos) == 14:
            pessoas_juridicas += 1
            if dados.get("cliente_tipo") != "2":
                dados["cliente_tipo"] = "2"
                mudou = True
            nome = _texto(dados.get("nome", ""))
            if nome and dados.get("razao_social") != nome:
                dados["razao_social"] = nome
                mudou = True
        else:
            indefinidos += 1
        if mudou:
            alterados.add(r["indice"])
    return {
        "pessoas_fisicas": pessoas_fisicas,
        "pessoas_juridicas": pessoas_juridicas,
        "indefinidos": indefinidos,
    }


def _apenas_digitos(valor) -> str:
    return "".join(c for c in _texto(valor) if c.isdigit())


_UFS_VALIDAS = {
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS",
    "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC",
    "SE", "SP", "TO",
}
_CEP_RE = re.compile(r"\bCEP[:\s]*", re.IGNORECASE)
_CEP_NUM_RE = re.compile(r"\b(\d{5})-?(\d{3})\b")
_UF_SUFIXO_RE = re.compile(r"[\s,\-/]+([A-Za-z]{2})\s*$")
_NUMERO_TOKEN_RE = re.compile(r"^(?:n[ºo°.]?\s*)?(\d+[A-Za-z]?|S/?N\.?)$", re.IGNORECASE)
_NUMERO_EMBUTIDO_RE = re.compile(
    r"^(?P<rua>.*\D)\s*(?:n[ºo°.]?\s*)?(?P<numero>\d+[A-Za-z]?|S/?N\.?)\b\s*(?P<resto>.*)$",
    re.IGNORECASE,
)
_COMPLEMENTO_PALAVRAS = (
    r"apto?s?\.?|ap\.?|bloco|bl\.?|casa|sala|sl\.?|lote|lt\.?|quadra|qd\.?|"
    r"loja|cobertura|fundos|andar|conjunto|conj\.?"
)
# Parte da lista já dedicada só ao complemento (ex.: "Apto 12" como item
# separado por vírgula/hífen) — usada contra cada `parte` isolada.
_COMPLEMENTO_RE = re.compile(r"\b(" + _COMPLEMENTO_PALAVRAS + r")\b", re.IGNORECASE)
# Mesma palavra, mas pra arrancar o trecho de dentro do pedaço rua+número
# quando não tem separador próprio (ex.: "Av. Brasil 456 Apto 12" numa frase
# só) — captura a palavra-chave + o número/identificador que vem depois.
_COMPLEMENTO_EMBUTIDO_RE = re.compile(
    r"\b(?:" + _COMPLEMENTO_PALAVRAS + r")\.?\s*\d*[A-Za-zº°]*\b", re.IGNORECASE,
)


def _dividir_partes_endereco(texto: str) -> list:
    return [p.strip(" ,-/.") for p in re.split(r",| - ", texto) if p.strip(" ,-/.")]


def separar_endereco(alvo, alterados) -> dict:
    """Separa um endereço digitado numa frase só (formato que varia de
    planilha pra planilha — às vezes já vem em colunas separadas, às vezes
    tudo junto, ex.: "Rua Exemplo, 123 - Centro - São Paulo/SP - 01310-100")
    em logradouro, número, complemento, bairro, cidade, estado e CEP. Como
    não existe no layout oficial da SSX um campo "endereço completo" (ver
    tipo_cliente.CAMPOS_CLIENTE), a usuária mapeia a coluna combinada da
    planilha de origem em "Logradouro" (o campo mais parecido) e usa este
    botão pra tentar separar o que for reconhecido.

    Best-effort: reconhece CEP (5+3 dígitos, com ou sem o rótulo "CEP"), UF
    (sigla de 2 letras de uma unidade federativa válida) e o número da casa
    (dígitos depois do nome da rua, ou "S/N"). O que não for reconhecido
    fica em branco e é apontado como endereço incompleto pela regra
    `_regra_endereco_incompleto` do validador oficial — não precisa ser
    perfeito, só não pode inventar informação. Linha onde "Logradouro" já
    parece ser só o nome da rua (sem indício de CEP/UF nem mais de uma parte
    separada por vírgula/hífen) não é alterada."""
    separados = 0
    ignorados = 0
    for r in alvo:
        dados = r["dados"]
        bruto = _texto(dados.get("logradouro", ""))
        if not bruto:
            continue

        texto = bruto
        cep = ""
        m = _CEP_NUM_RE.search(texto)
        if m:
            # Sem hífen — é assim que o campo "CEP" entra no layout oficial
            # da SSX (CAMPOS_CLIENTE), não como máscara de exibição.
            cep = f"{m.group(1)}{m.group(2)}"
            texto = texto[:m.start()] + texto[m.end():]
        # ".strip(...)" inclui "." de propósito — endereço frequentemente
        # termina em ponto final (ex.: "...CEP 60140-060."), e sem tirar esse
        # ponto a UF que ficou colada nele nunca bate no "$" da regex abaixo
        # (ficava tudo preso em "cidade" em vez de separar o Estado).
        texto = _CEP_RE.sub("", texto).strip(" ,-/.")

        estado = ""
        m = _UF_SUFIXO_RE.search(texto)
        if m and m.group(1).upper() in _UFS_VALIDAS:
            estado = m.group(1).upper()
            texto = texto[:m.start()].strip(" ,-/.")

        indicios = bool(cep) or bool(estado)
        partes = _dividir_partes_endereco(texto)
        if not indicios and len(partes) < 2:
            ignorados += 1
            continue  # já parece ser só o nome da rua — nada a separar

        rua_numero = partes[0] if partes else ""
        resto_partes = partes[1:]

        # Complemento como item próprio da lista (ex.: "..., Apto 12, ...") —
        # só procura a partir do 2º pedaço: o 1º é sempre rua(+número), nunca
        # só complemento, então tratar como item isolado erraria o que entra
        # em "logradouro" (ver teste de "Av. Brasil 456 Apto 12 - Bairro...").
        complemento = ""
        for i, parte in enumerate(resto_partes):
            if _COMPLEMENTO_RE.search(parte):
                complemento = parte
                resto_partes = resto_partes[:i] + resto_partes[i + 1:]
                break

        # Complemento embutido no mesmo pedaço da rua, sem separador próprio
        # (ex.: "Av. Brasil 456 Apto 12") — arranca antes de procurar o
        # número, senão "12" (do apto) seria confundido com o número da casa.
        if not complemento:
            m = _COMPLEMENTO_EMBUTIDO_RE.search(rua_numero)
            if m:
                complemento = m.group(0).strip()
                rua_numero = (rua_numero[:m.start()] + rua_numero[m.end():]).strip(" ,-/.")

        rua = rua_numero
        numero = ""
        if resto_partes and _NUMERO_TOKEN_RE.match(resto_partes[0]):
            numero = resto_partes[0]
            resto_partes = resto_partes[1:]
        else:
            m = _NUMERO_EMBUTIDO_RE.match(rua_numero)
            if m:
                rua = m.group("rua").strip(" ,")
                numero = m.group("numero")
                resto = m.group("resto").strip(" ,-/.")
                if resto and not resto_partes:
                    resto_partes = [resto]

        bairro = resto_partes[0] if resto_partes else ""
        cidade = ", ".join(resto_partes[1:]) if len(resto_partes) > 1 else ""

        mudou = False

        def _definir(campo, valor):
            nonlocal mudou
            valor = _texto(valor)
            if valor and dados.get(campo) != valor:
                dados[campo] = valor
                mudou = True

        _definir("logradouro", rua)
        _definir("numero_endereco", numero)
        _definir("complemento", complemento)
        _definir("bairro", bairro)
        _definir("cidade", cidade)
        _definir("estado", estado)
        _definir("cep", cep)

        if mudou:
            separados += 1
            alterados.add(r["indice"])
        else:
            ignorados += 1

    return {"enderecos_separados": separados, "enderecos_ignorados": ignorados}


def _classificar_telefone(digitos: str, ddd_padrao: str):
    """Devolve (digitos_com_ddd, tipo) a partir de um número só com dígitos.
    `tipo` é "fixo" (10 dígitos, DDD+8) ou "celular" (11 dígitos, DDD+9 — no
    Brasil todo celular tem o 9 na frente desde 2016) — ou None quando a
    quantidade de dígitos não bate com nenhum padrão conhecido (devolve só
    os dígitos limpos, sem tentar adivinhar, pra correção manual). Tira o
    código do país (55) só quando sobram exatamente 12 ou 13 dígitos no
    total (55 + DDD + número) — com 10 ou 11 dígitos não tira nada, porque
    mexer arriscaria cortar um DDD 55 (Santa Cruz do Sul/RS) legítimo."""
    if len(digitos) in (12, 13) and digitos.startswith("55"):
        digitos = digitos[2:]
    if len(digitos) == 8:
        return f"{ddd_padrao}{digitos}", "fixo"
    if len(digitos) == 9:
        return f"{ddd_padrao}{digitos}", "celular"
    if len(digitos) == 10:
        return digitos, "fixo"
    if len(digitos) == 11:
        return digitos, "celular"
    return digitos, None


def ajustar_telefones(alvo, alterados, ddd_padrao="55") -> dict:
    """Limpa a formatação dos campos "Telefone" e "Celular" (mantém só
    dígitos), completa o DDD com `ddd_padrao` quando faltar (número com 8 ou
    9 dígitos, sem DDD) e classifica cada um como fixo (10 dígitos) ou
    celular (11 dígitos) pela contagem de dígitos. Quando um número está no
    campo errado (ex.: celular digitado em "Telefone"), move pro campo
    certo — mas só quando o campo de destino está vazio; se os dois campos
    já têm conteúdo e estão trocados entre si, troca os dois de uma vez.
    Nunca sobrescreve um valor diferente que já esteja no destino."""
    ajustados = 0
    nao_reconhecidos = 0
    for r in alvo:
        dados = r["dados"]
        tel_bruto = _texto(dados.get("telefone", ""))
        cel_bruto = _texto(dados.get("celular", ""))
        tel_novo, tel_tipo = _classificar_telefone(_apenas_digitos(tel_bruto), ddd_padrao) if tel_bruto else ("", None)
        cel_novo, cel_tipo = _classificar_telefone(_apenas_digitos(cel_bruto), ddd_padrao) if cel_bruto else ("", None)

        tel_quer_mudar_campo = bool(tel_bruto) and tel_tipo == "celular"
        cel_quer_mudar_campo = bool(cel_bruto) and cel_tipo == "fixo"

        telefone_final = tel_novo if tel_bruto else dados.get("telefone", "")
        celular_final = cel_novo if cel_bruto else dados.get("celular", "")

        if tel_quer_mudar_campo and cel_quer_mudar_campo:
            telefone_final, celular_final = cel_novo, tel_novo
        elif tel_quer_mudar_campo:
            if _vazio(dados.get("celular", "")):
                celular_final, telefone_final = tel_novo, ""
        elif cel_quer_mudar_campo:
            if _vazio(dados.get("telefone", "")):
                telefone_final, celular_final = cel_novo, ""

        if tel_bruto and tel_tipo is None:
            nao_reconhecidos += 1
        if cel_bruto and cel_tipo is None:
            nao_reconhecidos += 1

        mudou = False
        if telefone_final != dados.get("telefone", ""):
            dados["telefone"] = telefone_final
            mudou = True
        if celular_final != dados.get("celular", ""):
            dados["celular"] = celular_final
            mudou = True
        if mudou:
            ajustados += 1
            alterados.add(r["indice"])

    return {"telefones_ajustados": ajustados, "telefones_nao_reconhecidos": nao_reconhecidos}


def repetir_campo(alvo, alterados, origem: str, destino: str) -> dict:
    """Copia o valor de `origem` para `destino` em cada linha de `alvo` —
    usado tanto pra repetir o nome do cliente ("nome") no nome do usuário
    ("nome_usuario", que pode repetir entre clientes diferentes sem
    problema, já que só "codigo_integracao" precisa ser único na planilha —
    ver TIPO_CLIENTE.chaves_unicas) quanto pro código de integração
    ("codigo_integracao") em "Código integração da pessoa"
    (codigo_integracao_pessoa). Diferente de preencher_senha/gerar_email,
    que só completam campo vazio: aqui `destino` sempre fica igual a
    `origem`, sobrescrevendo o que tiver lá."""
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
    que já tinham algo diferente — usado pros campos "Template do cliente" e
    "Perfil de acesso do usuário", que normalmente valem o mesmo pra toda a
    planilha importada de uma vez (diferente de preencher_senha, que só
    completa quem está vazio: aqui a usuária está dizendo "esse valor vale
    pra todo mundo")."""
    valor = _texto(valor)
    preenchidos = 0
    for r in alvo:
        dados = r["dados"]
        if dados.get(campo) != valor:
            dados[campo] = valor
            preenchidos += 1
            alterados.add(r["indice"])
    return {"preenchidos": preenchidos}


def verificar_duplicidade_ssx(alvo, clientes_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `clientes_ssx` — lista de dicts
    vinda direto de `POST /Administration/Client/List` da própria SSX (ver
    `LISTAGENS["clientes"]` em app.py; esse endpoint só traz clientes
    ATIVOS, então duplicata com cliente inativo não é pega aqui) — por
    código de integração, CPF/CNPJ e login.

    Só gera AVISO, nunca erro: a planilha pode ter duplicata de propósito
    (reimportação pra atualizar um cliente que já existe) e quem decide é a
    usuária, não o sistema — por isso não entra em CATEGORIAS_ERRO e não
    bloqueia "exportar/importar só os válidos".

    Devolve {indice: {"erros": [], "avisos": [...]}}, no mesmo formato de
    `validar_registros`, pra o chamador poder mesclar os dois resultados sem
    tratamento especial — só entram índices com pelo menos uma duplicata."""
    por_codigo, por_documento, por_login = {}, {}, {}
    for c in clientes_ssx or []:
        nome = _texto(c.get("TradingName")) or _texto(c.get("ClientIntegrationCode")) or "(sem nome)"
        codigo = _texto(c.get("ClientIntegrationCode"))
        documento = limpar_cpf_cnpj(c.get("DocumentNumber"))
        login = _texto(c.get("Login")).lower()
        if codigo:
            por_codigo.setdefault(codigo, nome)
        if documento:
            por_documento.setdefault(documento, nome)
        if login:
            por_login.setdefault(login, nome)

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        codigo = _texto(dados.get("codigo_integracao", ""))
        if codigo and codigo in por_codigo:
            avisos.append({
                "campo": "Código de integração", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe cliente ativo na SSX com "Código de integração" = "{codigo}" ({por_codigo[codigo]}).',
            })

        documento = limpar_cpf_cnpj(dados.get("cpf_cnpj", ""))
        if documento and documento in por_documento:
            avisos.append({
                "campo": "CPF / CNPJ", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe cliente ativo na SSX com esse CPF/CNPJ ({por_documento[documento]}).',
            })

        login = _texto(dados.get("login", "")).lower()
        if login and login in por_login:
            avisos.append({
                "campo": "Login", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe cliente ativo na SSX com "Login" = "{_texto(dados.get("login"))}" ({por_login[login]}).',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def listar_templates_uo_perfis(registros, templates_ssx, uos_ssx, perfis_ssx) -> dict:
    """Pro botão "Templates" (mesma ideia de
    conversor_veiculos.listar_templates_e_apns): três listas — "Template do
    cliente", "Unidade organizacional" e "Perfil de acesso do usuário", os
    cadastros que precisam existir na SSX ANTES da importação dar certo —
    com todos os valores distintos usados na planilha inteira, marcando
    quais já estão cadastrados na SSX e quais ainda faltam.

    `templates_ssx`/`uos_ssx`/`perfis_ssx`: vêm direto de
    `POST /Administration/Client/ListTemplate` /
    `OrganizationalUnit/List` / `Client/ListProfileTemplate`
    (ver `LISTAGENS` em app.py)."""
    templates_planilha, uos_planilha, perfis_planilha = set(), set(), set()
    for r in registros:
        dados = r["dados"]
        template = _texto(dados.get("template_cliente", ""))
        if template:
            templates_planilha.add(template)
        uo = _texto(dados.get("unidade_organizacional", ""))
        if uo:
            uos_planilha.add(uo)
        perfil = _texto(dados.get("perfil_acesso", ""))
        if perfil:
            perfis_planilha.add(perfil)

    # Nenhum dos 3 é case sensitive na SSX ("matriz" cadastrado conta como o
    # mesmo "MATRIZ" da planilha) — compara em caixa normalizada
    # (.casefold()), mas a lista mostrada sempre usa o valor ORIGINAL da
    # planilha (mesmo ajuste de conversor_veiculos.verificar_referencias_ssx
    # pro Template de rastreador).
    templates_validos = {_texto(t.get("ClientTemplateIntegrationCode")).casefold() for t in (templates_ssx or [])}
    templates_validos.discard("")
    uos_validas = {_texto(u.get("OrganizationalUnitIntegrationCode")).casefold() for u in (uos_ssx or [])}
    uos_validas.discard("")
    perfis_validos = {_texto(p.get("ClientProfileTemplateIntegrationCode")).casefold() for p in (perfis_ssx or [])}
    perfis_validos.discard("")

    def _montar_lista(valores, validos):
        # Falta cadastrar (cadastrado=False) primeiro — é o que interessa
        # ver de cara; dentro de cada grupo, ordem alfabética.
        return sorted(
            ({"valor": v, "cadastrado": v.casefold() in validos} for v in valores),
            key=lambda item: (item["cadastrado"], item["valor"].casefold()),
        )

    return {
        "templates": _montar_lista(templates_planilha, templates_validos),
        "uos": _montar_lista(uos_planilha, uos_validas),
        "perfis": _montar_lista(perfis_planilha, perfis_validos),
    }


_CAMPOS_DUPLICIDADE_INTERNA = (
    ("nome", "Nome"),
    ("cpf_cnpj", "CPF / CNPJ"),
    ("login", "Login"),
)


def verificar_duplicidade_interna(alvo) -> dict:
    """Confere se "Nome", "CPF/CNPJ" ou "Login" se repetem entre LINHAS da
    PRÓPRIA planilha sendo trabalhada agora — diferente de
    `verificar_duplicidade_ssx`, que compara contra a base da SSX, aqui é só
    a planilha contra ela mesma, sem precisar de login nem rede. "Código de
    integração" repetido na mesma planilha já é pego como ERRO pelo motor
    oficial (`TIPO_CLIENTE.chaves_unicas`, categoria DUPLICIDADE) — não
    repete aqui pra não mostrar o mesmo problema duas vezes com cores
    diferentes.

    Só gera AVISO (categoria "duplicado_planilha" — amarelo na tela,
    diferente do vermelho de `verificar_duplicidade_ssx`): pode ser
    coincidência (nome comum) ou intencional (mesma pessoa em mais de um
    cadastro), então não bloqueia nada, só avisa. Só a partir da 2ª
    ocorrência de cada valor é marcada — a 1ª fica limpa, mesma convenção
    que o motor oficial usa pra `chaves_unicas`.

    Devolve {indice: {"erros": [], "avisos": [...]}}, no mesmo formato das
    outras verificações — só índices com duplicata entram no dict."""
    vistos = {chave: {} for chave, _ in _CAMPOS_DUPLICIDADE_INTERNA}
    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []
        for chave, rotulo in _CAMPOS_DUPLICIDADE_INTERNA:
            bruto = dados.get(chave, "")
            if chave == "cpf_cnpj":
                valor = limpar_cpf_cnpj(bruto)
            elif chave == "login":
                valor = _texto(bruto).lower()
            else:
                valor = _texto(bruto)
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
    erros_motor = _motor.validar_planilha(TIPO_CLIENTE, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', uma linha por cliente, na ordem oficial
    de TIPO_CLIENTE.campos (mesmo molde do manual, seção "Formato") — campo
    não preenchido mantém a posição vazia. Mesma convenção de
    conversorkml.gerar_csv(): ASCII sem acento, ';' como separador (nunca
    dentro de um valor), '\\r\\n' entre linhas, ';' final em cada linha."""
    linhas_texto = []
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_CLIENTE:
            valor = _remover_acentos(_texto(dados.get(campo.chave, "")))
            valor = valor.replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    if not linhas_texto:
        return ""
    return "\r\n".join(linhas_texto) + "\r\n"
