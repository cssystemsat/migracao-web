// Conversor KML -> SSX (Áreas/Rotas) — componente Angular standalone, autocontido.
//
// Porta a engine de conversorkml.py (projeto migracao-web) para TypeScript, rodando
// 100% no navegador (parse, validação e geração de KML/CSV via DOMParser/Blob — sem
// chamada a nenhum backend). Pensado para ser incorporado num app Angular standalone
// components (ex.: Universidade Systemsat): copie este arquivo, importe o componente
// numa página (`imports: [ConversorKmlSsxComponent]`) e use `<app-conversor-kml-ssx>`
// no template — sem precisar registrar serviço, rota ou módulo adicional.
//
// Depende só de @angular/core, @angular/common e @angular/forms (padrão em qualquer
// projeto Angular >= 14 com standalone components).

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// ---------------------------------------------------------------------------
// Engine de conversão (porte 1:1 de conversorkml.py)
// ---------------------------------------------------------------------------

const MAX_NAME = 150;
const MAX_DESCRIPTION = 500;
const MAX_GEO_CODE = 40;
const MAX_CATEGORY_CODE = 8000;
const MAX_GROUP_CODE = 40;
const MAX_COORDINATES = 8000;
const MAX_LINHAS_IMPORTACAO = 3000; // limite de linhas por importação (manual SSX v1.4, 13/11/2025)
const TAMANHO_PARTE = 1000; // abaixo do limite de importação, pra manter os arquivos leves
const VALID_COLORS = new Set(Array.from({ length: 13 }, (_, i) => String(i + 1)));

const AVISOS_COMPACTAVEIS = [
  'GeoIntegrationCode truncado',
  'Anel de área fechado automaticamente',
  'Coordenadas excedem',
];

// Tabela de cores do manual de importação SSX (pág. 8).
const CORES_SSX = [
  { codigo: 1, hex: '#988383' },
  { codigo: 2, hex: '#D65E5E' },
  { codigo: 3, hex: '#D97B4C' },
  { codigo: 4, hex: '#D66B98' },
  { codigo: 5, hex: '#936BD6' },
  { codigo: 6, hex: '#608CE0' },
  { codigo: 7, hex: '#65D6B7' },
  { codigo: 8, hex: '#9FD96D' },
  { codigo: 9, hex: '#F0B132' },
  { codigo: 10, hex: '#949191' },
  { codigo: 11, hex: '#C2C0C0' },
  { codigo: 12, hex: '#555555' },
  { codigo: 13, hex: '#F6F6F6' },
];

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

interface ConfigConversao {
  categoria?: string;
  grupo?: string;
  tolerancia?: number;
  cor?: number;
  forcarPoligono: boolean;
}

type TipoGeometria = 'Polygon' | 'LineString' | 'Point';

interface Registro {
  indice: number;
  nome: string;
  descricao: string;
  tipoOriginal: TipoGeometria | null;
  tipoFinal: TipoGeometria | null;
  convertido: boolean;
  pontos: string[];
  dados: Record<string, string>;
  avisos: string[];
  erros: string[];
}

