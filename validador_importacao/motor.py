"""Motor de validação: recebe as linhas já mapeadas (dict chave interna ->
valor) e devolve a lista de erros encontrados. Não sabe ler Excel/CSV nem
nada de Flask — isso fica pra fora (ver app.py), justamente pra esse motor
poder ser reaproveitado em qualquer outro programa Python.
"""
from typing import Iterable, List

from .campos import CampoSpec, ErroValidacao, TipoImportacao

# Categorias que espelham exatamente as 3 exceções descritas na documentação
# oficial de importação da SSX ("Regras e exceções").
CAMPO_NAO_INFORMADO = "campo_nao_informado"
TAMANHO_INCORRETO = "tamanho_incorreto"
FORMATO_INCORRETO = "formato_incorreto"
# Categorias extras, fora da documentação oficial, pra regra de negócio
# (ex.: "senha obrigatória se login preenchido") e duplicidade dentro do
# próprio arquivo.
INCONSISTENCIA = "inconsistencia"
DUPLICIDADE = "duplicidade"
ATENCAO = "atencao"


def _valor_vazio(valor) -> bool:
    if valor is None:
        return True
    texto = str(valor).strip()
    return texto == "" or texto.lower() == "nan"


def _valida_byte(texto: str) -> bool:
    try:
        return 0 <= int(texto) <= 255
    except ValueError:
        return False


def _valida_inteiro(texto: str) -> bool:
    try:
        int(texto)
        return True
    except ValueError:
        return False


def _valida_bool(texto: str) -> bool:
    return texto in ("0", "1")


_VALIDADORES_TIPO = {
    "byte": _valida_byte,
    "bool": _valida_bool,
    "inteiro": _valida_inteiro,
}


def validar_campo(spec: CampoSpec, linha: dict, numero_linha: int) -> List[ErroValidacao]:
    erros: List[ErroValidacao] = []
    valor = linha.get(spec.chave)

    if _valor_vazio(valor):
        if spec.eh_obrigatorio(linha):
            erros.append(ErroValidacao(
                numero_linha, spec.rotulo, CAMPO_NAO_INFORMADO,
                f'"{spec.rotulo}" é obrigatório e não foi informado.',
            ))
        return erros

    texto = str(valor).strip()

    if spec.tamanho_max and len(texto) > spec.tamanho_max:
        erros.append(ErroValidacao(
            numero_linha, spec.rotulo, TAMANHO_INCORRETO,
            f'"{spec.rotulo}" tem {len(texto)} caractere(s), acima do limite de {spec.tamanho_max}.',
        ))

    if spec.somente_numeros and not texto.isdigit():
        erros.append(ErroValidacao(
            numero_linha, spec.rotulo, FORMATO_INCORRETO,
            f'"{spec.rotulo}" deve conter somente números — valor informado: "{texto}".',
        ))

    validador_tipo = _VALIDADORES_TIPO.get(spec.tipo)
    if validador_tipo and not validador_tipo(texto):
        erros.append(ErroValidacao(
            numero_linha, spec.rotulo, FORMATO_INCORRETO,
            f'"{spec.rotulo}" = "{texto}" não é um valor do tipo esperado ({spec.tipo}).',
        ))
    elif spec.minimo is not None or spec.maximo is not None:
        try:
            numero = int(texto)
            fora_do_minimo = spec.minimo is not None and numero < spec.minimo
            fora_do_maximo = spec.maximo is not None and numero > spec.maximo
            if fora_do_minimo or fora_do_maximo:
                erros.append(ErroValidacao(
                    numero_linha, spec.rotulo, FORMATO_INCORRETO,
                    f'"{spec.rotulo}" = {numero} deve estar entre {spec.minimo} e {spec.maximo}.',
                ))
        except ValueError:
            pass  # já reportado acima pelo validador de tipo

    if spec.valores_validos and texto not in spec.valores_validos:
        aceitos = ", ".join(spec.valores_validos)
        erros.append(ErroValidacao(
            numero_linha, spec.rotulo, FORMATO_INCORRETO,
            f'"{spec.rotulo}" = "{texto}" não é um valor aceito (esperado: {aceitos}).',
        ))

    return erros


def validar_linha(tipo: TipoImportacao, linha: dict, numero_linha: int) -> List[ErroValidacao]:
    erros: List[ErroValidacao] = []
    for spec in tipo.campos:
        erros.extend(validar_campo(spec, linha, numero_linha))
    for regra in tipo.regras_cruzadas:
        erros.extend(regra(linha, numero_linha))
    return erros


def validar_planilha(tipo: TipoImportacao, linhas: Iterable[dict]) -> List[ErroValidacao]:
    """`linhas`: uma linha da planilha por item (sem contar o cabeçalho),
    já mapeada pra dict {chave_interna: valor}. Numera as linhas a partir de
    2 (linha 1 = cabeçalho), pra bater com o que a pessoa vê no Excel."""
    erros: List[ErroValidacao] = []
    vistos = {chave: {} for chave in tipo.chaves_unicas}

    for pos, linha in enumerate(linhas):
        numero_linha = pos + 2
        erros.extend(validar_linha(tipo, linha, numero_linha))

        for chave in tipo.chaves_unicas:
            valor = linha.get(chave)
            if _valor_vazio(valor):
                continue
            texto = str(valor).strip()
            if texto in vistos[chave]:
                rotulo = next((c.rotulo for c in tipo.campos if c.chave == chave), chave)
                erros.append(ErroValidacao(
                    numero_linha, rotulo, DUPLICIDADE,
                    f'"{rotulo}" = "{texto}" já aparece na linha {vistos[chave][texto]} desta planilha.',
                ))
            else:
                vistos[chave][texto] = numero_linha

    return erros
