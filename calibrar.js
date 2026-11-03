'use strict';

/**
 * npm run calibrar — OPCIONAL. Mede, NESTE computador, os melhores valores de:
 *   1) BLOCO_MB        tamanho do bloco de leitura (padrão 8 MB)
 *   2) FATOR_NUCLEOS   máximo de threads = núcleos FÍSICOS × fator (padrão 1; 0,5 em notebook série U)
 *   3) MB_POR_THREAD   mínimo de MB do arquivo por thread (padrão 4): quantas threads os arquivos médios usam
 *
 * Cada valor roda o programa completo (como o npm start) várias vezes, e vale a
 * MÉDIA da "Soma dos tempos médios". A 1ª execução é descartada: só aquece o
 * cache do disco. No fim, um confronto ALTERNADO (candidata, padrão, candidata...)
 * decide entre a melhor combinação e o padrão: vence a menor média.
 * O resultado vai para calibracao.json, e o programa principal roda com ele.
 *
 * Uso: npm run calibrar
 *      node calibrar.js --sem-aplicar     só mede e mostra, sem gravar
 *      node calibrar.js --repeticoes=3    menos repetições (mais rápido, menos preciso)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { threadsLogicas, fisicosDoSistema, nucleosFisicos, perfilEnergia } = require('./src/cpu');

const PROGRAMA = path.join(__dirname, 'index.js');
const args = process.argv.slice(2);
const aplicar = !args.includes('--sem-aplicar');
const rep = Math.max(1, parseInt((args.find((a) => a.startsWith('--repeticoes=')) || '=5').split('=')[1], 10) || 5);
const inicio = Date.now();

/** Roda o programa uma vez com a configuração `cfg` e devolve a soma dos tempos (ms). */
function rodar(cfg) {
  const saida = execFileSync(process.execPath, [PROGRAMA], {
    cwd: __dirname,
    env: { ...process.env, ...cfg, CALIBRANDO: '1' },
    encoding: 'utf8',
  });
  return +saida.match(/Soma dos tempos médios: (\d+)/)[1];
}

/** Média de `rep` execuções (depois de 1 de aquecimento). */
function medir(cfg, rotulo) {
  rodar(cfg);
  const tempos = Array.from({ length: rep }, () => rodar(cfg));
  const media = tempos.reduce((a, b) => a + b, 0) / rep;
  console.log(`  ${rotulo.padEnd(22)} média ${media.toFixed(0).padStart(5)} ms   (execuções: ${tempos.join(', ')})`);
  return media;
}

/** Testa cada valor da lista e devolve o de menor média. */
function melhorValor(valores, cfgDe, rotuloDe) {
  let melhor = null;
  for (const v of valores) {
    const media = medir(cfgDe(v), rotuloDe(v));
    if (melhor === null || media < melhor.media) melhor = { v, media };
  }
  return melhor.v;
}

const logicas = threadsLogicas();
const medido = fisicosDoSistema(true); // no Windows pergunta via PowerShell (só aqui, fora do tempo medido)
const fisicos = medido || nucleosFisicos().n;
const maxDe = (f) => Math.min(logicas, Math.max(1, Math.round(fisicos * f))); // threads para um fator
const perfil = perfilEnergia();
const CPU = { NUCLEOS_FISICOS: fisicos, THREADS_LOGICAS: logicas };
const PADRAO = { ...CPU, BLOCO_MB: 8, MB_POR_THREAD: 4, FATOR_NUCLEOS: perfil.fator };
const rotuloCfg = (c) => `${c.BLOCO_MB}MB / ${c.MB_POR_THREAD}MB / fator ${c.FATOR_NUCLEOS}`;

console.log(`Processador: ${logicas} threads, ${fisicos} núcleos físicos (${medido ? 'medido' : 'estimado'}). ${rep} execuções por valor.\n`);
console.log(`Perfil: ${perfil.perfil} (fator padrão ${perfil.fator})\n`);

console.log('1) Tamanho do bloco de leitura:');
const bloco = melhorValor([2, 4, 8, 16, 32], (b) => ({ ...PADRAO, BLOCO_MB: b }), (b) => `BLOCO_MB=${b}`);
console.log(`  -> melhor: ${bloco} MB\n`);

