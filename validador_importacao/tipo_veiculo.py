"""Regras de validação da Importação de Veículos da SSX.

Baseado no manual "SSX - Importação de Veículos" (v1.8, 04/11/24): lista de
campos, obrigatoriedade, tipo/tamanho, os apêndices de Ícones/Cores do mapa
e a seção "Regras e exceções".
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .motor import ATENCAO, FORMATO_INCORRETO

UFS_VALIDAS = (
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
    "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
    "SP", "SE", "TO",
)


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return str(valor).strip()


def _tem_indicio_rastreador_2(linha: dict) -> bool:
    campos_r2 = (
        "rastreador2_codigo_integracao", "rastreador2_identificacao",
        "rastreador2_identificacao_auxiliar", "rastreador2_template",
        "rastreador2_iccid1", "rastreador2_apn1", "rastreador2_ddi1",
        "rastreador2_ddd1", "rastreador2_telefone1", "rastreador2_iccid2",
        "rastreador2_apn2", "rastreador2_ddi2", "rastreador2_ddd2",
        "rastreador2_telefone2", "rastreador2_imei",
    )
    return any(not _vazio(linha.get(chave)) for chave in campos_r2)


CAMPOS_VEICULO = [
    CampoSpec("codigo_integracao_veiculo", "Código de integração do veículo da central", "texto",
              tamanho_max=40, obrigatorio=True),
    CampoSpec("codigo_integracao_cliente", "Código de integração do cliente", "texto",
              tamanho_max=40, obrigatorio=True,
              descricao='Use "#$CENTRALSSX#$" se o veículo for da própria central.'),
    CampoSpec("identificacao", "Identificação", "texto", tamanho_max=150, obrigatorio=True),
    CampoSpec("placa", "Placa", "texto", tamanho_max=15, obrigatorio=True),
    CampoSpec("chassi", "Chassi", "texto", tamanho_max=50),
    CampoSpec("renavam", "Renavam", "texto", tamanho_max=50),
    CampoSpec("cor", "Cor", "texto", tamanho_max=50),
    CampoSpec("uf", "UF", "texto", tamanho_max=2, valores_validos=UFS_VALIDAS),
    CampoSpec("cidade", "Cidade", "texto", tamanho_max=100),
    CampoSpec("ano_modelo", "Ano do modelo", "inteiro"),
    CampoSpec("ano_fabricacao", "Ano de fabricação", "inteiro"),
    # 1: Gasolina; 2: Álcool; 3: Diesel; 4: Gás natural; 5: Diesel S10; 6: ARLA32;
    # 7: Diesel S10 Aditivado; 8: Diesel S10 Especial; 9: Diesel S500 Comum.
    CampoSpec("combustivel", "Combustível", "byte", valores_validos=tuple(str(n) for n in range(1, 10))),
    CampoSpec("qr_code", "QR Code", "texto", tamanho_max=100),
    CampoSpec("codigo_fipe", "Código FIPE", "texto", tamanho_max=40),
    # Vide apêndice "Ícones do Mapa" do manual (códigos 1 a 64).
    CampoSpec("icone_mapa", "Ícone do mapa", "inteiro", obrigatorio=True, minimo=1, maximo=64),
    # Vide apêndice "Cores de Ícones do Mapa" do manual (códigos 1 a 13).
    CampoSpec("cor_icone_mapa", "Cor do ícone do mapa", "inteiro", obrigatorio=True, minimo=1, maximo=13),
    CampoSpec("exibir_status_ignicao", "Exibir status ignição", "bool", valores_validos=("0", "1")),
    CampoSpec("exibir_status_operacional", "Exibir status operacional", "bool", valores_validos=("0", "1")),
    CampoSpec("exibir_status_gps", "Exibir status GPS", "bool", valores_validos=("0", "1")),
    CampoSpec("exibir_status_violacao", "Exibir status violação", "bool", valores_validos=("0", "1")),
    CampoSpec("codigo_responsavel", "Cód. de int. do responsável", "texto", tamanho_max=200,
              descricao="Códigos separados por vírgula. Ex.: C001,C002,C003"),
    CampoSpec("sobrescrever_responsaveis", "Sobrescrever responsáveis", "bool",
              tamanho_max=1, valores_validos=("0", "1")),
    # 1 = Login SSX Onboard; 2 = Teclado; 3 = RFID; 4 = IButton; 6 = Motorista fixo (não existe 5).
    CampoSpec("tipo_identificacao_motorista", "Tipo de identificação do motorista", "inteiro",
              valores_validos=("1", "2", "3", "4", "6")),
    CampoSpec("procedimento_atendimento", "Procedimento de atendimento", "texto", tamanho_max=500),

    # --- Rastreador 1 (a SSX aceita no máximo 2 rastreadores, 2 SIM cards cada) ---
    CampoSpec("rastreador1_codigo_integracao", "Rastreador 1 - Código de integração", "texto", tamanho_max=40),
    CampoSpec("rastreador1_identificacao", "Rastreador 1 - Identificação", "texto", tamanho_max=32),
    CampoSpec("rastreador1_identificacao_auxiliar", "Rastreador 1 - Identificação auxiliar", "texto",
              tamanho_max=50, descricao="O modelo do rastreador importado precisa ter essa identificação."),
    # "Se informar a identificação do rastreador 1, o cód. de integração do template passa a ser obrigatório."
    CampoSpec("rastreador1_template", "Rastreador 1 - Template", "texto", tamanho_max=40,
              obrigatorio=lambda linha: not _vazio(linha.get("rastreador1_identificacao"))),
    CampoSpec("rastreador1_iccid1", "Rastreador 1 - ICCID (SIM 1)", "texto", tamanho_max=40),
    CampoSpec("rastreador1_apn1", "Rastreador 1 - APN (SIM 1)", "texto", tamanho_max=40),
    CampoSpec("rastreador1_ddi1", "Rastreador 1 - DDI (SIM 1)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador1_ddd1", "Rastreador 1 - DDD (SIM 1)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador1_telefone1", "Rastreador 1 - Telefone (SIM 1)", "texto", tamanho_max=40, somente_numeros=True),
    CampoSpec("rastreador1_iccid2", "Rastreador 1 - ICCID (SIM 2)", "texto", tamanho_max=40),
    CampoSpec("rastreador1_apn2", "Rastreador 1 - APN (SIM 2)", "texto", tamanho_max=40),
    CampoSpec("rastreador1_ddi2", "Rastreador 1 - DDI (SIM 2)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador1_ddd2", "Rastreador 1 - DDD (SIM 2)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador1_telefone2", "Rastreador 1 - Telefone (SIM 2)", "texto", tamanho_max=40, somente_numeros=True),
    CampoSpec("rastreador1_imei", "Rastreador 1 - IMEI", "texto", tamanho_max=15, somente_numeros=True),

    # --- Rastreador 2 ---
    CampoSpec("rastreador2_codigo_integracao", "Rastreador 2 - Código de integração", "texto", tamanho_max=40),
    # "Se houver um segundo rastreador, a identificação/o template passam a ser obrigatórios."
    CampoSpec("rastreador2_identificacao", "Rastreador 2 - Identificação", "texto", tamanho_max=32,
              obrigatorio=_tem_indicio_rastreador_2),
    CampoSpec("rastreador2_identificacao_auxiliar", "Rastreador 2 - Identificação auxiliar", "texto",
              tamanho_max=50, descricao="O modelo do rastreador importado precisa ter essa identificação."),
    CampoSpec("rastreador2_template", "Rastreador 2 - Template", "texto", tamanho_max=40,
              obrigatorio=_tem_indicio_rastreador_2),
    CampoSpec("rastreador2_iccid1", "Rastreador 2 - ICCID (SIM 1)", "texto", tamanho_max=40),
    CampoSpec("rastreador2_apn1", "Rastreador 2 - APN (SIM 1)", "texto", tamanho_max=40),
    CampoSpec("rastreador2_ddi1", "Rastreador 2 - DDI (SIM 1)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador2_ddd1", "Rastreador 2 - DDD (SIM 1)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador2_telefone1", "Rastreador 2 - Telefone (SIM 1)", "texto", tamanho_max=40, somente_numeros=True),
    CampoSpec("rastreador2_iccid2", "Rastreador 2 - ICCID (SIM 2)", "texto", tamanho_max=40),
    CampoSpec("rastreador2_apn2", "Rastreador 2 - APN (SIM 2)", "texto", tamanho_max=40),
    CampoSpec("rastreador2_ddi2", "Rastreador 2 - DDI (SIM 2)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador2_ddd2", "Rastreador 2 - DDD (SIM 2)", "texto", tamanho_max=4, somente_numeros=True),
    CampoSpec("rastreador2_telefone2", "Rastreador 2 - Telefone (SIM 2)", "texto", tamanho_max=40, somente_numeros=True),
    CampoSpec("rastreador2_imei", "Rastreador 2 - IMEI", "texto", tamanho_max=15, somente_numeros=True),

    CampoSpec("unidade_organizacional", "Código de integração da unidade organizacional", "texto",
              tamanho_max=40, descricao="Passa a ser obrigatório para clientes Global Bus (não verificável aqui)."),
    CampoSpec("veiculo_cliente", "Código de integração do veículo do cliente", "texto", tamanho_max=40),
]


def _regra_codigo_responsavel_com_item_vazio(linha: dict, numero_linha: int):
    valor = linha.get("codigo_responsavel")
    if _vazio(valor):
        return []
    itens = _texto(valor).split(",")
    if any(item.strip() == "" for item in itens):
        return [ErroValidacao(
            numero_linha, "Cód. de int. do responsável", FORMATO_INCORRETO,
            f'"Cód. de int. do responsável" = "{_texto(valor)}" tem um código vazio entre vírgulas.',
        )]
    return []


def _regra_imei_tamanho(linha: dict, numero_linha: int):
    erros = []
    for chave, rotulo in (("rastreador1_imei", "Rastreador 1 - IMEI"), ("rastreador2_imei", "Rastreador 2 - IMEI")):
        valor = linha.get(chave)
        if _vazio(valor):
            continue
        digitos = "".join(c for c in _texto(valor) if c.isdigit())
        if len(digitos) != 15:
            erros.append(ErroValidacao(
                numero_linha, rotulo, ATENCAO,
                f'"{rotulo}" = "{_texto(valor)}" tem {len(digitos)} dígito(s) — um IMEI válido sempre tem 15.',
            ))
    return erros


TIPO_VEICULO = TipoImportacao(
    chave="veiculo",
    titulo="Veículo",
    campos=CAMPOS_VEICULO,
    regras_cruzadas=(
        _regra_codigo_responsavel_com_item_vazio,
        _regra_imei_tamanho,
    ),
    chaves_unicas=("codigo_integracao_veiculo", "placa"),
)
