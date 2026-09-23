"""Validação de dígito verificador de CPF/CNPJ.

Não é uma exigência da documentação de importação da SSX (que só pede
"somente números" e tamanho máximo 14) — é um heurístico a mais pra pegar
erro de digitação que a SSX aceitaria de boa, mas que provavelmente é lixo.
Por isso o motor reporta isso numa categoria separada ("digito_verificador").
"""


def _somente_digitos(numero: str) -> str:
    return "".join(c for c in numero if c.isdigit())


def cpf_valido(numero: str) -> bool:
    numero = _somente_digitos(numero)
    if len(numero) != 11 or numero == numero[0] * 11:
        return False
    for i in (9, 10):
        soma = sum(int(numero[num]) * peso for num, peso in enumerate(range(i + 1, 1, -1)))
        digito = (soma * 10 % 11) % 10
        if digito != int(numero[i]):
            return False
    return True


def cnpj_valido(numero: str) -> bool:
    numero = _somente_digitos(numero)
    if len(numero) != 14 or numero == numero[0] * 14:
        return False
    pesos_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    pesos_2 = [6] + pesos_1
    for pesos, pos in ((pesos_1, 12), (pesos_2, 13)):
        soma = sum(int(numero[i]) * pesos[i] for i in range(pos))
        digito = 11 - (soma % 11)
        digito = 0 if digito >= 10 else digito
        if digito != int(numero[pos]):
            return False
    return True


def cpf_ou_cnpj_valido(numero: str) -> bool:
    digitos = _somente_digitos(numero)
    if len(digitos) == 11:
        return cpf_valido(digitos)
    if len(digitos) == 14:
        return cnpj_valido(digitos)
    return False
