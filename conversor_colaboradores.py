#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversor_colaboradores.py
----------------------------
Motor de transformação e exportação da planilha de Importação de
Colaboradores da SSX (ver manual "SSX - Importação de Colaboradores").
Entra em ação depois que a planilha já foi lida e mapeada (ver app.py,
bloco "CONVERSOR DE PLANILHA DE COLABORADORES") — este módulo não sabe ler
Excel/CSV nem nada de Flask, só trabalha com `registros` já no formato
{"indice": int, "original": {...}, "dados": {...}}, onde "dados" usa as
mesmas chaves internas de
validador_importacao.tipo_colaborador.CAMPOS_COLABORADOR.

Usa validador_importacao/ como única fonte de verdade do layout oficial
(campos, ordem, obrigatoriedade, regras) e do motor de validação — não
redeclara nem duplica nada disso aqui. Mesmo molde de conversor_clientes.py
(ver esse arquivo pro padrão original sendo replicado aqui) — vários
botões/transformações são diretamente análogos aos de lá (CPF, GMT/idioma/
país, login/senha, duplicidade interna por Nome/CPF/Login); DDI/DDD/Celular
segue o padrão de conversor_simcards.ajustar_telefone (campo único dividido
em 3), não o par telefone/celular com troca de campo de conversor_clientes
(Colaborador tem DDI/DDD/Celular juntos + um "Telefone" avulso, sem DDD
próprio — estruturas diferentes, não dava pra copiar 1:1).
"""
import unicodedata

from validador_importacao import motor as _motor
from validador_importacao.tipo_colaborador import TIPO_COLABORADOR

CAMPOS_COLABORADOR = TIPO_COLABORADOR.campos

CATEGORIAS_ERRO = {
    _motor.CAMPO_NAO_INFORMADO,
    _motor.TAMANHO_INCORRETO,
    _motor.FORMATO_INCORRETO,
    _motor.INCONSISTENCIA,
    _motor.DUPLICIDADE,
}
# Mesmo ajuste de conversor_clientes.py: dígito verificador de CPF não
# bloqueia (a SSX aceita mesmo errado — é heurística, não exigência do
# manual).
CATEGORIAS_AVISO = {_motor.ATENCAO, "digito_verificador"}


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


def _remover_acentos(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _apenas_digitos(valor) -> str:
    return "".join(c for c in _texto(valor) if c.isdigit())


def limpar_cpf(valor) -> str:
    """Remove tudo que não é dígito. Preserva zeros à esquerda (tratado como
    texto, nunca convertido pra número) — não valida, só limpa formatação.
    Mesma ideia de conversor_clientes.limpar_cpf_cnpj, mas só CPF (Colaborador
    é sempre pessoa física)."""
    return _apenas_digitos(valor)


def _dividir_numero_celular(numero_bruto: str, ddi_atual: str, ddd_atual: str, ddd_padrao: str):
    """Mesma lógica de conversor_simcards._dividir_numero_telefone — separa
    um número digitado inteiro numa coluna só (ex.: "5521973838628") em
    (ddi, ddd, celular), só completando o que já não estiver preenchido."""
    digitos = _apenas_digitos(numero_bruto)
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
    """Roda `_dividir_numero_celular` em cada linha de `alvo` — limpa a
    formatação do celular, separa DDI/DDD/Celular pra cada campo (nunca
    mistura as 3 informações num campo só) e, quando o DDI continuar vazio
    depois disso mas a linha tiver alguma informação de celular (DDD e/ou
    número já preenchidos), completa com "55" (Brasil) automaticamente.
    Nunca sobrescreve um DDI/DDD/Celular que a pessoa já preencheu com outro
    valor — só completa o que está vazio. Mesmo padrão de
    conversor_simcards.ajustar_telefone (campo único dividido em 3), não o
    par telefone/celular de conversor_clientes.ajustar_telefones (lá os
    dois campos já nascem separados no layout oficial e o botão só troca
    entre eles; aqui o DDI/DDD/Celular é que precisa nascer separado)."""
    ajustados = 0
    for r in alvo:
        dados = r["dados"]
        ddi_atual = _texto(dados.get("ddi", ""))
        ddd_atual = _texto(dados.get("ddd", ""))
        cel_bruto = _texto(dados.get("celular", ""))

        ddi_novo, ddd_novo, cel_novo = ddi_atual, ddd_atual, cel_bruto
        if cel_bruto:
            ddi_novo, ddd_novo, cel_novo = _dividir_numero_celular(cel_bruto, ddi_atual, ddd_atual, ddd_padrao)

        if not ddi_novo and (ddd_novo or cel_novo):
            ddi_novo = "55"

        mudou = False
        if ddi_novo != ddi_atual:
            dados["ddi"] = ddi_novo
            mudou = True
        if ddd_novo != ddd_atual:
            dados["ddd"] = ddd_novo
            mudou = True
        if cel_novo != cel_bruto:
            dados["celular"] = cel_novo
            mudou = True
        if mudou:
            ajustados += 1
            alterados.add(r["indice"])
    return {"linhas_ajustadas": ajustados}


def preencher_campo_todas_linhas(alvo, alterados, campo: str, valor: str) -> dict:
    """Preenche `campo` com `valor` em TODAS as linhas de `alvo`, mesmo as
    que já tinham algo diferente — útil pra Cargo/Escala/Perfil de acesso/
    Unidade organizacional/GMT/Idioma/País/Tipo de consolidação da jornada,
    que normalmente valem o mesmo pra toda uma leva de colaboradores
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


