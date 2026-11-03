'use strict';

/**
 * ENCONTROS — procura os pares a menos de 20 m dentro de UM grupo
 * (todas as pessoas de um mesmo timestamp).
 *
 * Comparar todos os pares seria n·(n-1)/2 Haversines por grupo. Em vez disso:
 *
 *  1. Divide o mapa em FAIXAS horizontais de 40 m de latitude.
 *  2. Dois pontos a < 20 m têm latitudes a < 20 m (d >= R·|Δlat|), então um
 *     vizinho está na mesma faixa ou na faixa ao lado, do lado da metade em
 *     que o ponto está (de baixo ou de cima).
 *  3. Cada ponto é comparado só com os pontos já vistos nessas 2 faixas.
 *     Pessoas espalhadas pelo Brasil quase nunca dividem faixa: ~1 conta por ponto.
 *
 * As faixas ficam numa tabela hash (faixa -> lista de pontos) reaproveitada
 * em todos os grupos. Os pares candidatos passam pela Haversine EXATA (a do
 * enunciado) e só viram encontro se d < 20.
 */

const R = 6371000; // raio da Terra (m)
const LIMITE = 20; // encontro: distância MENOR que 20 m

// 20 m de latitude em graus (com uma folga de 0,0001% para nunca perder um par)
const DLAT = (LIMITE / R) / (Math.PI / 180) * 1.000001;
const FAIXAS_POR_GRAU = 1 / (2 * DLAT); // faixas de 40 m: latitude × isso = nº da faixa

// Tabela hash das faixas. O "carimbo" diz se a posição é do grupo atual:
// assim não é preciso apagar a tabela a cada grupo.
let mascara = 255;                     // tamanho da tabela - 1 (tamanho = potência de 2)
let cabeca = new Int32Array(256);      // posição da tabela -> último ponto inserido nela
let carimbo = new Int32Array(256);     // posição da tabela -> grupo que a usou por último
let proximo = new Int32Array(256);     // ponto -> ponto anterior na mesma posição (lista ligada)
let faixaDe = new Int32Array(256);     // ponto -> nº da faixa dele
let grupoAtual = 0;

/** Garante espaço para n pontos (tabela com pelo menos 2·n posições). */
function garantirEspaco(n) {
  if (n > proximo.length) {
    proximo = new Int32Array(n * 2);
    faixaDe = new Int32Array(n * 2);
  }
  if (cabeca.length < 2 * n) {
    let tamanho = cabeca.length;
    while (tamanho < 2 * n) tamanho *= 2;
    cabeca = new Int32Array(tamanho);
    carimbo = new Int32Array(tamanho);
    mascara = tamanho - 1;
  }
}

/** Haversine do enunciado: distância em metros entre dois pontos (graus). */
function haversine(latA, lonA, latB, lonB) {
  const s1 = Math.sin((((latB - latA) * Math.PI) / 180) / 2); // sen(Δlat/2)
  const s2 = Math.sin((((lonB - lonA) * Math.PI) / 180) / 2); // sen(Δlon/2)
  const a = s1 * s1 + Math.cos((latA * Math.PI) / 180) * Math.cos((latB * Math.PI) / 180) * (s2 * s2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Prioridade: protetiva > faccao > generico. */
function tipoDoEncontro(a, b) {
  if (a.agressores.includes(b.id) || b.agressores.includes(a.id)) return 'protetiva';
  if (a.faccao !== '' && a.faccao === b.faccao) return 'faccao';
  return 'generico';
}

/** Testa o par de pontos (j, r); se d < 20 m, adiciona o encontro. */
function testar(j, r, g) {
  const d = haversine(g.lat[j], g.lon[j], g.lat[r], g.lon[r]);
  if (d >= LIMITE) return;

  // o id menor vem primeiro
  let a = j, b = r;
  if (g.ids[a] > g.ids[b]) { a = r; b = j; }
  const pa = g.pessoas[g.ids[a]], pb = g.pessoas[g.ids[b]];

  g.encontros.push({
    tipo: tipoDoEncontro(pa, pb),
    monitoradosEncontro: [pa.id, pb.id],
    timestamp: g.ts,
    posicoes: {
      [pa.id]: { lat: g.lat[a], lon: g.lon[a] },
      [pb.id]: { lat: g.lat[b], lon: g.lon[b] },
    },
    distanciaMetros: d,
  });
}

/** Compara o ponto r com os pontos do grupo já inseridos na faixa indicada. */
function compararComFaixa(faixa, r, g) {
  const pos = faixa & mascara;
  if (carimbo[pos] !== grupoAtual) return; // posição vazia neste grupo
  for (let j = cabeca[pos]; j >= 0; j = proximo[j]) {
    if (faixaDe[j] === faixa) testar(j, r, g); // a posição pode ter outras faixas misturadas
  }
}

/** Insere o ponto r na sua faixa. */
function inserir(faixa, r) {
  const pos = faixa & mascara;
  if (carimbo[pos] !== grupoAtual) { carimbo[pos] = grupoAtual; cabeca[pos] = -1; } // sobra de outro grupo: esvazia
  proximo[r] = cabeca[pos];
  cabeca[pos] = r;
}

/**
 * Procura os encontros entre os n pontos de um timestamp e os adiciona em `encontros`.
 * lat/lon/ids: pontos do grupo; pessoas[id]: dados de cada pessoa.
 */
function procurarEncontros(ts, lat, lon, ids, n, pessoas, encontros) {
  if (n < 2) return;
  garantirEspaco(n);
  grupoAtual++;
  const g = { ts, lat, lon, ids, pessoas, encontros };

  for (let r = 0; r < n; r++) {
    const pessoa = pessoas[ids[r]];
    if (pessoa.visto === grupoAtual) continue; // mesma pessoa 2x no mesmo timestamp: vale a 1ª
    pessoa.visto = grupoAtual;

    const posicao = lat[r] * FAIXAS_POR_GRAU;                          // ex.: 1234.7 -> faixa 1234, metade de cima
    const faixa = Math.floor(posicao);
    const vizinha = posicao - faixa < 0.5 ? faixa - 1 : faixa + 1;      // faixa do lado mais próximo
    faixaDe[r] = faixa;

    compararComFaixa(faixa, r, g);
    inserir(faixa, r);
    compararComFaixa(vizinha, r, g);
  }
}

module.exports = { procurarEncontros };