function slug(texto: string, maxLen = 20): string {
  const semAcento = (texto || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let limpo = semAcento.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return limpo.slice(0, maxLen) || 'SEM_NOME';
}

function removerAcentos(texto: string): string {
  return (texto || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function escapeXml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textoDe(elem: Element | null): string {
  return elem ? (elem.textContent || '').trim() : '';
}

function findChild(elem: Element, nome: string): Element | null {
  for (const child of Array.from(elem.children)) {
    if (child.localName === nome) return child;
  }
  return null;
}

function findAllChildren(elem: Element, nome: string): Element[] {
  return Array.from(elem.children).filter((c) => c.localName === nome);
}

function findRec(elem: Element, nome: string): Element | null {
  for (const child of Array.from(elem.children)) {
    if (child.localName === nome) return child;
    const achado = findRec(child, nome);
    if (achado) return achado;
  }
  return null;
}

// Extrai o bloco {{Nome|Cat|Grupo|Tolerância|CódÁrea|Cor}} da descrição, se existir.
function extrairBlocoDescricao(descricao: string): [Record<string, string>, string] {
  const blocoRe = /\{\{([\s\S]*?)\}\}/;
  const m = blocoRe.exec(descricao || '');
  if (!m) return [{}, (descricao || '').trim()];

  const partes = m[1].split('|').map((p) => p.trim());
  const campos = ['Name', 'CategoryIntegrationCode', 'GroupIntegrationCode', 'Tolerance', 'GeoIntegrationCode', 'ColorCode'];
  const dados: Record<string, string> = {};
  campos.forEach((campo, i) => {
    if (partes[i]) dados[campo] = partes[i];
  });

  const descricaoLimpa = (descricao || '').replace(/\{\{[\s\S]*?\}\}/g, '').replace(/ +/g, ' ').trim();
  return [dados, descricaoLimpa];
}

function extrairExtendedData(placemark: Element): Record<string, string> {
  const dados: Record<string, string> = {};
  const ext = findChild(placemark, 'ExtendedData');
  if (!ext) return dados;
  for (const data of findAllChildren(ext, 'Data')) {
    const nome = (data.getAttribute('name') || '').trim();
    if (nome) dados[nome] = textoDe(findChild(data, 'value'));
  }
  return dados;
}

function extrairGeometria(placemark: Element): [TipoGeometria | null, string] {
  for (const tipo of ['Polygon', 'LineString', 'Point'] as TipoGeometria[]) {
    const geom = findRec(placemark, tipo);
    if (geom) return [tipo, textoDe(findRec(geom, 'coordinates'))];
  }
  return [null, ''];
}

function normalizarCoordenadas(coordsTexto: string): string[] {
  const tokens = coordsTexto.split(/\s+/).filter(Boolean);
  const pontos: string[] = [];
  for (const token of tokens) {
    const partes = token.split(',');
    if (partes.length < 2) throw new Error(`Coordenada inválida: '${token}'`);
    const lon = partes[0].trim();
    const lat = partes[1].trim();
    if (!NUM_RE.test(lon) || !NUM_RE.test(lat)) throw new Error(`Coordenada não numérica: '${token}'`);
    const lonF = parseFloat(lon);
    const latF = parseFloat(lat);
    if (lonF < -180 || lonF > 180 || latF < -90 || latF > 90) {
      throw new Error(`Coordenada fora do intervalo esperado (lon lat): '${token}'`);
    }
    pontos.push(`${lon},${lat},0`);
  }
  return pontos;
}

// Fórmula fixa e não editável do GeoIntegrationCode: Grupo_Nome_número. O número (índice
// do Placemark no arquivo) garante unicidade mesmo quando grupo e nome se repetem.
function gerarGeoCode(grupo: string | undefined, nome: string, indice: number): string {
  const idx = String(indice).padStart(3, '0');
  const base = `${(grupo || '').trim()}_${slug(nome)}_${idx}`.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return base.slice(0, MAX_GEO_CODE);
}

function montarPlacemark(placemark: Element, config: ConfigConversao, indice: number): Registro {
  const erros: string[] = [];
  const avisos: string[] = [];

  let nome = textoDe(findChild(placemark, 'name'));
  const descricaoBruta = textoDe(findChild(placemark, 'description'));

  const [tipoOriginal, coordsTexto] = extrairGeometria(placemark);
  if (tipoOriginal === null) erros.push('Placemark sem geometria (Polygon, LineString ou Point)');

  const dados = extrairExtendedData(placemark);
  const [bloco, descricaoBase] = extrairBlocoDescricao(descricaoBruta);
  let descricao = descricaoBase;
  Object.assign(dados, bloco);
  if (bloco['Name']) nome = bloco['Name'];

  if (!nome) {
    nome = `Placemark #${indice}`;
    erros.push("Campo obrigatório 'Name' não informado");
  }

  if (!dados['CategoryIntegrationCode']) {
    if (config.categoria) dados['CategoryIntegrationCode'] = config.categoria;
    else erros.push("Campo obrigatório 'CategoryIntegrationCode' não informado (defina um valor padrão)");
  }

  if (!dados['GroupIntegrationCode']) {
    if (config.grupo) dados['GroupIntegrationCode'] = config.grupo;
    else erros.push("Campo obrigatório 'GroupIntegrationCode' não informado (defina um valor padrão)");
  }

  const codigoGerado = gerarGeoCode(dados['GroupIntegrationCode'], nome, indice);
  if (`${dados['GroupIntegrationCode'] || ''}_${slug(nome)}_${String(indice).padStart(3, '0')}`.length > MAX_GEO_CODE) {
    avisos.push(`GeoIntegrationCode truncado para ${MAX_GEO_CODE} caracteres: ${codigoGerado}`);
  }
  dados['GeoIntegrationCode'] = codigoGerado;

  // Nomes repetidos no KML de origem (ex.: várias áreas de uma mesma fazenda usando o nome
  // da fazenda) fazem o "Name" parecer duplicado no SSX mesmo sendo áreas distintas. Como o
  // GeoIntegrationCode já é garantidamente único, ele também vira o "Name" exibido, e o nome
  // original fica preservado na descrição.
  const nomeOriginal = nome;
  nome = codigoGerado;

  let tipoFinal = tipoOriginal;
  let convertido = false;
  if (config.forcarPoligono && tipoOriginal === 'LineString') {
    tipoFinal = 'Polygon';
    convertido = true;
  }

  if (tipoFinal === 'Point' && !dados['Tolerance']) {
    if (config.tolerancia !== undefined && config.tolerancia !== null) dados['Tolerance'] = String(config.tolerancia);
    else erros.push('Tolerance é obrigatório para o tipo Ponto (defina uma tolerância padrão)');
  }

  if (!dados['ColorCode'] && config.cor) dados['ColorCode'] = String(config.cor);

  if (nome.length > MAX_NAME) erros.push(`'Name' excede ${MAX_NAME} caracteres (${nome.length})`);
  if (descricao.length > MAX_DESCRIPTION) {
    avisos.push(`Descrição excedia ${MAX_DESCRIPTION} caracteres (provável HTML bruto); substituída pelo nome da área`);
    descricao = nomeOriginal;
  }
  if ((dados['CategoryIntegrationCode'] || '').length > MAX_CATEGORY_CODE) {
    erros.push(`'CategoryIntegrationCode' excede ${MAX_CATEGORY_CODE} caracteres`);
  }
  if ((dados['GroupIntegrationCode'] || '').length > MAX_GROUP_CODE) {
    erros.push(`'GroupIntegrationCode' excede ${MAX_GROUP_CODE} caracteres`);
  }

  if (dados['Tolerance'] && !/^-?\d+$/.test(dados['Tolerance'].trim())) {
    erros.push(`'Tolerance' deve ser um número inteiro (metros): '${dados['Tolerance']}'`);
  }

  if (dados['ColorCode']) {
    let col = dados['ColorCode'].trim();
    if (/^\d+$/.test(col)) col = String(parseInt(col, 10));
    dados['ColorCode'] = col;
    if (!VALID_COLORS.has(col)) {
      avisos.push(`ColorCode '${dados['ColorCode']}' fora da tabela (1 a 13); campo removido`);
      delete dados['ColorCode'];
    }
  }

  let pontos: string[] = [];
  if (tipoOriginal !== null) {
    try {
      pontos = normalizarCoordenadas(coordsTexto);
    } catch (e) {
      erros.push((e as Error).message);
    }

    if (tipoFinal === 'Point' && pontos.length > 0 && pontos.length !== 1) {
      erros.push(`Ponto deve ter exatamente 1 coordenada (encontradas ${pontos.length})`);
    }

    if (tipoFinal === 'Polygon' && pontos.length > 0) {
      if (pontos[0] !== pontos[pontos.length - 1]) {
        pontos.push(pontos[0]);
        avisos.push('Anel de área fechado automaticamente (ponto inicial repetido no final)');
      }
      const distintos = new Set(pontos).size;
      if (distintos < 3) erros.push(`Área deve ter no mínimo 3 pontos (encontrados ${distintos})`);
    }

    if (tipoFinal === 'LineString' && pontos.length > 0) {
      if (pontos.length < 2) erros.push('Rota deve ter no mínimo 2 pontos');
      else if (pontos[0] === pontos[pontos.length - 1]) {
        avisos.push('Rota já forma um anel fechado (1º ponto = último); considere reprocessar como Área');
      }
    }
  }

  const coordsFinal = pontos.join('\n          ');
  if (coordsFinal.length > MAX_COORDINATES) {
    avisos.push(`Coordenadas excedem ${MAX_COORDINATES} caracteres (${coordsFinal.length}); o sistema pode rejeitar este registro`);
  }

  return { indice, nome, descricao, tipoOriginal, tipoFinal, convertido, pontos, dados, avisos, erros };
}

function processar(kmlText: string, config: ConfigConversao): Registro[] {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(
      'O arquivo de entrada não é um XML/KML válido. Dica: verifique se caracteres especiais na ' +
      '<description> estão dentro de <![CDATA[ ]]> (ver manual, pág. 8).'
    );
  }

  const root = doc.documentElement;
  const placemarks: Element[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === 'Placemark') placemarks.push(child);
      walk(child);
    }
  };
  if (root) walk(root);

  if (placemarks.length === 0) throw new Error('Nenhum <Placemark> encontrado no arquivo.');
  return placemarks.map((pm, i) => montarPlacemark(pm, config, i + 1));
}

