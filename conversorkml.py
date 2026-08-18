#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
conversorkml.py
---------------
Converte um arquivo .kml qualquer (ex.: exportado do Google My Maps, Google Earth etc.)
para o padrão de importação SSX descrito no manual.

O que o script faz:
  1. Lê todos os <Placemark> do arquivo de entrada (Polygon, LineString ou Point);
  2. Coleta os dados do <ExtendedData> existente e/ou do bloco {{...}} na descrição
     (padrão: {{Nome|Cód.categoria|Cód.grupo|Tolerância|Cód.área|Cód.cor}});
  3. Completa os campos obrigatórios com valores padrão informados na linha de comando
     (ou gera GeoIntegrationCode automaticamente quando ausente);
  4. Valida as regras do manual (tamanhos máximos, tolerância obrigatória em Ponto,
     mínimo de 3 pontos em áreas, formato das coordenadas etc.);
  5. Gera um novo .kml no padrão de importação, com <ExtendedData> preenchido e
     descrição protegida por <![CDATA[ ]]>.

Uso básico:
    python conversorkml.py entrada.kml saida.kml

Com valores padrão para campos obrigatórios ausentes:
    python conversorkml.py entrada.kml saida.kml \
        --categoria GEOCAT1,GEOCAT2 \
        --grupo GEOGROUP1 \
        --tolerancia 100 \
        --cor 6

