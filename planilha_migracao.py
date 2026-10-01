"""Acesso ao Google Drive/Sheets para as planilhas de migração por cliente.

Componente independente (só usa google-api-python-client + stdlib) — não
importa nada de app.py, para não criar import circular quando app.py vier a
importar este módulo. Reusa a MESMA credencial de service account do
Firebase (env var FIREBASE_CREDENTIALS_JSON), só que com escopo próprio.
"""
import json
import os
import re
import time
import unicodedata
from functools import lru_cache

from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# Planilha-modelo a ser copiada a cada "Criar planilha" (cronograma de
# migração em branco). Id extraído do link informado pelo usuário:
# https://docs.google.com/spreadsheets/d/1EGA9TOzrkV4X0I0xRXhgbMde6-DL0JspmelyAdURC8U/edit
TEMPLATE_ID = "1EGA9TOzrkV4X0I0xRXhgbMde6-DL0JspmelyAdURC8U"

# Pastas de destino: precisam estar dentro de um Drive Compartilhado de
# verdade (tem cota própria) — conta de serviço não tem armazenamento
# próprio, então copiar pra uma pasta comum do "Meu Drive" de alguém sempre
# dá storageQuotaExceeded, mesmo com a pasta compartilhada como editor.
# Estrutura usada (dentro do Drive Compartilhado "Migração",
# https://drive.google.com/drive/folders/0ABgWhzPxLh6tUk9PVA):
#   Migrações/            <- PASTA_MIGRACOES_ID: toda planilha nasce aqui
#   Migrações/Finalizadas/ <- PASTA_FINALIZADAS_ID: pra onde ela vai ao finalizar
PASTA_MIGRACOES_ID = "1TU7XMVR06uRExCu-pDmbKiDLvIYuVQMy"
PASTA_FINALIZADAS_ID = "1dhTpK_l3VbyPA_1EcMnN6zqn4LYa8bH6"


class PlanilhaMigracaoError(Exception):
    """Erro de configuração (credencial/env var faltando)."""


@lru_cache
def _credenciais():
    cred_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")
    if not cred_json:
        raise PlanilhaMigracaoError(
            "Variável de ambiente FIREBASE_CREDENTIALS_JSON não definida."
        )
    return service_account.Credentials.from_service_account_info(
        json.loads(cred_json), scopes=SCOPES
    )


@lru_cache
def _servico_drive():
    return build("drive", "v3", credentials=_credenciais())


@lru_cache
def _servico_sheets():
    return build("sheets", "v4", credentials=_credenciais())


def testar_conexao(arquivo_id: str) -> dict:
    """Verificação simples e só-leitura: busca metadados de UM arquivo do
    Drive (passe o id de um arquivo já compartilhado com a conta de
    serviço, ex.: o modelo "00 PADRÃO CRONOGRAMA MIGRAÇÃO"). Se retornar
    o nome do arquivo, a conexão (credencial + escopo + compartilhamento)
    está funcionando de ponta a ponta.

    Levanta googleapiclient.errors.HttpError se o arquivo não existir ou
    não tiver sido compartilhado com a conta de serviço (403/404) — erro
    já vem com mensagem do Google explicando qual dos dois é.
    """
    arquivo = _servico_drive().files().get(
        fileId=arquivo_id, fields="id,name,mimeType,webViewLink"
    ).execute()
    return arquivo


def criar_planilha_migracao(nome_cliente: str) -> dict:
    """Copia a planilha-modelo (TEMPLATE_ID) pra dentro de Migrações/
    (PASTA_MIGRACOES_ID), nomeando a cópia "<nome do cliente> - MIG -
    DD/MM/AAAA". Devolve {id, name, webViewLink} da planilha nova.

    supportsAllDrives=True é obrigatório pra qualquer operação (leitura ou
    escrita) que envolva um Drive Compartilhado — sem isso a API se comporta
    como se o arquivo/pasta não existisse.

    Levanta PlanilhaMigracaoError (credencial faltando) ou
    googleapiclient.errors.HttpError (ex.: modelo não compartilhado com a
    conta de serviço, ou a pasta não é mais um Drive Compartilhado
    válido/acessível pela conta de serviço).
    """
    drive = _servico_drive()
    nome_copia = f"{nome_cliente} - MIG - {time.strftime('%d/%m/%Y')}"
    corpo = {"name": nome_copia, "parents": [PASTA_MIGRACOES_ID]}
    copia = drive.files().copy(
        fileId=TEMPLATE_ID, body=corpo, fields="id,name,webViewLink", supportsAllDrives=True
    ).execute()
    return copia