function montarXmlPlacemark(registro: Registro): string {
  const { dados, nome, descricao, tipoFinal, pontos } = registro;
  const coordsFinal = pontos.join('\n          ');

  const ordemDados = ['GeoIntegrationCode', 'CategoryIntegrationCode', 'GroupIntegrationCode', 'Tolerance', 'ColorCode'];
  const linhasExt = ordemDados
    .filter((campo) => dados[campo])
    .map((campo) => `      <Data name="${campo}">\n        <value>${escapeXml(dados[campo])}</value>\n      </Data>`);
  const extXml = `    <ExtendedData>\n${linhasExt.join('\n')}\n    </ExtendedData>`;

  const descXml = descricao ? `    <description><![CDATA[${descricao}]]></description>\n` : '';

  let geomXml: string;
  if (tipoFinal === 'Polygon') {
    geomXml =
      '    <Polygon>\n      <outerBoundaryIs>\n        <LinearRing>\n          <coordinates>\n' +
      `          ${coordsFinal}\n` +
      '          </coordinates>\n        </LinearRing>\n      </outerBoundaryIs>\n    </Polygon>';
  } else if (tipoFinal === 'LineString') {
    geomXml = `    <LineString>\n      <coordinates>\n          ${coordsFinal}\n      </coordinates>\n    </LineString>`;
  } else {
    geomXml = `    <Point>\n      <coordinates>\n          ${coordsFinal}\n      </coordinates>\n    </Point>`;
  }

  return `  <Placemark>\n    <name>${escapeXml(nome)}</name>\n${descXml}${extXml}\n${geomXml}\n  </Placemark>`;
}

