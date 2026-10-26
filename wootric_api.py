"""Cliente da API REST da Wootric — avaliações de NPS, sincronizadas para a
tabela local `wootric_avaliacoes` (ver wootric_sql.py) em vez de consultadas
na hora em toda abertura de Ficha. Ver docs/DOCUMENTACAO_TECNICA.md e
https://docs.wootric.com/api/.

Autenticação: OAuth `client_credentials` (`WOOTRIC_CLIENT_ID`/
`WOOTRIC_CLIENT_SECRET`), igual ao padrão de `SSXDESK_API_KEY` — uma única
credencial pro sistema inteiro, não por usuário. O access token expira em
7200s; cacheado em processo com margem de segurança.

IdCentral: nesta conta Wootric (confirmado consultando a API diretamente —
mesma conta do projeto irmão `kanban_dashboard_dev`), o end_user NÃO tem
`external_id` preenchido; o IdCentral aparece no final do e-mail do end_user
(ex.: "(SSX) contato@dominio.com - 997") — mesmo mecanismo usado em
`kanban_dashboard_dev` (`server/wootric.ts`, `centralIdFromEmail`).

Sincronização: `GET /v1/responses` já devolve o end_user (com e-mail)
embutido em cada resposta — não precisa mais varrer `/v1/end_users` por
inteiro (abordagem antiga, trocada por essa: ver HISTÓRICO_DECISOES.md).
`buscar_respostas_desde` aceita um cursor (timestamp unix) e usa o filtro
`created[gte]` documentado da API — sincronização incremental normal nunca
precisa da varredura completa de novo, só busca o que mudou desde a última
vez (ver `sincronizar_avaliacoes` em app.py, que usa o timestamp mais
recente já salvo como cursor).

Limite documentado da Wootric: paginação até 30 páginas de 50 itens (1500
respostas por consulta). Isso só importa na primeira sincronização (tabela
vazia) — pega as 1500 mais recentes da conta inteira como carga inicial;
sincronizações seguintes são incrementais e pequenas, nunca esbarram nesse
teto."""
import os
import time
from datetime import datetime, timezone

import requests

_BASE_URL = "https://api.wootric.com"
_TOKEN_URL = f"{_BASE_URL}/oauth/token"
_RESPONSES_URL = f"{_BASE_URL}/v1/responses"
_CLIENT_ID = os.environ.get("WOOTRIC_CLIENT_ID")
_CLIENT_SECRET = os.environ.get("WOOTRIC_CLIENT_SECRET")
_TIMEOUT_SEGUNDOS = 15
_TOKEN_MARGEM_SEGUNDOS = 200  # renova um pouco antes dos 7200s reais
_MAX_PAGINAS = 30  # limite documentado da Wootric


class WootricApiError(Exception):
    """Erro de comunicação com a API da Wootric — sempre com mensagem já
    pronta pra mostrar na tela (nunca stacktrace cru)."""


_cache_token = {"valor": None, "expira_em": 0.0}


def _obter_token():
    if not _CLIENT_ID or not _CLIENT_SECRET:
        raise WootricApiError(
            "Variáveis de ambiente WOOTRIC_CLIENT_ID/WOOTRIC_CLIENT_SECRET não "
            "definidas. Configure-as com as credenciais OAuth geradas na conta Wootric."
        )
    agora = time.time()
    if _cache_token["valor"] and agora < _cache_token["expira_em"]:
        return _cache_token["valor"]
    try:
        resp = requests.post(
            _TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": _CLIENT_ID,
                "client_secret": _CLIENT_SECRET,
            },
            timeout=_TIMEOUT_SEGUNDOS,
        )
    except requests.RequestException as err:
        raise WootricApiError(f"Falha de conexão com a API da Wootric: {err}") from err
    if not resp.ok:
        raise WootricApiError(f"Autenticação na Wootric falhou (status {resp.status_code}).")
    token = (resp.json() or {}).get("access_token")
    if not token:
        raise WootricApiError("Wootric não retornou access_token.")
    _cache_token["valor"] = token
    _cache_token["expira_em"] = agora + 7200 - _TOKEN_MARGEM_SEGUNDOS
    return token


