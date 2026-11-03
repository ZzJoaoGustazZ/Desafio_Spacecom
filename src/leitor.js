'use strict';

/**
 * LEITOR — lê o trecho [inicio, fim) do arquivo e entrega os pontos AGRUPADOS
 * por timestamp: cada vez que o timestamp muda, chama
 *
 *     aoGrupo(ts, lat, lon, ids, n, pessoas)
 *
 * com os n pontos do grupo que acabou (lat[k], lon[k], ids[k] para k < n).
 * Se aoGrupo devolver false, a leitura para.
 *
 * Por que é rápido:
 *  - lê blocos de 8 MB direto para um Buffer e interpreta os BYTES, sem criar
 *    uma string por linha (são milhões de linhas);
 *  - o timestamp quase sempre é igual ao da linha anterior: compara os bytes
 *    e pronto, sem converter nada;
 *  - facção e agressores de uma pessoa só são lidos na 1ª vez que ela aparece.
 *
 * O trecho deve começar no início de uma linha (o processar.js garante isso).
 */

const fs = require('fs');

// Tamanho do bloco de leitura: 8 MB (o calibrar.js testa outros valores pela variável BLOCO_MB)
const tamanhoDoBloco = () => Math.max(1, +process.env.BLOCO_MB || 8) * 1024 * 1024;

// códigos dos caracteres (bytes) que importam
const PONTO_VIRGULA = 59; // ';'
const QUEBRA = 10;        // '\n'
const RETORNO = 13;       // '\r' (fim de linha do Windows: \r\n)
const MENOS = 45;         // '-'
const PONTO = 46;         // '.'
const ZERO = 48;          // '0' (os dígitos vão de 48 a 57)
const NOVE = 57;          // '9'

// 10^0 ... 10^22: todas exatas em double
const POT10 = Array.from({ length: 23 }, (_, k) => Number('1e' + k));

/** Posição onde o campo que começa em i termina (no ';', no fim da linha ou em lim). */
function fimDoCampo(buf, i, lim) {
  while (i < lim) {
    const c = buf[i];
    if (c === PONTO_VIRGULA || c === QUEBRA || c === RETORNO) return i;
    i++;
  }
  return lim;
}

/** O campo terminou num ';' (e não no fim da linha)? */
function terminaEmPontoVirgula(buf, f, lim) {
  return f < lim && buf[f] === PONTO_VIRGULA;
}

/** Posição logo depois do '\n' da linha atual (início da próxima linha). */
function proximaLinha(buf, i, lim) {
  while (i < lim && buf[i] !== QUEBRA) i++;
  return i + 1;
}

/** id: só os dígitos do campo ("12" -> 12). */
function lerInteiro(buf, ini, fim) {
  let n = 0;
  for (let i = ini; i < fim; i++) if (buf[i] >= ZERO && buf[i] <= NOVE) n = n * 10 + (buf[i] - ZERO);
  return n;
}

/**
 * Número decimal EXATO: "-33.70848" vira o inteiro 3370848 e 5 casas decimais,
 * e o resultado é -(3370848 / 10^5). Com até 15 dígitos essa divisão dá
 * exatamente o mesmo double que parseFloat (a divisão IEEE é arredondada
 * corretamente), só que sem criar string. Formato estranho -> parseFloat.
 */