function gerarKml(registros: Registro[]): string {
  const validos = registros.filter((r) => r.erros.length === 0);
  const blocos = validos.map(montarXmlPlacemark);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n' +
    blocos.join('\n') +
    '\n</Document>\n</kml>\n'
  );
}

const TIPO_CSV: Record<string, string> = { Polygon: '1', LineString: '2', Point: '3' };
const CSV_CABECALHO = 'Nome;Descricao;Tipo;Coordenadas;Tolerancia;Cod.integracao;Cod.categoria;Cod.grupo;Cod.cor;';

function gerarCsv(registros: Registro[]): string {
  const validos = registros.filter((r) => r.erros.length === 0);
  const linhas = [CSV_CABECALHO];
  for (const r of validos) {
    const pares = r.pontos.map((p) => {
      const [lon, lat] = p.split(',');
      return `${lon} ${lat}`;
    });
    const coords = pares.join(',');
    const campos = [
      r.nome,
      r.descricao,
      TIPO_CSV[r.tipoFinal || ''] || '',
      coords,
      r.dados['Tolerance'] || '',
      r.dados['GeoIntegrationCode'] || '',
      r.dados['CategoryIntegrationCode'] || '',
      r.dados['GroupIntegrationCode'] || '',
      r.dados['ColorCode'] || '',
    ];
    const camposSeguros = campos.map((c) => removerAcentos(c).replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/;/g, ','));
    linhas.push(camposSeguros.join(';') + ';');
  }
  return linhas.join('\r\n') + '\r\n';
}