console.log(`2) Máximo de threads = ${fisicos} núcleos físicos × fator:`);
const vistos = new Set(); // fatores que dão o mesmo nº de threads são testados uma vez só
const fatores = [0.5, 0.75, 1, 1.25, 1.5, 2].filter((f) => !vistos.has(maxDe(f)) && vistos.add(maxDe(f)));
const fator = melhorValor(fatores, (f) => ({ ...PADRAO, BLOCO_MB: bloco, FATOR_NUCLEOS: f }), (f) => `FATOR=${f} (até ${maxDe(f)})`);
console.log(`  -> melhor: fator ${fator} (até ${maxDe(fator)} threads)\n`);

console.log('3) Mínimo de MB por thread (decide quantas threads os arquivos médios usam):');
const porThread = melhorValor([2, 4, 8, 16, 32],
  (t) => ({ ...PADRAO, BLOCO_MB: bloco, FATOR_NUCLEOS: fator, MB_POR_THREAD: t }), (t) => `MB_POR_THREAD=${t}`);
console.log(`  -> melhor: ${porThread} MB por thread\n`);

// Confronto final, alternado, para que oscilações da máquina afetem os dois por igual.
const candidata = { ...CPU, BLOCO_MB: bloco, MB_POR_THREAD: porThread, FATOR_NUCLEOS: fator };
let escolha = PADRAO;
if (rotuloCfg(candidata) !== rotuloCfg(PADRAO)) {
  console.log(`4) Confronto final, alternado: ${rotuloCfg(candidata)} x padrão ${rotuloCfg(PADRAO)}  (bloco / MB por thread / fator)`);
  rodar(candidata); rodar(PADRAO); // aquecimento
  const tc = [], tp = [];
  for (let i = 0; i < rep; i++) { tc.push(rodar(candidata)); tp.push(rodar(PADRAO)); }
  const mc = tc.reduce((a, b) => a + b, 0) / rep, mp = tp.reduce((a, b) => a + b, 0) / rep;
  console.log(`  candidata`.padEnd(24) + ` média ${mc.toFixed(0).padStart(5)} ms   (execuções: ${tc.join(', ')})`);
  console.log(`  padrão`.padEnd(24) + ` média ${mp.toFixed(0).padStart(5)} ms   (execuções: ${tp.join(', ')})`);
  if (mc < mp) { escolha = candidata; console.log(`  -> candidata é ${((1 - mc / mp) * 100).toFixed(1)}% mais rápida: adotada\n`); }
  else console.log(`  -> padrão é ${((1 - mp / mc) * 100).toFixed(1)}% mais rápido: mantido\n`);
} else {
  console.log('4) O padrão já foi o melhor em todas as etapas.\n');
}

console.log(`RESULTADO: BLOCO_MB=${escolha.BLOCO_MB}, MB_POR_THREAD=${escolha.MB_POR_THREAD}, FATOR_NUCLEOS=${escolha.FATOR_NUCLEOS} ` +
  `(até ${maxDe(escolha.FATOR_NUCLEOS)} das ${logicas} threads)`);
if (escolha === PADRAO) {
  console.log('-> O PADRÃO do código já é a melhor configuração para esta máquina: o npm start roda exatamente igual.');
  console.log('   (Diferenças de tempo entre uma execução e outra são variação normal, cerca de ±10%.)');
}
if (aplicar) {
  fs.writeFileSync(path.join(__dirname, 'calibracao.json'), JSON.stringify(escolha, null, 2) + '\n');
  console.log('Gravado em calibracao.json — o npm start passa a usar esses valores.');
} else {
  console.log('Nada gravado (--sem-aplicar).');
}
console.log(`Calibração concluída em ${((Date.now() - inicio) / 1000).toFixed(0)} s.`);

console.log('\n=== Rodando o programa principal com a configuração escolhida ===\n');
execFileSync(process.execPath, [PROGRAMA], {
  cwd: __dirname,
  env: aplicar ? process.env : { ...process.env, ...escolha },
  stdio: 'inherit',
});