def _extrair_id_planilha(link_ou_id: str) -> str:
    """Aceita tanto um link completo do Sheets quanto o id puro."""
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", link_ou_id or "")
    return m.group(1) if m else (link_ou_id or "").strip()


def finalizar_planilha_migracao(link_planilha: str) -> dict:
    """Ao finalizar uma migração: renomeia a planilha (acrescenta " -
    FINALIZADA" no nome atual) e move ela de Migrações/ pra
    Migrações/Finalizadas/. Devolve {id, name, webViewLink}.

    Não falha se a planilha já não estiver em PASTA_MIGRACOES_ID (ex.: já foi
    movida antes) — só garante que, no final, ela esteja em
    PASTA_FINALIZADAS_ID.
    """
    drive = _servico_drive()
    arquivo_id = _extrair_id_planilha(link_planilha)
    atual = drive.files().get(fileId=arquivo_id, fields="id,name,parents", supportsAllDrives=True).execute()
    nome_atual = atual.get("name", "")
    if not nome_atual.endswith(" - FINALIZADA"):
        nome_novo = f"{nome_atual} - FINALIZADA"
    else:
        nome_novo = nome_atual
    pais_atuais = atual.get("parents") or []
    atualizado = drive.files().update(
        fileId=arquivo_id,
        body={"name": nome_novo},
        addParents=PASTA_FINALIZADAS_ID,
        removeParents=",".join(p for p in pais_atuais if p != PASTA_FINALIZADAS_ID),
        fields="id,name,webViewLink",
        supportsAllDrives=True,
    ).execute()
    return atualizado


def _normalizar_cabecalho(texto):
    """minúsculo, sem acento, sem espaço nas pontas — pra casar "Veículo",
    "veiculo ", "VEÍCULO" etc. como o mesmo nome de coluna."""
    sem_acento = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return " ".join(sem_acento.lower().split())


# Nomes (normalizados) que cada coluna pode ter na aba "Migração" → campo
# interno. A ORDEM das colunas na planilha não importa — o time pode mudar,
# reordenar ou adicionar colunas à vontade; só o nome do cabeçalho precisa
# continuar reconhecível. "C" (contador de duplicidade) e "Debug" (rascunho
# da checagem manual) são auxiliares da própria planilha, sem campo
# equivalente aqui — ficam de fora de propósito (não estão no mapa).
_ALIASES_COLUNAS_MIGRACAO = {
    "status": "status",
    "cliente": "cliente",
    "veiculo": "veiculo",
    "modelo": "equipamento",
    "id do equipamento": "id_equipamento",
    "apn": "apn",
    "l/s apn": "ls_apn",
    "ls apn": "ls_apn",
    "comando": "comando",
    "numero da linha": "numero_linha",
    "ultima comunicacao": "ultima_comunicacao",
}

# "Comunicou" (equipamento bateu no sistema novo) é o único valor da lista
# suspensa da planilha que não existe literalmente em STATUS_VEICULO_VALIDOS
# (app.py) — equivale a "Migrado" por lá. Os outros três têm o mesmo nome.
STATUS_PLANILHA_PARA_SISTEMA = {
    "Aguardando": "Aguardando",
    "Enviar": "Enviar",
    "Enviado": "Enviado",
    "Comunicou": "Migrado",
}


def _mapear_colunas(cabecalho, aliases):
    """cabecalho: lista de títulos (linha 1 da aba). Devolve {campo: índice}
    pra cada título reconhecido em `aliases` — título não reconhecido (ex.:
    "C", "Debug", coluna nova que o time criou) é ignorado, não dá erro."""
    mapa = {}
    for indice, titulo in enumerate(cabecalho):
        campo = aliases.get(_normalizar_cabecalho(titulo))
        if campo:
            mapa[campo] = indice
    return mapa


def _valor_coluna(linha, mapa, campo):
    indice = mapa.get(campo)
    if indice is None or indice >= len(linha):
        return ""
    return str(linha[indice] or "").strip()


