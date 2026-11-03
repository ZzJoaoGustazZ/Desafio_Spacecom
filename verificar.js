'use strict';

/**
 * npm run verificar — VERIFICADOR INDEPENDENTE (força bruta).
 *
 * Confere output/respostasN.json sem usar nada do código otimizado:
 *  - lê o dataset linha a linha, do jeito mais simples possível;
 *  - em cada timestamp compara TODOS os pares de pessoas (Haversine do enunciado);
 *  - compara encontro por encontro: falta, sobra, tipo e distância exata;
 *  - se existir o gabarito oficial (data/respostasN.json), compara com ele também.
 *
 * Uso: npm run verificar        (todos os datasets)
 *      node verificar.js 7      (só o dataset 7)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const R = 6371000;
const LIMITE = 20;

function haversine(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function tipoDoEncontro(a, b) {
  if (a.agressores.includes(b.id) || b.agressores.includes(a.id)) return 'protetiva';
  if (a.faccao !== '' && a.faccao === b.faccao) return 'faccao';
  return 'generico';
}

const tirarAspas = (s) => s.replace(/"/g, '').trim();

/** Chave única de um encontro: "timestamp|idMenor|idMaior". */
function chave(ts, id1, id2) {
  const [x, y] = [Number(id1), Number(id2)].sort((p, q) => p - q);
  return `${ts}|${x}|${y}`;
}

/** Força bruta: Map chave -> { tipo, distanciaMetros }. */
async function esperado(arquivo) {
  const encontros = new Map();
  const vistos = new Set(); // timestamps já processados (para perceber arquivo fora de ordem)
  let ts = null;
  let grupo = [];
  let linhas = 0;
  let foraDeOrdem = false;

  function processarGrupo() {
    for (let i = 0; i < grupo.length; i++) {
      for (let j = i + 1; j < grupo.length; j++) {
        const a = grupo[i], b = grupo[j];
        const d = haversine(a.lat, a.lon, b.lat, b.lon);
        if (d < LIMITE) encontros.set(chave(ts, a.id, b.id), { tipo: tipoDoEncontro(a, b), distanciaMetros: d });
      }
    }
  }

  const rl = readline.createInterface({ input: fs.createReadStream(arquivo), crlfDelay: Infinity });
  for await (const linha of rl) {
    const c = linha.split(';');
    const lat = parseFloat(c[3]), lon = parseFloat(c[4]);
    if (c.length < 5 || Number.isNaN(lat) || Number.isNaN(lon)) continue; // cabeçalho ou linha vazia
    const t = tirarAspas(c[2]);
    if (t !== ts) { // timestamp novo: o grupo anterior acabou
      if (ts !== null) processarGrupo();
      if (vistos.has(t)) foraDeOrdem = true;
      vistos.add(t);
      ts = t;
      grupo = [];
    }
    const id = Number(tirarAspas(c[0]));
    if (grupo.some((p) => p.id === id)) continue; // mesma pessoa 2x no mesmo timestamp: vale a 1ª
    const agressores = (c[6] || '').replace(/[\[\]"'\s]/g, '').split(',').filter(Boolean).map(Number);
    grupo.push({ id, faccao: tirarAspas(c[1]), lat, lon, agressores });
    linhas++;
  }
  if (ts !== null) processarGrupo();
  if (foraDeOrdem) console.log('  AVISO: dataset fora de ordem — este verificador assume timestamps agrupados.');
  return { encontros, linhas };
}

/** Compara a saída com uma referência (Map chave -> {tipo, distanciaMetros}). Devolve a lista de problemas. */
function comparar(saida, referencia, prefixo) {
  const problemas = [];
  const vistas = new Set();
  for (const e of saida) {
    const k = chave(e.timestamp, ...e.monitoradosEncontro);
    const ref = referencia.get(k);
    if (vistas.has(k)) problemas.push(`${prefixo}DUPLICADO ${k}`);
    else if (!ref) problemas.push(`${prefixo}FALSO POSITIVO ${k} (${e.tipo}, ${e.distanciaMetros} m)`);
    else if (ref.tipo !== e.tipo) problemas.push(`${prefixo}TIPO ERRADO ${k}: saída=${e.tipo} esperado=${ref.tipo}`);
    else if (ref.distanciaMetros !== e.distanciaMetros) problemas.push(`${prefixo}DISTÂNCIA ${k}: saída=${e.distanciaMetros} esperado=${ref.distanciaMetros}`);
    vistas.add(k);
  }
  for (const [k, ref] of referencia) if (!vistas.has(k)) problemas.push(`${prefixo}FALTANDO ${k} (${ref.tipo}, ${ref.distanciaMetros} m)`);
  return problemas;
}

async function conferir(n) {
  const dataset = path.join('data', `dataset${n}.txt`);
  const resposta = path.join('output', `respostas${n}.json`);
  const gabarito = path.join('data', `respostas${n}.json`);
  if (!fs.existsSync(dataset) || !fs.existsSync(resposta)) { console.log(`dataset${n}: arquivo não encontrado, pulando`); return true; }

  const t0 = Date.now();
  const { encontros, linhas } = await esperado(dataset);
  const saida = JSON.parse(fs.readFileSync(resposta, 'utf8'));
  const problemas = comparar(saida, encontros, '');
  const corretos = saida.length - problemas.filter((p) => !p.startsWith('FALTANDO')).length;

  let linhaGabarito = '';
  if (fs.existsSync(gabarito)) {
    const oficial = new Map(JSON.parse(fs.readFileSync(gabarito, 'utf8')).map((e) => [chave(e.timestamp, ...e.monitoradosEncontro), e]));
    const doGabarito = comparar(saida, oficial, 'GABARITO: ');
    problemas.push(...doGabarito);
    linhaGabarito = `\n          gabarito oficial: ${oficial.size} encontros -> ${doGabarito.length === 0 ? 'OK, igual ao gabarito' : 'DIVERGE'}`;
  }

  const ok = problemas.length === 0;
  console.log(
    `dataset${n}: ${linhas} linhas, esperado ${encontros.size} encontros, saída ${saida.length}, corretos ${corretos} ` +
    `-> ${ok ? 'OK, tudo confere' : problemas.length + ' PROBLEMA(S)'} (${((Date.now() - t0) / 1000).toFixed(1)} s)` + linhaGabarito
  );
  problemas.slice(0, 10).forEach((p) => console.log('   ' + p));
  return ok;
}

(async () => {
  const pedidos = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
  const numeros = pedidos.length ? pedidos : fs.readdirSync('data')
    .map((f) => (f.match(/^dataset(\d+)\.txt$/) || [])[1]).filter(Boolean)
    .sort((a, b) => a - b);
  let tudoOk = true;
  for (const n of numeros) tudoOk = (await conferir(n)) && tudoOk;
  console.log(tudoOk
    ? '\nRESULTADO: todas as saídas conferem com a força bruta (e com os gabaritos oficiais disponíveis).'
    : '\nRESULTADO: há divergências (veja acima).');
  process.exit(tudoOk ? 0 : 1);
})();