O GeoIntegrationCode nunca é lido do KML de origem nem é editável: ele é
sempre calculado pela fórmula fixa "Grupo_Nome_número" (ver gerar_geo_code).
"""

import argparse
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Optional
from xml.sax.saxutils import escape

KML_NS = "http://www.opengis.net/kml/2.2"
NS = {"kml": KML_NS}


@dataclass
class Config:
    """Valores padrão para campos obrigatórios ausentes nos Placemarks."""
    categoria: Optional[str] = None
    grupo: Optional[str] = None
    tolerancia: Optional[int] = None
    cor: Optional[int] = None
    forcar_poligono: bool = False

# Limites do manual
MAX_NAME = 150
MAX_DESCRIPTION = 500
MAX_GEO_CODE = 40
MAX_CATEGORY_CODE = 8000
MAX_GROUP_CODE = 40
MAX_COORDINATES = 8000
MAX_LINHAS_IMPORTACAO = 3000  # limite de linhas por importação (manual SSX v1.4, 13/11/2025)
VALID_COLORS = set(str(i) for i in range(1, 14))

# Regex do bloco {{Nome|Cat|Grupo|Tolerância|CódÁrea|Cor}} na descrição
BLOCO_RE = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)


def _local(tag):
    """Remove o namespace de uma tag XML."""
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _find(elem, nome):
    """Procura um filho direto pelo nome local, com ou sem namespace."""
    for child in elem:
        if _local(child.tag) == nome:
            return child
    return None


def _findall(elem, nome):
    return [c for c in elem if _local(c.tag) == nome]


def _find_rec(elem, nome):
    """Procura descendente (qualquer nível) pelo nome local."""
    for child in elem.iter():
        if _local(child.tag) == nome:
            return child
    return None


def _texto(elem):
    if elem is None or elem.text is None:
        return ""
    return elem.text.strip()


def slug(texto, max_len=20):
    """Gera um identificador simples a partir de um nome (para GeoIntegrationCode automático)."""
    nfkd = unicodedata.normalize("NFKD", texto)
    sem_acento = "".join(c for c in nfkd if not unicodedata.combining(c))
    limpo = re.sub(r"[^A-Za-z0-9]+", "_", sem_acento).strip("_").upper()
    return limpo[:max_len] or "SEM_NOME"


def extrair_bloco_descricao(descricao):
    """
    Extrai o bloco {{Nome|Cat|Grupo|Tolerância|CódÁrea|Cor}} da descrição, se existir.
    Retorna (dados_dict, descricao_sem_bloco).
    """
    m = BLOCO_RE.search(descricao or "")
    if not m:
        return {}, (descricao or "").strip()

    partes = [p.strip() for p in m.group(1).split("|")]
    # Ordem do manual: Nome | Cód.categoria | Cód.grupo | Tolerância | Cód.área | Cód.cor
    campos = ["Name", "CategoryIntegrationCode", "GroupIntegrationCode",
              "Tolerance", "GeoIntegrationCode", "ColorCode"]
    dados = {}
    for campo, valor in zip(campos, partes):
        if valor:
            dados[campo] = valor

    descricao_limpa = re.sub(r" +", " ", BLOCO_RE.sub("", descricao)).strip()
    return dados, descricao_limpa


def extrair_extended_data(placemark):
    """Lê os pares nome/valor de <ExtendedData><Data name=...><value>...</value>."""
    dados = {}
    ext = _find(placemark, "ExtendedData")
    if ext is None:
        return dados
    for data in _findall(ext, "Data"):
        nome = data.get("name", "").strip()
        valor = _texto(_find(data, "value"))
        if nome:
            dados[nome] = valor
    return dados


def extrair_geometria(placemark):
    """
    Retorna (tipo, coordenadas_texto) onde tipo é 'Polygon', 'LineString' ou 'Point'.
    Procura em qualquer nível (Polygon guarda coordinates dentro de outerBoundaryIs/LinearRing).
    """
    for tipo in ("Polygon", "LineString", "Point"):
        geom = _find_rec(placemark, tipo)
        if geom is not None:
            coords = _find_rec(geom, "coordinates")
            return tipo, _texto(coords)
    return None, ""


def normalizar_coordenadas(coords_texto, tipo):
    """
    Normaliza a string de coordenadas para o formato 'lon,lat,0' separadas por espaço.
    Valida se são números com ponto decimal e retorna também a quantidade de pontos.
    """
    tokens = coords_texto.split()
    pontos = []
    for token in tokens:
        partes = token.split(",")
        if len(partes) < 2:
            raise ValueError(f"Coordenada inválida: '{token}'")
        lon, lat = partes[0].strip(), partes[1].strip()
        try:
            lon_f = float(lon)
            lat_f = float(lat)
        except ValueError:
            raise ValueError(f"Coordenada não numérica: '{token}'")
        if not (-180 <= lon_f <= 180) or not (-90 <= lat_f <= 90):
            raise ValueError(f"Coordenada fora do intervalo esperado (lon lat): '{token}'")
        pontos.append(f"{lon},{lat},0")
    return pontos


def gerar_geo_code(grupo, nome, indice):
    """
    Fórmula fixa e não editável do GeoIntegrationCode: Grupo_Nome_número.
    O número (índice do Placemark no arquivo) garante unicidade mesmo quando
    grupo e nome se repetem.
    """
    base = f"{(grupo or '').strip()}_{slug(nome)}_{indice:03d}"
    base = re.sub(r"_+", "_", base).strip("_")
    return base[:MAX_GEO_CODE]


def montar_placemark(placemark, config, indice):
    """
    Processa um <Placemark> e devolve um dict `registro` com os dados já
    validados (ou os erros encontrados). Nunca levanta exceção por erro de
    validação: os problemas são acumulados em registro['erros'] para que o
    chamador (CLI ou UI) decida o que fazer com cada registro.
    """
    erros = []
    avisos = []

    nome = _texto(_find(placemark, "name"))
    descricao_bruta = _texto(_find(placemark, "description"))

    tipo_original, coords_texto = extrair_geometria(placemark)
    if tipo_original is None:
        erros.append("Placemark sem geometria (Polygon, LineString ou Point)")

    # 1) Dados do ExtendedData existente
    dados = extrair_extended_data(placemark)

    # 2) Bloco {{...}} na descrição tem prioridade sobre o ExtendedData (regra do manual)
    bloco, descricao = extrair_bloco_descricao(descricao_bruta)
    dados.update(bloco)
    if bloco.get("Name"):
        nome = bloco["Name"]

    # 3) Preencher campos obrigatórios ausentes com os padrões informados
    if not nome:
        nome = f"Placemark #{indice}"
        erros.append("Campo obrigatório 'Name' não informado")

    if not dados.get("CategoryIntegrationCode"):
        if config.categoria:
            dados["CategoryIntegrationCode"] = config.categoria
        else:
            erros.append("Campo obrigatório 'CategoryIntegrationCode' não informado "
                          "(defina um valor padrão)")

    if not dados.get("GroupIntegrationCode"):
        if config.grupo:
            dados["GroupIntegrationCode"] = config.grupo
        else:
            erros.append("Campo obrigatório 'GroupIntegrationCode' não informado "
                          "(defina um valor padrão)")

    # GeoIntegrationCode nunca vem do KML/edição manual: é sempre a fórmula
    # fixa Grupo_Nome_número, recalculada aqui e não alterável depois.
    codigo_gerado = gerar_geo_code(dados.get("GroupIntegrationCode"), nome, indice)
    if len(f"{dados.get('GroupIntegrationCode', '')}_{slug(nome)}_{indice:03d}") > MAX_GEO_CODE:
        avisos.append(f"GeoIntegrationCode truncado para {MAX_GEO_CODE} caracteres: {codigo_gerado}")
    dados["GeoIntegrationCode"] = codigo_gerado

    # Nomes repetidos no KML de origem (ex.: várias áreas de uma mesma
    # fazenda usando o nome da fazenda) fazem o "Name" parecer duplicado no
    # SSX mesmo sendo áreas distintas. Como o GeoIntegrationCode já é
    # garantidamente único, ele também vira o "Name" exibido, e o nome
    # original fica preservado na descrição.
    nome_original = nome
    nome = codigo_gerado

    # 4) Conversão de geometria (Rotas -> Áreas), se solicitado
    tipo_final = tipo_original
    convertido = False
    if config.forcar_poligono and tipo_original == "LineString":
        tipo_final = "Polygon"
        convertido = True

    if tipo_final == "Point" and not dados.get("Tolerance"):
        if config.tolerancia is not None:
            dados["Tolerance"] = str(config.tolerancia)
        else:
            erros.append("Tolerance é obrigatório para o tipo Ponto "
                          "(defina uma tolerância padrão)")

    if not dados.get("ColorCode") and config.cor:
        dados["ColorCode"] = str(config.cor)

    # 5) Validações de formato e tamanho
    if len(nome) > MAX_NAME:
        erros.append(f"'Name' excede {MAX_NAME} caracteres ({len(nome)})")
    if len(descricao) > MAX_DESCRIPTION:
        avisos.append(f"Descrição excedia {MAX_DESCRIPTION} caracteres "
                       "(provável HTML bruto); substituída pelo nome da área")
        descricao = nome_original
    if len(dados.get("CategoryIntegrationCode", "")) > MAX_CATEGORY_CODE:
        erros.append(f"'CategoryIntegrationCode' excede {MAX_CATEGORY_CODE} caracteres")
    if len(dados.get("GroupIntegrationCode", "")) > MAX_GROUP_CODE:
        erros.append(f"'GroupIntegrationCode' excede {MAX_GROUP_CODE} caracteres")

    if dados.get("Tolerance"):
        try:
            int(dados["Tolerance"])
        except ValueError:
            erros.append(f"'Tolerance' deve ser um número inteiro (metros): "
                          f"'{dados['Tolerance']}'")

    if dados.get("ColorCode"):
        col = dados["ColorCode"].strip()
        if col.isdigit():
            col = str(int(col))
        dados["ColorCode"] = col
        if col not in VALID_COLORS:
            avisos.append(f"ColorCode '{dados['ColorCode']}' fora da tabela (1 a 13); campo removido")
            dados.pop("ColorCode")

    # 6) Coordenadas
    pontos = []
    if tipo_original is not None:
        try:
            pontos = normalizar_coordenadas(coords_texto, tipo_final)
        except ValueError as e:
            erros.append(str(e))

        if tipo_final == "Point" and pontos and len(pontos) != 1:
            erros.append(f"Ponto deve ter exatamente 1 coordenada (encontradas {len(pontos)})")

        if tipo_final == "Polygon" and pontos:
            if pontos[0] != pontos[-1]:
                pontos.append(pontos[0])
                avisos.append("Anel de área fechado automaticamente (ponto inicial repetido no final)")
            distintos = len(set(pontos))
            if distintos < 3:
                erros.append(f"Área deve ter no mínimo 3 pontos (encontrados {distintos})")

        if tipo_final == "LineString" and pontos:
            if len(pontos) < 2:
                erros.append("Rota deve ter no mínimo 2 pontos")
            elif pontos[0] == pontos[-1]:
                avisos.append("Rota já forma um anel fechado (1º ponto = último); "
                              "considere reprocessar como Área")

    coords_final = "\n          ".join(pontos)
    if len(coords_final) > MAX_COORDINATES:
        avisos.append(f"Coordenadas excedem {MAX_COORDINATES} caracteres "
                      f"({len(coords_final)}); o sistema pode rejeitar este registro")

    return {
        "indice": indice,
        "nome": nome,
        "descricao": descricao,
        "tipo_original": tipo_original,
        "tipo_final": tipo_final,
        "convertido": convertido,
        "pontos": pontos,
        "dados": dados,
        "avisos": avisos,
        "erros": erros,
    }


def processar(kml_text, config):
    """
    Parseia o KML (a partir de uma string) e devolve a lista de registros
    processados (válidos e inválidos). Levanta ValueError com mensagem
    amigável em caso de XML inválido ou ausência de Placemarks.
    """
    try:
        root = ET.fromstring(kml_text)
    except ET.ParseError as e:
        raise ValueError(
            f"O arquivo de entrada não é um XML/KML válido: {e}\n"
            "Dica: verifique se caracteres especiais na <description> estão dentro de "
            "<![CDATA[ ]]> (ver manual, pág. 8)."
        )

    placemarks = [el for el in root.iter() if _local(el.tag) == "Placemark"]
    if not placemarks:
        raise ValueError("Nenhum <Placemark> encontrado no arquivo.")

    registros = []
    for i, pm in enumerate(placemarks, start=1):
        registros.append(montar_placemark(pm, config, i))
    return registros


def _montar_xml_placemark(registro):
    dados = registro["dados"]
    nome = registro["nome"]
    descricao = registro["descricao"]
    tipo = registro["tipo_final"]
    coords_final = "\n          ".join(registro["pontos"])

    ordem_dados = ["GeoIntegrationCode", "CategoryIntegrationCode",
                   "GroupIntegrationCode", "Tolerance", "ColorCode"]
    linhas_ext = []
    for campo in ordem_dados:
        if dados.get(campo):
            linhas_ext.append(
                f'      <Data name="{campo}">\n'
                f'        <value>{escape(dados[campo])}</value>\n'
                f'      </Data>'
            )
    ext_xml = "    <ExtendedData>\n" + "\n".join(linhas_ext) + "\n    </ExtendedData>"

    desc_xml = ""
    if descricao:
        # CDATA protege acentos, quebras de linha e caracteres especiais
        desc_xml = f"    <description><![CDATA[{descricao}]]></description>\n"

    if tipo == "Polygon":
        geom_xml = (
            "    <Polygon>\n"
            "      <outerBoundaryIs>\n"
            "        <LinearRing>\n"
            "          <coordinates>\n"
            f"          {coords_final}\n"
            "          </coordinates>\n"
            "        </LinearRing>\n"
            "      </outerBoundaryIs>\n"
            "    </Polygon>"
        )
    elif tipo == "LineString":
        geom_xml = (
            "    <LineString>\n"
            "      <coordinates>\n"
            f"          {coords_final}\n"
            "      </coordinates>\n"
            "    </LineString>"
        )
    else:
        geom_xml = (
            "    <Point>\n"
            "      <coordinates>\n"
            f"          {coords_final}\n"
            "      </coordinates>\n"
            "    </Point>"
        )

    return (
        "  <Placemark>\n"
        f"    <name>{escape(nome)}</name>\n"
        f"{desc_xml}"
        f"{ext_xml}\n"
        f"{geom_xml}\n"
        "  </Placemark>"
    )


def gerar_kml(registros):
    """Gera o texto do .kml de saída (padrão SSX) a partir dos registros válidos."""
    validos = [r for r in registros if not r["erros"]]
    blocos = [_montar_xml_placemark(r) for r in validos]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<kml xmlns="{KML_NS}">\n'
        "<Document>\n"
        + "\n".join(blocos) +
        "\n</Document>\n"
        "</kml>\n"
    )


def _remover_acentos(texto):
    nfkd = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


_TIPO_CSV = {"Polygon": "1", "LineString": "2", "Point": "3"}
_CSV_CABECALHO = ("Nome;Descricao;Tipo;Coordenadas;Tolerancia;"
                   "Cod.integracao;Cod.categoria;Cod.grupo;Cod.cor;")


def gerar_csv(registros):
    """
    Gera o texto do .csv de importação (padrão pág. 2 do manual) a partir dos
    registros válidos: ASCII sem acentos, campos separados por ';', linhas
    terminadas em \\r\\n, coordenadas "lon lat" por ponto separadas por vírgula.
    """
    validos = [r for r in registros if not r["erros"]]
    linhas = [_CSV_CABECALHO]
    for r in validos:
        dados = r["dados"]
        pares = []
        for p in r["pontos"]:
            lon, lat, _ = p.split(",")
            pares.append(f"{lon} {lat}")
        coords = ",".join(pares)
        campos = [
            r["nome"],
            r["descricao"],
            _TIPO_CSV.get(r["tipo_final"], ""),
            coords,
            dados.get("Tolerance", ""),
            dados.get("GeoIntegrationCode", ""),
            dados.get("CategoryIntegrationCode", ""),
            dados.get("GroupIntegrationCode", ""),
            dados.get("ColorCode", ""),
        ]
        campos_seguros = (
            _remover_acentos(c).replace("\r", " ").replace("\n", " ").replace(";", ",")
            for c in campos
        )
        linha = ";".join(campos_seguros) + ";"
        linhas.append(linha)
    return "\r\n".join(linhas) + "\r\n"


# Suporte a cores no terminal (Windows/Linux/macOS)
if sys.platform == "win32":
    try:
        import os
        os.system("")
    except Exception:
        pass


class Cores:
    VERMELHO = "\033[91m"
    VERDE = "\033[92m"
    AMARELO = "\033[93m"
    AZUL = "\033[94m"
    CIANO = "\033[96m"
    NEGRITO = "\033[1m"
    RESET = "\033[0m"


def exibir_relatorio(registros, saida, csv_saida=None, verbose=False):
    """
    Exibe um relatório compacto e altamente visual do resultado da conversão.
    Agrupa avisos repetitivos e destaca visualmente todos os registros com erro.
    """
    total = len(registros)
    com_erro = [r for r in registros if r["erros"]]
    validos = [r for r in registros if not r["erros"]]

    # 1) EXIBIR REGISTROS COM ERRO (DESTAQUE VISUAL EM VERMELHO)
    if com_erro:
        print(f"\n{Cores.NEGRITO}{Cores.VERMELHO}┌──────────────────────────────────────────────────────────────────────────────┐{Cores.RESET}")
        print(f"{Cores.NEGRITO}{Cores.VERMELHO}│ ✖ REGISTROS COM ERRO DE VALIDAÇÃO ({len(com_erro)} REGISTRO(S) IGNORADO(S))          │{Cores.RESET}")
        print(f"{Cores.NEGRITO}{Cores.VERMELHO}└──────────────────────────────────────────────────────────────────────────────┘{Cores.RESET}")

        for r in com_erro:
            print(f"\n  {Cores.NEGRITO}{Cores.VERMELHO}📍 Item #{r['indice']:03d} | Nome: \"{r['nome']}\"{Cores.RESET}")
            for err in r["erros"]:
                print(f"     {Cores.VERMELHO}❌ {err}{Cores.RESET}")
        print(f"\n{Cores.VERMELHO}{'─' * 78}{Cores.RESET}")

    # 2) AGRUPAR E COMPACTAR AVISOS E INFORMATIVOS
    geo_truncado_count = 0
    anel_fechado_count = 0
    coords_longas_count = 0
    outros_avisos = []

    for r in registros:
        for av in r["avisos"]:
            if "GeoIntegrationCode truncado" in av:
                geo_truncado_count += 1
            elif "Anel de área fechado automaticamente" in av:
                anel_fechado_count += 1
            elif "Coordenadas excedem 8000 caracteres" in av:
                coords_longas_count += 1
            else:
                outros_avisos.append((r["nome"], av))

    print(f"\n{Cores.NEGRITO}{Cores.CIANO}ℹ️ INFORMATIVOS E COMPACTAÇÃO DA IMPORTAÇÃO:{Cores.RESET}")
    if geo_truncado_count > 0:
        print(f"   • {Cores.AMARELO}⚠️ {geo_truncado_count} GeoIntegrationCode(s){Cores.RESET} truncados para {MAX_GEO_CODE} caracteres.")
    if anel_fechado_count > 0:
        print(f"   • {Cores.VERDE}✓ {anel_fechado_count} anel(éis) de área{Cores.RESET} fechados automaticamente (ponto final = inicial).")
    if coords_longas_count > 0:
        print(f"   • {Cores.AMARELO}⚠️ {coords_longas_count} registro(s){Cores.RESET} possuem coordenadas longas (> 8000 caracteres).")

    if outros_avisos:
        print(f"\n{Cores.AMARELO}⚠️ OUTROS AVISOS ESPECÍFICOS:{Cores.RESET}")
        for nome_reg, msg in outros_avisos[:10]:
            print(f"   • [{nome_reg}]: {msg}")
        if len(outros_avisos) > 10:
            print(f"   ... e mais {len(outros_avisos) - 10} avisos semelhantes.")

    # 3) RESUMO FINAL TIPO CARD / PAINEL
    contagem = {"Polygon": 0, "LineString": 0, "Point": 0}
    for r in validos:
        contagem[r["tipo_final"]] += 1

    status_str = f"{Cores.VERDE}✔ CONCLUÍDO COM SUCESSO{Cores.RESET}" if not com_erro else f"{Cores.AMARELO}⚠️ CONCLUÍDO COM ALERTAS/ERROS{Cores.RESET}"

    print(f"\n{Cores.NEGRITO}┌──────────────────────────────────────────────────────────────────────────────┐{Cores.RESET}")
    print(f"{Cores.NEGRITO}│                         PAINEL DE IMPORTAÇÃO SSX                             │{Cores.RESET}")
    print(f"{Cores.NEGRITO}├──────────────────────────────────────────────────────────────────────────────┤{Cores.RESET}")
    print(f"│ Status           : {status_str:<62} │")
    print(f"│ Total Lidos      : {total:<57} │")
    print(f"│ Exportados (✔)   : {Cores.VERDE}{len(validos):<4}{Cores.RESET} (Áreas: {contagem['Polygon']} | Rotas: {contagem['LineString']} | Pontos: {contagem['Point']})")
    print(f"│ Ignorados (✖)    : {Cores.VERMELHO if com_erro else Cores.VERDE}{len(com_erro):<57}{Cores.RESET} │")
    print(f"│ Arquivo KML      : {saida:<57} │")
    if csv_saida:
        print(f"│ Arquivo CSV      : {csv_saida:<57} │")
    print(f"{Cores.NEGRITO}└──────────────────────────────────────────────────────────────────────────────┘{Cores.RESET}\n")


def converter(entrada, saida, args, csv_saida=None):
    try:
        with open(entrada, "r", encoding="utf-8") as f:
            kml_text = f.read()
    except OSError as e:
        print(f"{Cores.VERMELHO}ERRO: não foi possível ler '{entrada}': {e}{Cores.RESET}", file=sys.stderr)
        sys.exit(1)

    config = Config(
        categoria=args.categoria,
        grupo=args.grupo,
        tolerancia=args.tolerancia,
        cor=args.cor,
        forcar_poligono=args.forcar_poligono,
    )

    try:
        registros = processar(kml_text, config)
    except ValueError as e:
        print(f"{Cores.VERMELHO}ERRO CRÍTICO NO KML: {e}{Cores.RESET}", file=sys.stderr)
        sys.exit(1)

    validos = [r for r in registros if not r["erros"]]
    if not validos:
        exibir_relatorio(registros, saida, csv_saida=csv_saida)
        print(f"{Cores.VERMELHO}Nenhum registro válido para exportar. Nenhum arquivo foi gerado.{Cores.RESET}", file=sys.stderr)
        sys.exit(1)

    with open(saida, "w", encoding="utf-8") as f:
        f.write(gerar_kml(registros))

    if csv_saida:
        with open(csv_saida, "w", encoding="ascii", errors="ignore", newline="") as f:
            f.write(gerar_csv(registros))

    exibir_relatorio(registros, saida, csv_saida=csv_saida)


def main():
    parser = argparse.ArgumentParser(
        description="Converte um arquivo .kml para o padrão de importação SSX.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("entrada", help="Arquivo .kml de origem")
    parser.add_argument("saida", help="Arquivo .kml de saída (padrão SSX)")
    parser.add_argument("--categoria", default=None,
                        help="CategoryIntegrationCode padrão (pode ser lista: cod1,cod2)")
    parser.add_argument("--grupo", default=None,
                        help="GroupIntegrationCode padrão")
    parser.add_argument("--tolerancia", type=int, default=None,
                        help="Tolerância padrão em metros (obrigatória para pontos sem tolerância)")
    parser.add_argument("--cor", type=int, choices=range(1, 14), default=None,
                        help="Código de cor padrão (1 a 13) para áreas/rotas sem cor definida")
    parser.add_argument("--forcar-poligono", action="store_true",
                        help="Converte geometrias LineString em Polygon (áreas) e fecha anéis abertos automaticamente")
    parser.add_argument("--csv", default=None, metavar="ARQUIVO",
                        help="Também exporta um .csv no padrão de importação (opcional)")
    args = parser.parse_args()

    converter(args.entrada, args.saida, args, csv_saida=args.csv)


if __name__ == "__main__":
    main()