function baixarArquivo(nomeArquivo: string, conteudo: string, mimetype: string): void {
  const blob = new Blob([conteudo], { type: mimetype });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

interface ProblematicoRow {
  indice: number;
  nome: string;
  tipoOriginal: TipoGeometria | null;
  convertido: boolean;
  codigo: string;
  erros: string[];
  avisos: string[];
}

interface ResultadoConversao {
  registros: Registro[];
  nOk: number;
  nErro: number;
  nPartes: number;
  avisosCompactados: { geoTruncado: number; anelFechado: number; coordenadasLongas: number };
  problematicos: ProblematicoRow[];
  problematicosOcultos: number;
}

const LIMITE_PROBLEMATICOS = 500;

@Component({
  selector: 'app-conversor-kml-ssx',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="conversor-kml-card">
      <h2>Conversor KML → SSX</h2>
      <p class="descricao">
        Converte um .kml qualquer (Google My Maps, Google Earth etc.) para o padrão de
        importação de Áreas/Rotas do SSX, com validação das regras do manual.
      </p>

      <div class="passo">
        <span class="passo-num">1</span>
        <label for="conversor-arquivo" class="file-label">Carregar KML</label>
        <input id="conversor-arquivo" type="file" accept=".kml" (change)="onArquivoSelecionado($event)" />
        <span class="arquivo-nome">{{ arquivoNome }}</span>
      </div>

      <div class="passo">
        <span class="passo-num">2</span>
        <span>O que este KML representa? (valores padrão para campos ausentes)</span>
      </div>

      <div class="grid-campos">
        <label class="campo">
          <span>Tipo</span>
          <select [(ngModel)]="tipo">
            <option value="areas">Áreas</option>
            <option value="rotas">Rotas</option>
          </select>
        </label>
        <label class="campo">
          <span>Categoria padrão</span>
          <input type="text" [(ngModel)]="categoria" />
        </label>
        <label class="campo">
          <span>Grupo padrão</span>
          <input type="text" [(ngModel)]="grupo" />
        </label>
        <label class="campo">
          <span>Tolerância padrão (m, só p/ Pontos)</span>
          <input type="number" min="0" [(ngModel)]="tolerancia" />
        </label>
      </div>

      <div class="campo cor-campo">
        <span>Cor padrão da área/rota (opcional — tabela do manual SSX)</span>
        <div class="cores">
          <button
            type="button"
            class="cor-swatch-nenhuma"
            [class.selecionada]="corSelecionada === null"
            title="Não escolher cor: o SSX grava com a cor padrão (código 1)"
            (click)="corSelecionada = null"
          >
            Padrão (1)
          </button>
          <button
            *ngFor="let c of cores"
            type="button"
            class="cor-swatch"
            [class.selecionada]="corSelecionada === c.codigo"
            [style.background]="c.hex"
            [title]="'Código ' + c.codigo + ' (' + c.hex + ')'"
            (click)="corSelecionada = c.codigo"
          >
            {{ c.codigo }}
          </button>
        </div>
      </div>

      <button type="button" class="btn-primary" [disabled]="!arquivo || convertendo" (click)="converter()">
        {{ convertendo ? 'Convertendo...' : 'Converter arquivo' }}
      </button>

      <p class="erro" *ngIf="erroGeral">Erro: {{ erroGeral }}</p>

      <div class="resultado" *ngIf="resultado as r">
        <div class="tiles">
          <div class="tile">
            <div class="tile-valor">{{ r.nOk }}</div>
            <div class="tile-label">Prontos</div>
          </div>
          <div class="tile">
            <div class="tile-valor">{{ r.nErro }}</div>
            <div class="tile-label">Com erro</div>
          </div>
        </div>

        <p class="legenda">{{ r.nOk }} de {{ r.registros.length }} registro(s) prontos para importar.</p>

        <p class="aviso" *ngIf="r.nOk > tamanhoParte">
          O SSX importa no máximo {{ maxLinhasImportacao }} linhas por arquivo. Os {{ r.nOk }} registros prontos
          foram divididos em {{ r.nPartes }} arquivo(s) de até {{ tamanhoParte }} cada — importe um de cada vez.
        </p>

        <div class="downloads" *ngIf="r.nOk > 0">
          <ng-container *ngFor="let parte of partesArray(r.nPartes)">
            <button type="button" class="btn-secondary" (click)="baixar(parte, 'kml')">
              Baixar KML{{ r.nPartes > 1 ? ' (parte ' + parte + '/' + r.nPartes + ')' : '' }}
            </button>
            <button type="button" class="btn-secondary" (click)="baixar(parte, 'csv')">
              Baixar CSV{{ r.nPartes > 1 ? ' (parte ' + parte + '/' + r.nPartes + ')' : '' }}
            </button>
          </ng-container>
        </div>

        <p class="info-avisos" *ngIf="textoAvisosCompactados(r) as texto">Informativos: {{ texto }}.</p>

        <ng-container *ngIf="r.problematicos.length > 0">
          <h4>Registros com erro/aviso ({{ r.problematicos.length }})</h4>
          <table class="tabela-saida">
            <thead>
              <tr><th></th><th>Registro</th><th>Código</th><th>Mensagens</th></tr>
            </thead>
            <tbody>
              <tr *ngFor="let p of r.problematicos">
                <td>{{ p.erros.length ? '🔴' : '🟢' }}</td>
                <td>
                  <div>#{{ p.indice }} · {{ p.nome }}</div>
                  <div class="tipo-registro">{{ (p.tipoOriginal || 'sem geometria') + (p.convertido ? ' → Área' : '') }}</div>
                </td>
                <td>{{ p.codigo }}</td>
                <td class="mensagens">{{ mensagensDe(p) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="legenda" *ngIf="r.problematicosOcultos > 0">
            ... e mais {{ r.problematicosOcultos }} registro(s) com erro/aviso não exibido(s) aqui (os arquivos
            gerados já refletem todos).
          </p>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    :host {
      --azul: #1d4ed8;
      --vermelho: #b91c1c;
      --verde-escuro: #166534;
      --amarelo: #a16207;
      --cinza-100: #f4f5f7;
      --cinza-200: #e5e7eb;
      --cinza-300: #d1d5db;
      --cinza-500: #6b7280;
      --cinza-700: #374151;
      --cinza-900: #111827;
      --branco: #ffffff;
      --radius: 8px;
      display: block;
      font-family: "Segoe UI", Arial, sans-serif;
    }

    .conversor-kml-card {
      max-width: 760px;
      margin: 0 auto;
      background: var(--branco);
      border: 1px solid var(--cinza-200);
      border-radius: 12px;
      padding: 28px 32px;
      color: var(--cinza-900);
    }

    h2 { margin: 0 0 6px; color: #1a2a5e; }
    .descricao { color: var(--cinza-500); margin: 0 0 20px; line-height: 1.4; }

    .passo { display: flex; align-items: center; gap: 10px; margin: 18px 0 10px; font-weight: 600; }
    .passo-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--azul); color: var(--branco); font-size: 0.8rem; flex-shrink: 0;
    }
    .file-label {
      display: inline-block; padding: 8px 14px; border-radius: var(--radius);
      background: var(--cinza-100); border: 1px solid var(--cinza-300); cursor: pointer; font-weight: 600;
    }
    input[type="file"] { display: none; }
    .arquivo-nome { color: var(--cinza-500); font-size: 0.9rem; }

    .grid-campos { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 8px; }
    .campo { display: flex; flex-direction: column; gap: 6px; font-weight: 600; font-size: 0.9rem; }
    .campo input, .campo select {
      padding: 10px 12px; font-size: 0.95rem; border-radius: var(--radius);
      border: 1px solid var(--cinza-300); background: #fbfcff; outline: none; font-weight: 400;
    }
    .campo input:focus, .campo select:focus { border-color: var(--azul); box-shadow: 0 0 0 4px rgba(29,78,216,0.08); }

    .cor-campo { margin: 10px 0 20px; }
    .cores { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .cor-swatch {
      width: 30px; height: 30px; padding: 0; border-radius: 50%;
      border: 2px solid var(--cinza-300); font-size: 0.7rem; font-weight: 700;
      color: rgba(0,0,0,0.35); text-shadow: 0 1px 1px rgba(255,255,255,0.4); cursor: pointer;
    }
    .cor-swatch:hover { border-color: var(--cinza-500); }
    .cor-swatch.selecionada { border-color: var(--azul); box-shadow: 0 0 0 2px var(--branco) inset, 0 0 0 3px var(--azul); }
    .cor-swatch-nenhuma {
      border-radius: var(--radius); height: 30px; padding: 0 10px;
      background: var(--cinza-100); color: var(--cinza-700); font-size: 0.8rem; font-weight: 500;
      border: 2px solid var(--cinza-300); cursor: pointer;
    }
    .cor-swatch-nenhuma.selecionada { border-color: var(--azul); box-shadow: none; background: #dbeafe; }

    .btn-primary, .btn-secondary {
      padding: 10px 18px; border-radius: var(--radius); border: none; cursor: pointer; font-weight: 600;
    }
    .btn-primary { background: var(--azul); color: var(--branco); }
    .btn-primary:disabled { background: var(--cinza-300); cursor: not-allowed; }
    .btn-secondary { background: var(--cinza-100); color: var(--cinza-900); border: 1px solid var(--cinza-300); }

    .erro { color: var(--vermelho); font-weight: 600; }

    .resultado { margin-top: 20px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; margin-bottom: 16px; }
    .tile { background: var(--cinza-100); border: 1px solid var(--cinza-200); border-radius: var(--radius); padding: 14px 16px; }
    .tile-valor { font-size: 1.8rem; font-weight: 700; }
    .tile-label { font-size: 0.8rem; color: var(--cinza-500); margin-top: 4px; }

    .legenda { color: var(--cinza-500); }
    .aviso { color: var(--amarelo); }
    .downloads { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    .info-avisos { color: var(--cinza-500); }

    table.tabela-saida { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 8px; }
    table.tabela-saida th, table.tabela-saida td {
      text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--cinza-200); border-right: 1px solid var(--cinza-200);
    }
    table.tabela-saida th:last-child, table.tabela-saida td:last-child { border-right: none; }
    table.tabela-saida th { background: var(--cinza-100); }
    .tipo-registro { color: var(--cinza-500); font-size: 0.8rem; margin-top: 2px; }
    .mensagens { white-space: pre-wrap; }
  `],
})
export class ConversorKmlSsxComponent {
  arquivo: File | null = null;
  arquivoNome = 'Nenhum arquivo selecionado';
  nomeBase = 'conversao';

  tipo: 'areas' | 'rotas' = 'areas';
  categoria = '';
  grupo = '';
  tolerancia: number | null = null;
  corSelecionada: number | null = null;
  cores = CORES_SSX;

  convertendo = false;
  erroGeral = '';
  resultado: ResultadoConversao | null = null;

  readonly tamanhoParte = TAMANHO_PARTE;
  readonly maxLinhasImportacao = MAX_LINHAS_IMPORTACAO;

  private kmlTextoAtual = '';

  onArquivoSelecionado(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.arquivo = file;
    this.arquivoNome = file ? file.name : 'Nenhum arquivo selecionado';
    this.nomeBase = file ? file.name.replace(/\.kml$/i, '') : 'conversao';
    this.resultado = null;
    this.erroGeral = '';
  }

  partesArray(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  async converter(): Promise<void> {
    if (!this.arquivo) return;
    this.convertendo = true;
    this.erroGeral = '';
    this.resultado = null;

    try {
      const kmlText = await this.arquivo.text();
      this.kmlTextoAtual = kmlText;

      const config: ConfigConversao = {
        categoria: this.categoria.trim() || undefined,
        grupo: this.grupo.trim() || undefined,
        tolerancia: this.tolerancia ?? undefined,
        cor: this.corSelecionada ?? undefined,
        forcarPoligono: this.tipo === 'areas',
      };

      const registros = processar(kmlText, config);
      this.resultado = this.montarResultado(registros);
    } catch (e) {
      this.erroGeral = (e as Error).message || String(e);
    } finally {
      this.convertendo = false;
    }
  }

  private montarResultado(registros: Registro[]): ResultadoConversao {
    const nErro = registros.filter((r) => r.erros.length > 0).length;
    const nOk = registros.length - nErro;
    const nPartes = nOk > TAMANHO_PARTE ? Math.ceil(nOk / TAMANHO_PARTE) : 1;

    const avisosCompactados = { geoTruncado: 0, anelFechado: 0, coordenadasLongas: 0 };
    const problematicos: ProblematicoRow[] = [];

    for (const r of registros) {
      if (r.erros.length === 0 && r.avisos.length === 0) continue;
      const soCompactaveis = r.erros.length === 0 && r.avisos.every((av) => AVISOS_COMPACTAVEIS.some((chave) => av.includes(chave)));
      if (soCompactaveis) {
        for (const av of r.avisos) {
          if (av.includes('GeoIntegrationCode truncado')) avisosCompactados.geoTruncado++;
          else if (av.includes('Anel de área fechado automaticamente')) avisosCompactados.anelFechado++;
          else if (av.includes('Coordenadas excedem')) avisosCompactados.coordenadasLongas++;
        }
        continue;
      }
      problematicos.push({
        indice: r.indice,
        nome: r.nome,
        tipoOriginal: r.tipoOriginal,
        convertido: r.convertido,
        codigo: r.dados['GeoIntegrationCode'] || '',
        erros: r.erros,
        avisos: r.avisos,
      });
    }

    const problematicosOcultos = Math.max(0, problematicos.length - LIMITE_PROBLEMATICOS);

    return {
      registros,
      nOk,
      nErro,
      nPartes,
      avisosCompactados,
      problematicos: problematicos.slice(0, LIMITE_PROBLEMATICOS),
      problematicosOcultos,
    };
  }

  textoAvisosCompactados(r: ResultadoConversao): string | null {
    const ac = r.avisosCompactados;
    const partes = [
      ac.anelFechado ? `${ac.anelFechado} anel(éis) de área fechados automaticamente` : null,
      ac.geoTruncado ? `${ac.geoTruncado} GeoIntegrationCode(s) truncados` : null,
      ac.coordenadasLongas ? `${ac.coordenadasLongas} registro(s) com coordenadas longas` : null,
    ].filter((s): s is string => !!s);
    return partes.length > 0 ? partes.join(' · ') : null;
  }

  mensagensDe(p: ProblematicoRow): string {
    return [...p.erros.map((m) => `⛔ ${m}`), ...p.avisos.map((m) => `⚠️ ${m}`)].join('\n');
  }

  baixar(parte: number, formato: 'kml' | 'csv'): void {
    if (!this.resultado) return;
    const validos = this.resultado.registros.filter((r) => r.erros.length === 0);
    const inicio = (parte - 1) * TAMANHO_PARTE;
    const fatia = validos.slice(inicio, inicio + TAMANHO_PARTE);
    if (fatia.length === 0) return;

    const sufixoParte = this.resultado.nPartes > 1 ? `_parte${parte}` : '';

    if (formato === 'kml') {
      baixarArquivo(`${this.nomeBase}_SSX_${this.tipo}${sufixoParte}.kml`, gerarKml(fatia), 'application/vnd.google-earth.kml+xml');
    } else {
      baixarArquivo(`${this.nomeBase}_SSX_${this.tipo}${sufixoParte}.csv`, gerarCsv(fatia), 'text/csv');
    }
  }
}