def preencher_senha(valor_atual, senha_padrao, sobrescrever) -> str:
    """Se `sobrescrever` for falso, só preenche quando `valor_atual` estiver
    vazio — nunca troca uma senha já informada sem pedido explícito. Cópia
    exata de conversor_clientes.preencher_senha."""
    if not sobrescrever and not _vazio(valor_atual):
        return _texto(valor_atual)
    return _texto(senha_padrao)


def verificar_duplicidade_ssx(alvo, pessoas_ssx) -> dict:
    """Compara os registros de `alvo` ({"indice", "dados": {...}}, mesmo
    formato das transformações acima) contra `pessoas_ssx` — lista de dicts
    vinda direto de `POST /Administration/Person/ListPerson` da própria SSX
    (ver `LISTAGENS["pessoas"]` em app.py) — por código de integração, CPF e
    login. Mesmo padrão de conversor_clientes.verificar_duplicidade_ssx.

    O campo de código de integração no retorno de ListPerson é
    "PersonIntegrationCodeClient" — nome DIFERENTE do campo
    "PersonIntegrationCode" usado no corpo de Person/InsertPerson (mesma
    pegadinha de nomenclatura já vista entre outros endpoints "List" vs
    "Insert" da SSX — não são o mesmo texto, confirmado no Swagger).

    Só gera AVISO, nunca erro: a planilha pode ter duplicata de propósito
    (reimportação pra atualizar um colaborador que já existe) e quem decide
    é a usuária, não o sistema."""
    por_codigo, por_documento, por_login = {}, {}, {}
    for p in pessoas_ssx or []:
        nome = _texto(p.get("Name")) or _texto(p.get("PersonIntegrationCodeClient")) or "(sem nome)"
        codigo = _texto(p.get("PersonIntegrationCodeClient"))
        documento = _apenas_digitos(p.get("CPF"))
        login = _texto(p.get("Login")).lower()
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
                "mensagem": f'Já existe colaborador na SSX com "Código de integração" = "{codigo}" ({por_codigo[codigo]}).',
            })

        documento = limpar_cpf(dados.get("cpf", ""))
        if documento and documento in por_documento:
            avisos.append({
                "campo": "CPF", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe colaborador na SSX com esse CPF ({por_documento[documento]}).',
            })

        login = _texto(dados.get("login", "")).lower()
        if login and login in por_login:
            avisos.append({
                "campo": "Login", "categoria": "duplicado_ssx",
                "mensagem": f'Já existe colaborador na SSX com "Login" = "{_texto(dados.get("login"))}" ({por_login[login]}).',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


def verificar_referencias_ssx(alvo, uos_ssx, perfis_ssx) -> dict:
    """O oposto de `verificar_duplicidade_ssx`: ali o esperado é que o
    código AINDA NÃO exista na SSX; aqui o esperado é que o código JÁ
    exista — "Unidade organizacional" e "Perfil de acesso do usuário" são
    referências a cadastros que precisam existir na SSX ANTES da
    importação, senão a API rejeita a linha. `uos_ssx`/`perfis_ssx` vêm
    direto de `OrganizationalUnit/List` / `Client/ListProfileTemplate` (ver
    `LISTAGENS` em app.py).

    "Cargo" e "Escala" NÃO são checados aqui — o Swagger não tem um
    endpoint `List` pra esses dois cadastros (só existem como campo dentro
    de outras respostas), então não tem contra o que comparar.

    Só gera AVISO, nunca erro: a central pode cadastrar o que falta depois
    de importar. Mesmo padrão de conversor_uo.verificar_referencias_ssx."""
    uos_validas = {_texto(u.get("OrganizationalUnitIntegrationCode")).casefold() for u in (uos_ssx or [])}
    perfis_validos = {_texto(p.get("ClientProfileTemplateIntegrationCode")).casefold() for p in (perfis_ssx or [])}
    uos_validas.discard("")
    perfis_validos.discard("")

    por_indice = {}
    for r in alvo:
        dados = r["dados"]
        avisos = []

        uo = _texto(dados.get("unidade_organizacional", ""))
        if uo and uo.casefold() not in uos_validas:
            avisos.append({
                "campo": "Código de integração da unidade organizacional", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'Código de integração da unidade organizacional "{uo}" não foi encontrado entre as Unidades Organizacionais cadastradas na SSX.',
            })

        perfil = _texto(dados.get("perfil_acesso", ""))
        if perfil and perfil.casefold() not in perfis_validos:
            avisos.append({
                "campo": "Perfil de acesso do usuário", "categoria": "nao_cadastrado_ssx",
                "mensagem": f'"Perfil de acesso do usuário" = "{perfil}" não foi encontrado entre os perfis de acesso cadastrados na SSX.',
            })

        if avisos:
            por_indice[r["indice"]] = {"erros": [], "avisos": avisos}
    return por_indice


_CAMPOS_DUPLICIDADE_INTERNA = (
    ("nome", "Nome"),
    ("cpf", "CPF"),
    ("login", "Login"),
)


def verificar_duplicidade_interna(registros) -> dict:
    """Confere se "Nome", "CPF" ou "Login" se repetem entre LINHAS da
    PRÓPRIA planilha sendo trabalhada agora — diferente de
    `verificar_duplicidade_ssx`, que compara contra a base da SSX. "Código
    de integração" repetido na mesma planilha já é pego como ERRO pelo
    motor oficial (`TIPO_COLABORADOR.chaves_unicas`) — não repete aqui.
    Só gera AVISO (categoria "duplicado_planilha"), nunca bloqueia. Mesmo
    padrão de conversor_clientes.verificar_duplicidade_interna (mesmos 3
    campos, só "cpf_cnpj" virou "cpf")."""
    vistos = {chave: {} for chave, _ in _CAMPOS_DUPLICIDADE_INTERNA}
    por_indice = {}
    for r in registros:
        dados = r["dados"]
        avisos = []
        for chave, rotulo in _CAMPOS_DUPLICIDADE_INTERNA:
            bruto = dados.get(chave, "")
            if chave == "cpf":
                valor = limpar_cpf(bruto)
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
    erros_motor = _motor.validar_planilha(TIPO_COLABORADOR, linhas)

    por_indice = {}
    for erro in erros_motor:
        indice = erro.linha - 2  # validar_planilha numera a partir de 2 (linha 1 = cabeçalho)
        balde = "erros" if erro.categoria in CATEGORIAS_ERRO else "avisos"
        entrada = por_indice.setdefault(indice, {"erros": [], "avisos": []})
        entrada[balde].append({"campo": erro.campo, "categoria": erro.categoria, "mensagem": erro.mensagem})
    return por_indice


def gerar_arquivo_oficial(registros) -> str:
    """Texto ASCII separado por ';', uma linha por colaborador, na ordem
    oficial de TIPO_COLABORADOR.campos (mesmo molde do manual, seção
    "Formato") — campo não preenchido mantém a posição vazia. Mesma
    convenção de conversor_clientes.gerar_arquivo_oficial()."""
    linhas_texto = []
    for registro in registros:
        dados = registro["dados"]
        campos_linha = []
        for campo in CAMPOS_COLABORADOR:
            valor = _remover_acentos(_texto(dados.get(campo.chave, "")))
            valor = valor.replace("\r", " ").replace("\n", " ").replace(";", ",")
            campos_linha.append(valor)
        linhas_texto.append(";".join(campos_linha) + ";")
    if not linhas_texto:
        return ""
    return "\r\n".join(linhas_texto) + "\r\n"
