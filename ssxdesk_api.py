"""Cliente da API de Integrações do SSX Desk (ssxdesk.ssatx.com.br) — chamados
de suporte do cliente, buscados pelo IdCentral (ver
https://ssxdesk.ssatx.com.br/settings, aba de API).

Autenticação: chave de API fixa (`SSXDESK_API_KEY`, Bearer token), igual ao
padrão de `FIREBASE_CREDENTIALS_JSON`/`DATABASE_URL` — uma única chave pro
sistema inteiro, não por usuário.

`IdCentral` NÃO é um filtro direto da API (nem é único do lado do ssxdesk —
duas empresas podem compartilhar o mesmo IdCentral, caso de marcas/CNPJs
diferentes na mesma conta Central). O caminho é: 1) listar todas as empresas
(`GET /companies`, cacheado — isso quase não muda) e achar as que batem com
o IdCentral; 2) buscar os chamados (`GET /tickets`) de cada uma, filtrando
por `companyId`.
"""
import os
import threading
import time

import requests

_BASE_URL = "https://ssxdesk.ssatx.com.br/api/integrations/v1"
_API_KEY = os.environ.get("SSXDESK_API_KEY")
_TIMEOUT_SEGUNDOS = 15

STATUS_CONCLUIDO = "Concluído"


class SsxDeskApiError(Exception):
    """Erro de comunicação com a API do ssxdesk — sempre com mensagem já
    pronta pra mostrar na tela (nunca stacktrace cru)."""


def _chamada(path, params=None):
    if not _API_KEY:
        raise SsxDeskApiError(
            "Variável de ambiente SSXDESK_API_KEY não definida. Configure-a com "
            "uma chave de API gerada em ssxdesk.ssatx.com.br/settings."
        )
    try:
        resp = requests.get(
            f"{_BASE_URL}{path}",
            headers={"Authorization": f"Bearer {_API_KEY}"},
            params=params or {},
            timeout=_TIMEOUT_SEGUNDOS,
        )
    except requests.RequestException as err:
        raise SsxDeskApiError(f"Falha de conexão com a API do ssxdesk: {err}") from err

    if resp.status_code == 401:
        raise SsxDeskApiError("Chave de API do ssxdesk ausente, inválida ou revogada.")
    if resp.status_code == 403:
        raise SsxDeskApiError("Chave de API do ssxdesk sem permissão (escopo) para essa consulta.")
    if resp.status_code == 429:
        raise SsxDeskApiError("Limite de requisições à API do ssxdesk excedido (120/min) — tente de novo em instantes.")
    if resp.status_code == 404:
        return None
    try:
        resp.raise_for_status()
    except requests.HTTPError as err:
        status = resp.status_code
        if status >= 500:
            mensagem = f"API do ssxdesk temporariamente indisponível (HTTP {status})."
        else:
            mensagem = f"API do ssxdesk retornou HTTP {status} ao consultar os chamados."
        raise SsxDeskApiError(mensagem) from err
    return resp.json()


# --- Empresas (Company) — resolve IdCentral -> companyId(s) ---

_CACHE_EMPRESAS_TTL_SEGUNDOS = 600  # 10 min: o IdCentral de uma empresa quase nunca muda.
_cache_empresas = {"carregado_em": 0.0, "lista": []}
_lock_empresas = threading.Lock()


def _listar_todas_empresas():
    """`GET /companies` sem "id" devolve todas de uma vez (sem paginação
    documentada) — cacheado em processo, porque bater na API a cada Ficha
    aberta por qualquer pessoa do time comeria rápido o limite de 120
    requisições/minuto da chave (compartilhado por todo mundo que usa o
    sistema, não por usuário)."""
    agora = time.time()
    with _lock_empresas:
        if _cache_empresas["lista"] and agora - _cache_empresas["carregado_em"] < _CACHE_EMPRESAS_TTL_SEGUNDOS:
            return _cache_empresas["lista"]
    dados = _chamada("/companies") or {}
    lista = dados.get("data", [])
    with _lock_empresas:
        _cache_empresas["lista"] = lista
        _cache_empresas["carregado_em"] = agora
    return lista


def buscar_company_ids_por_idcentral(idcentral):
    """Devolve TODOS os `id` de empresa do ssxdesk cujo `idCentral` bate com
    o informado — pode ser mais de um (ver docstring do módulo)."""
    idcentral = (idcentral or "").strip()
    if not idcentral:
        return []
    return [e["id"] for e in _listar_todas_empresas() if (e.get("idCentral") or "").strip() == idcentral]


# --- Chamados (Tickets) ---

def _listar_chamados_da_empresa(company_id):
    chamados = []
    offset = 0
    while True:
        pagina = _chamada("/tickets", params={"companyId": company_id, "limit": 100, "offset": offset}) or {}
        lote = pagina.get("data", [])
        chamados.extend(lote)
        meta = pagina.get("meta", {})
        if not meta.get("hasMore") or not lote:
            break
        offset += meta.get("limit", 100)
    return chamados


def listar_chamados_por_idcentral(idcentral):
    """Todos os chamados (qualquer status) de todas as empresas cujo
    IdCentral bate com o informado, mais recente primeiro. Levanta
    `SsxDeskApiError` se a chave não estiver configurada ou a API falhar —
    quem chama decide se isso bloqueia a tela ou só esconde o bloco."""
    chamados = []
    for company_id in buscar_company_ids_por_idcentral(idcentral):
        chamados.extend(_listar_chamados_da_empresa(company_id))
    chamados.sort(key=lambda t: t.get("createdAt") or "", reverse=True)
    return chamados


def separar_abertos_e_concluidos(chamados):
    """"Concluído" = histórico (Suporte > Histórico da Ficha); qualquer outro
    status (Novo, Em Atendimento, Aguardando Cliente, ...) = em aberto
    (bloco de pendências da Visão Geral)."""
    abertos = [c for c in chamados if c.get("status") != STATUS_CONCLUIDO]
    concluidos = [c for c in chamados if c.get("status") == STATUS_CONCLUIDO]
    return abertos, concluidos