function lerNumero(buf, ini, fim) {
  let i = ini, negativo = false, m = 0, casas = 0, digitos = 0, ponto = false;
  if (buf[i] === MENOS) { negativo = true; i++; }
  for (; i < fim; i++) {
    const c = buf[i];
    if (c >= ZERO && c <= NOVE) { m = m * 10 + (c - ZERO); digitos++; if (ponto) casas++; }
    else if (c === PONTO && !ponto) ponto = true;
    else return parseFloat(buf.toString('latin1', ini, fim).replace(/"/g, '')); // aspas, vírgula, texto...
  }
  if (digitos === 0 || digitos > 15) return parseFloat(buf.toString('latin1', ini, fim));
  const v = m / POT10[casas];
  return negativo ? -v : v;
}

/** O timestamp que começa em i tem exatamente os mesmos bytes do anterior? */
function mesmoTimestamp(buf, i, lim, ts, tamanho) {
  if (tamanho === 0 || i + tamanho >= lim || buf[i + tamanho] !== PONTO_VIRGULA) return false;
  for (let k = tamanho - 1; k >= 0; k--) if (buf[i + k] !== ts[k]) return false; // de trás p/ frente: os segundos mudam primeiro
  return true;
}

/** Texto de um campo sem aspas e sem espaços nas pontas. */
function texto(buf, ini, fim) {
  return buf.toString('utf8', ini, fim).replace(/"/g, '').trim();
}

/** Dados de uma pessoa, lidos da 1ª linha em que ela aparece. */
function lerPessoa(id, faccao, resto) {
  // resto = "medidaProtetiva;idsRestricaoMedida", ex.: "true;9" ou "false;"
  const lista = resto.split(';')[1] || '';
  const agressores = lista.replace(/[\[\]"'\s]/g, '').split(',').filter(Boolean).map(Number);
  return { id, faccao, agressores, visto: 0 }; // visto: usado pelo encontros.js para ignorar pessoa repetida
}

/** Array tipado com o dobro do tamanho e o mesmo conteúdo. */
function dobrar(a) {
  const b = new a.constructor(a.length * 2);
  b.set(a);
  return b;
}

function lerTrecho(arquivo, inicio, fim, aoGrupo) {
  const pessoas = [];                 // pessoas[id] = { id, faccao, agressores, visto }
  let lat = new Float64Array(256);    // pontos do grupo atual
  let lon = new Float64Array(256);
  let ids = new Int32Array(256);
  let n = 0;                          // quantos pontos o grupo atual tem
  let ts = null;                      // timestamp do grupo atual (texto, sem aspas)
  let tsBytes = Buffer.alloc(64);     // o mesmo timestamp em bytes, para comparar rápido
  let tsTamanho = 0;
  let parar = false;

  // entrega o grupo atual e começa um vazio
  function fecharGrupo() {
    if (n > 0 && aoGrupo(ts, lat, lon, ids, n, pessoas) === false) parar = true;
    n = 0;
  }

  const fd = fs.openSync(arquivo, 'r');
  let buf = Buffer.allocUnsafe(tamanhoDoBloco());
  let sobra = 0;      // bytes de uma linha incompleta, guardados no começo do buf
  let pos = inicio;   // próxima posição a ler do arquivo
  try {
    while (!parar) {
      // 1) lê o próximo bloco, depois da sobra do bloco anterior
      const lidos = fs.readSync(fd, buf, sobra, Math.min(buf.length - sobra, fim - pos), pos);
      pos += lidos;
      const tam = sobra + lidos;                // bytes válidos no buf
      const ultimo = pos >= fim || lidos === 0; // é o último bloco do trecho?

      // 2) só linhas completas: até o último '\n' (no último bloco, tudo)
      const lim = ultimo ? tam : buf.lastIndexOf(QUEBRA, tam - 1) + 1;
      if (lim === 0 && !ultimo) { // nenhuma linha completa (linha maior que o bloco): dobra o bloco
        const maior = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(maior, 0, 0, tam);
        buf = maior;
        sobra = tam;
        continue;
      }

      // 3) interpreta as linhas: id;faccao;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
      let i = 0;
      while (i < lim) {
        const inicioLinha = i;
        const fimId = fimDoCampo(buf, i, lim);
        if (!terminaEmPontoVirgula(buf, fimId, lim)) { i = proximaLinha(buf, fimId, lim); continue; } // linha vazia/incompleta
        const fimFaccao = fimDoCampo(buf, fimId + 1, lim);
        if (!terminaEmPontoVirgula(buf, fimFaccao, lim)) { i = proximaLinha(buf, fimFaccao, lim); continue; }

        const iniTs = fimFaccao + 1;
        const mesmoTs = mesmoTimestamp(buf, iniTs, lim, tsBytes, tsTamanho);
        const fimTs = mesmoTs ? iniTs + tsTamanho : fimDoCampo(buf, iniTs, lim);
        if (!terminaEmPontoVirgula(buf, fimTs, lim)) { i = proximaLinha(buf, fimTs, lim); continue; }

        const fimLat = fimDoCampo(buf, fimTs + 1, lim);
        if (!terminaEmPontoVirgula(buf, fimLat, lim)) { i = proximaLinha(buf, fimLat, lim); continue; }
        const fimLon = fimDoCampo(buf, fimLat + 1, lim);
        let fimLinha = fimLon;
        while (fimLinha < lim && buf[fimLinha] !== QUEBRA) fimLinha++;
        i = fimLinha + 1; // a próxima linha começa depois do '\n'

        const la = lerNumero(buf, fimTs + 1, fimLat);
        const lo = lerNumero(buf, fimLat + 1, fimLon);
        if (Number.isNaN(la) || Number.isNaN(lo)) continue; // ex.: a linha de cabeçalho

        // timestamp diferente do anterior: o grupo anterior acabou
        if (!mesmoTs) {
          fecharGrupo();
          if (parar) break;
          ts = texto(buf, iniTs, fimTs);
          tsTamanho = fimTs - iniTs;
          if (tsTamanho > tsBytes.length) tsBytes = Buffer.alloc(tsTamanho);
          buf.copy(tsBytes, 0, iniTs, fimTs);
        }

        // pessoa vista pela 1ª vez: lê facção e agressores
        const id = lerInteiro(buf, inicioLinha, fimId);
        if (pessoas[id] === undefined) {
          const resto = fimLon < fimLinha ? texto(buf, fimLon + 1, fimLinha) : '';
          pessoas[id] = lerPessoa(id, texto(buf, fimId + 1, fimFaccao), resto);
        }

        // guarda o ponto no grupo atual
        if (n === lat.length) { lat = dobrar(lat); lon = dobrar(lon); ids = dobrar(ids); }
        lat[n] = la;
        lon[n] = lo;
        ids[n] = id;
        n++;
      }
      if (ultimo) break;

      // 4) a linha incompleta do fim do bloco vai para o começo do buf
      buf.copy(buf, 0, lim, tam);
      sobra = tam - lim;
    }
    if (!parar) fecharGrupo(); // o último grupo do trecho
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { lerTrecho };
