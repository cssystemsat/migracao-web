"""Estruturas de dados usadas pelo motor de validação (ver motor.py).

Não depende de mais nada do projeto (Flask, pandas etc.) de propósito —
é o "componente" reutilizável: dá pra copiar essa pasta inteira pra outro
programa que precise validar planilha de importação da SSX.
"""
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence, Union

ObrigatorioSpec = Union[bool, Callable[[dict], bool]]


@dataclass
class CampoSpec:
    chave: str  # chave interna usada no mapeamento (ex.: "codigo_integracao")
    rotulo: str  # nome do campo como aparece na documentação da SSX
    tipo: str  # "texto" | "byte" | "bool" | "inteiro"
    tamanho_max: Optional[int] = None
    obrigatorio: ObrigatorioSpec = False
    valores_validos: Optional[Sequence[str]] = None
    minimo: Optional[int] = None
    maximo: Optional[int] = None
    somente_numeros: bool = False
    descricao: str = ""

    def eh_obrigatorio(self, linha: dict) -> bool:
        if callable(self.obrigatorio):
            return bool(self.obrigatorio(linha))
        return bool(self.obrigatorio)


@dataclass
class ErroValidacao:
    linha: int  # número da linha na planilha (cabeçalho = linha 1)
    campo: str
    categoria: str
    mensagem: str


@dataclass
class TipoImportacao:
    chave: str  # ex.: "cliente"
    titulo: str  # ex.: "Cliente"
    campos: Sequence[CampoSpec]
    # Regras que dependem de mais de um campo da mesma linha (ex.: "senha"
    # obrigatória quando "login" for preenchido, endereço só é salvo se os 5
    # campos vierem juntos etc.)
    regras_cruzadas: Sequence[Callable[[dict, int], Sequence[ErroValidacao]]] = field(default_factory=tuple)
    # Chaves que não podem se repetir dentro da MESMA planilha (ex.: código de
    # integração duplicado faz uma linha sobrescrever silenciosamente a outra).
    chaves_unicas: Sequence[str] = field(default_factory=tuple)
