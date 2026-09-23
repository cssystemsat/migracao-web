"""Validador de planilhas de importação da SSX.

Componente independente (só usa a biblioteca padrão do Python) que confere
uma planilha já mapeada contra as regras documentadas de cada tipo de
importação da SSX, antes de mandar de verdade pra API. Pra reaproveitar em
outro programa, basta copiar esta pasta e importar `TIPOS`/`validar_planilha`.

Cada tipo de importação (Cliente, Veículo, UO, Usuário...) vive no seu
próprio módulo (tipo_cliente.py, tipo_veiculo.py, ...) e se registra aqui.
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .motor import validar_campo, validar_linha, validar_planilha
from .tipo_cliente import TIPO_CLIENTE
from .tipo_veiculo import TIPO_VEICULO

TIPOS = {
    "cliente": TIPO_CLIENTE,
    "veiculo": TIPO_VEICULO,
}


def obter_tipo(chave: str) -> TipoImportacao:
    tipo = TIPOS.get(chave)
    if not tipo:
        raise KeyError(f"Tipo de importação desconhecido: {chave!r}")
    return tipo


__all__ = [
    "CampoSpec", "ErroValidacao", "TipoImportacao",
    "validar_campo", "validar_linha", "validar_planilha",
    "TIPOS", "obter_tipo",
]
