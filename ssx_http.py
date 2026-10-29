"""Requisições HTTP resilientes para consultas à API da SSX."""

import time

import requests


_STATUS_RETRY = {502, 503, 504}


def post_json(url, payload, headers, timeout=20, retries=0):
    """Faz POST JSON e repete falhas temporárias de rede/gateway.

    `retries` é o número de tentativas adicionais. O retry de POST é usado
    apenas pelos endpoints de consulta (idempotentes), nunca por operações
    que alteram dados.
    """
    for tentativa in range(retries + 1):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=timeout)
            if response.status_code in _STATUS_RETRY and tentativa < retries:
                time.sleep(min(2 ** tentativa, 4))
                continue
            response.raise_for_status()
            return [] if not response.content else response.json()
        except (requests.Timeout, requests.ConnectionError):
            if tentativa >= retries:
                raise
            time.sleep(min(2 ** tentativa, 4))