def _tempo_de_espera_rate_limit(resp):
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return min(5.0, max(0.5, float(retry_after)))
        except ValueError:
            pass
    reset_em = resp.headers.get("X-Rate-Limit-Reset")
    if reset_em:
        try:
            return min(5.0, max(0.5, float(reset_em) - time.time()))
        except ValueError:
            pass
    return 1.0


def _get_responses(params, tentativas=3):
    token = _obter_token()
    for tentativa in range(1, tentativas + 1):
        try:
            resp = requests.get(
                _RESPONSES_URL,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                params=params,
                timeout=_TIMEOUT_SEGUNDOS,
            )
        except requests.RequestException as err:
            raise WootricApiError(f"Falha de conexão com a API da Wootric: {err}") from err
        if resp.status_code == 429:
            if tentativa == tentativas:
                raise WootricApiError("Limite de requisições à API da Wootric excedido — tente de novo em instantes.")
            time.sleep(_tempo_de_espera_rate_limit(resp))
            continue
        if not resp.ok:
            raise WootricApiError(f"Erro na API da Wootric (status {resp.status_code}).")
        return resp.json() or []


def _idcentral_do_email(email):
    # Mesmo padrão do kanban_dashboard_dev (centralIdFromEmail): código no
    # final do e-mail, ex. "(SSX) contato@dominio.com - 997".
    import re
    match = re.search(r"-\s*(\d+)\s*$", email or "")
    return match.group(1) if match else ""


def _parse_data_wootric(valor):
    """"2026-10-24 05:55:07 -0700" -> datetime timezone-aware (UTC)."""
    if not valor:
        return None
    try:
        return datetime.strptime(valor, "%Y-%m-%d %H:%M:%S %z").astimezone(timezone.utc)
    except ValueError:
        return None


def _idcentral_da_resposta(resposta):
    end_user = resposta.get("end_user") or {}
    idcentral = (resposta.get("external_id") or end_user.get("external_id") or "").strip()
    if idcentral:
        return idcentral
    return _idcentral_do_email(resposta.get("email") or end_user.get("email"))


def _normalizar_resposta(resposta):
    end_user = resposta.get("end_user") or {}
    return {
        "wootric_id": str(resposta["id"]),
        "idcentral": _idcentral_da_resposta(resposta),
        "score": resposta.get("score"),
        "texto": (resposta.get("text") or "").strip(),
        "email": resposta.get("email") or end_user.get("email") or "",
        "criado_em_wootric": _parse_data_wootric(resposta.get("created_at")),
    }


def buscar_respostas_desde(criado_gte_unix=None):
    """`GET /v1/responses` paginado, com `created[gte]` quando houver cursor.

    Com cursor (sincronização incremental normal): ordena ASC — só busca o
    que mudou desde a última vez, e se parar no meio por algum erro, a
    próxima rodada retoma de onde parou em vez de pular respostas.

    Sem cursor (primeira sincronização, tabela vazia): ordena DESC — o teto
    de 30 páginas (1500 respostas) da API é por consulta, não por conta, e
    com histórico de anos a conta pode ter muito mais do que isso. Pegar as
    mais RECENTES primeiro é o que importa pra carga inicial (teto batido =
    perde só o histórico mais antigo, não o mais relevante agora)."""
    respostas = []
    pagina = 1
    ordem = "asc" if criado_gte_unix is not None else "desc"
    while pagina <= _MAX_PAGINAS:
        params = {"page": pagina, "per_page": 50, "sort_order": ordem, "sort_key": "created_at"}
        if criado_gte_unix is not None:
            params["created[gte]"] = int(criado_gte_unix)
        lote = _get_responses(params)
        respostas.extend(lote)
        if len(lote) < 50:
            break
        pagina += 1
    normalizadas = [_normalizar_resposta(r) for r in respostas if r.get("id") is not None]
    return [r for r in normalizadas if r["criado_em_wootric"] is not None]
