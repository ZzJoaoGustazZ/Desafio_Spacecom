'use strict';

/**
 * PROCESSAR — processa um dataset inteiro, com uma ou várias threads.
 *
 * Os datasets vêm em ordem de timestamp. Então:
 *  1. o arquivo é cortado em trechos (1 por thread), e cada corte cai
 *     EXATAMENTE numa troca de timestamp: nenhum grupo fica dividido;
 *  2. cada thread lê o seu trecho e, a cada grupo completo, procura os
 *     encontros e descarta os pontos (a memória fica do tamanho de um bloco);
 *  3. os encontros dos trechos são juntados na ordem.
 *
 * Se aparecer um timestamp fora de ordem, o arquivo é processado de novo
 * pelo modo "geral": junta os grupos de cada timestamp na memória e só
 * depois procura os encontros (mais lento, mas funciona em qualquer ordem).
 */

const fs = require('fs');
const { lerTrecho } = require('./leitor');
const { procurarEncontros } = require('./encontros');

/** Modo de fluxo: lê [inicio, fim) e procura os encontros de cada grupo assim que ele termina. */
function processarTrecho(arquivo, inicio, fim) {
  const r = { ordenado: true, primeiro: null, ultimo: null, encontros: [], linhas: 0, timestamps: 0 };
  lerTrecho(arquivo, inicio, fim, (ts, lat, lon, ids, n, pessoas) => {
    if (r.ultimo !== null && !(ts > r.ultimo)) { r.ordenado = false; return false; } // fora de ordem: para
    if (r.primeiro === null) r.primeiro = ts;
    r.ultimo = ts;
    r.linhas += n;
    r.timestamps++;
    procurarEncontros(ts, lat, lon, ids, n, pessoas, r.encontros);
  });
  return r;
}

/** Modo geral (arquivo fora de ordem): junta tudo por timestamp e depois procura. */
function processarForaDeOrdem(arquivo) {
  const grupos = new Map(); // timestamp -> { lat: [], lon: [], ids: [] }
  let pessoasDoArquivo = [];
  let linhas = 0;
  lerTrecho(arquivo, 0, fs.statSync(arquivo).size, (ts, lat, lon, ids, n, pessoas) => {
    pessoasDoArquivo = pessoas;
    if (!grupos.has(ts)) grupos.set(ts, { lat: [], lon: [], ids: [] });
    const g = grupos.get(ts);
    for (let k = 0; k < n; k++) { g.lat.push(lat[k]); g.lon.push(lon[k]); g.ids.push(ids[k]); }
    linhas += n;
  });
  const encontros = [];
  for (const ts of [...grupos.keys()].sort()) { // "AAAA-MM-DD HH:MM:SS" em ordem de texto = ordem de tempo
    const g = grupos.get(ts);
    procurarEncontros(ts, Float64Array.from(g.lat), Float64Array.from(g.lon), Int32Array.from(g.ids),
      g.ids.length, pessoasDoArquivo, encontros);
  }
  return { encontros, linhas, timestamps: grupos.size };
}

/** Timestamp de uma linha de texto (3ª coluna), ou null se a linha não tiver colunas. */
function timestampDaLinha(linha) {
  const colunas = linha.split(';');
  return colunas.length > 2 ? colunas[2] : null;
}

/**
 * A partir da posição pos, acha o início da 1ª linha cujo timestamp é
 * diferente do da linha anterior (= começo de um grupo novo).
 */
function inicioDoProximoGrupo(fd, pos, tamanho) {
  for (let janela = 64 * 1024; ; janela *= 2) {
    const buf = Buffer.alloc(Math.min(janela, tamanho - pos));
    const lidos = fs.readSync(fd, buf, 0, buf.length, pos);
    const linhas = buf.toString('latin1', 0, lidos).split('\n');
    // linhas[0] é o pedaço da linha onde pos caiu; a última pode estar incompleta
    let inicio = pos + linhas[0].length + 1;
    let tsAnterior = null;
    for (let k = 1; k < linhas.length - 1; k++) {
      const ts = timestampDaLinha(linhas[k]);
      if (ts !== null) {
        if (tsAnterior !== null && ts !== tsAnterior) return inicio;
        tsAnterior = ts;
      }
      inicio += linhas[k].length + 1;
    }
    if (pos + lidos >= tamanho) return tamanho; // chegou ao fim do arquivo
  }
}

/** Divide o arquivo em até `partes` trechos [inicio, fim) que começam numa troca de timestamp. */
function cortar(arquivo, tamanho, partes) {
  const fd = fs.openSync(arquivo, 'r');
  const cortes = [0];
  for (let k = 1; k < partes; k++) {
    const c = inicioDoProximoGrupo(fd, Math.floor((tamanho * k) / partes), tamanho);
    if (c > cortes[cortes.length - 1] && c < tamanho) cortes.push(c);
  }
  fs.closeSync(fd);
  cortes.push(tamanho);
  return cortes.slice(0, -1).map((inicio, k) => ({ inicio, fim: cortes[k + 1] }));
}

/** Manda uma tarefa para um worker e espera a resposta. */
function pedir(worker, tarefa) {
  return new Promise((resolve, reject) => {
    worker.once('message', (r) => { worker.off('error', reject); resolve(r); });
    worker.once('error', reject);
    worker.postMessage(tarefa);
  });
}

/** Os trechos estão em ordem, cada um e um depois do outro? */
function emOrdem(trechos) {
  let ultimo = null;
  for (const t of trechos) {
    if (!t.ordenado) return false;
    if (t.primeiro === null) continue; // trecho sem linhas
    if (ultimo !== null && !(t.primeiro > ultimo)) return false;
    ultimo = t.ultimo;
  }
  return true;
}

/**
 * Processa o arquivo e devolve { encontros, linhas, timestamps, modo }.
 * workers: as threads a usar (lista vazia = tudo na thread principal).
 */
async function processarArquivo(arquivo, workers) {
  const tamanho = fs.statSync(arquivo).size;
  let trechos;
  if (workers.length === 0) {
    trechos = [processarTrecho(arquivo, 0, tamanho)];
  } else {
    const partes = cortar(arquivo, tamanho, workers.length);
    trechos = await Promise.all(partes.map((p, k) => pedir(workers[k], { arquivo, inicio: p.inicio, fim: p.fim })));
  }

  if (!emOrdem(trechos)) return { ...processarForaDeOrdem(arquivo), modo: 'geral' };

  return {
    encontros: trechos.flatMap((t) => t.encontros),
    linhas: trechos.reduce((s, t) => s + t.linhas, 0),
    timestamps: trechos.reduce((s, t) => s + t.timestamps, 0),
    modo: 'fluxo',
  };
}

module.exports = { processarArquivo, processarTrecho };