def ler_veiculos_planilha_migracao(link_planilha: str) -> list:
    """Lê a aba "Migração" (linha 1 é cabeçalho, dados a partir da linha 2) e
    devolve uma lista de dicts já no formato de veículo do sistema (mesmos
    nomes de CAMPOS_VEICULO_ITEM em app.py, mais "status"). As colunas são
    localizadas pelo NOME do cabeçalho (ver _ALIASES_COLUNAS_MIGRACAO), não
    pela posição — o time pode reordenar/adicionar colunas na planilha sem
    quebrar o import. Pula linhas sem Cliente preenchido, ou sem Veículo E
    sem id do equipamento (nenhum jeito de identificar a linha sem pelo
    menos um dos dois — no começo da migração é comum a placa ainda não
    estar preenchida, só o id do equipamento; nesse caso ele vira o
    identificador até a placa chegar).
    """
    sheet_id = _extrair_id_planilha(link_planilha)
    resp = _servico_sheets().spreadsheets().values().get(
        spreadsheetId=sheet_id, range="'Migração'!A1:ZZ"
    ).execute()
    linhas = resp.get("values", [])
    if not linhas:
        return []
    mapa = _mapear_colunas(linhas[0], _ALIASES_COLUNAS_MIGRACAO)

    veiculos = []
    for linha in linhas[1:]:
        cliente = _valor_coluna(linha, mapa, "cliente")
        id_equipamento = _valor_coluna(linha, mapa, "id_equipamento")
        veiculo = _valor_coluna(linha, mapa, "veiculo") or id_equipamento
        if not cliente or not veiculo:
            continue
        veiculos.append({
            "cliente": cliente,
            "veiculo": veiculo,
            "equipamento": _valor_coluna(linha, mapa, "equipamento"),
            "id_equipamento": id_equipamento,
            "apn": _valor_coluna(linha, mapa, "apn"),
            "ls_apn": _valor_coluna(linha, mapa, "ls_apn"),
            "numero_linha": _valor_coluna(linha, mapa, "numero_linha"),
            "comando": _valor_coluna(linha, mapa, "comando"),
            "ultima_comunicacao": _valor_coluna(linha, mapa, "ultima_comunicacao"),
            "status": STATUS_PLANILHA_PARA_SISTEMA.get(_valor_coluna(linha, mapa, "status"), "Aguardando"),
        })
    return veiculos


_ALIASES_RESUMO_MODELOS = {
    "modelo": "modelo",
    "%": "percentual",
    "aguardando": "aguardando",
    "enviar": "enviar",
    "enviado": "enviado",
    "comunicou": "comunicou",
    "total": "total",
}


def ler_resumo_modelos_planilha_migracao(link_planilha: str) -> list:
    """Lê a tabela "Modelo | % | Aguardando | Enviar | Enviado | Comunicou |
    Total" da aba "Infos gerais" — são fórmulas da própria planilha
    (COUNTIFS em cima da aba Migração), lidas prontas em vez de
    recalculadas aqui: o time mexe direto na planilha (ajusta fórmula,
    adiciona linha de modelo novo etc.) e o sistema só reflete o que já foi
    calculado lá, não reimplementa a conta.

    Acha o cabeçalho procurando a linha cuja primeira célula é "Modelo"
    (em vez de assumir que é sempre a linha 13) e mapeia as colunas
    seguintes pelo nome — não pela posição, igual ler_veiculos_planilha_migracao.
    Devolve [] se não achar essa linha (tabela renomeada/removida).
    """
    sheet_id = _extrair_id_planilha(link_planilha)
    resp = _servico_sheets().spreadsheets().values().get(
        spreadsheetId=sheet_id, range="'Infos gerais'!A1:H60"
    ).execute()
    linhas = resp.get("values", [])
    indice_cabecalho = next(
        (i for i, linha in enumerate(linhas) if linha and _normalizar_cabecalho(linha[0]) == "modelo"),
        None,
    )
    if indice_cabecalho is None:
        return []
    mapa = _mapear_colunas(linhas[indice_cabecalho], _ALIASES_RESUMO_MODELOS)

    resumo = []
    for linha in linhas[indice_cabecalho + 1:]:
        modelo = _valor_coluna(linha, mapa, "modelo")
        if not modelo:
            continue
        resumo.append({campo: _valor_coluna(linha, mapa, campo) for campo in _ALIASES_RESUMO_MODELOS.values()})
    return resumo


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("Uso: python planilha_migracao.py <id-do-arquivo-no-drive>")
        sys.exit(1)
    resultado = testar_conexao(sys.argv[1])
    print("Conectado! Arquivo encontrado:")
    print(f"  nome: {resultado['name']}")
    print(f"  tipo: {resultado['mimeType']}")
    print(f"  link: {resultado.get('webViewLink')}")
