'use strict';

/**
 * CPU — quantos núcleos FÍSICOS o processador tem e qual o perfil de energia.
 *
 * O trabalho é limitado pela memória: a 2ª thread de cada núcleo (SMT /
 * Hyper-Threading) quase não ajuda. Por isso as threads são calculadas a
 * partir dos núcleos físicos. Fontes, em ordem:
 *  1. calibracao.json, se foi medido NESTE computador (mesmo nº de threads lógicas);
 *  2. o sistema, quando é barato perguntar: Linux (/proc/cpuinfo) e Mac (sysctl);
 *  3. estimativa: com 8+ threads lógicas presume 2 por núcleo (metade); com menos, todas.
 * No Windows perguntar custa ~1 s (PowerShell), então só o calibrar.js pergunta.
 */

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

/** Threads lógicas (ex.: 16 num Ryzen 7 5700X). */
function threadsLogicas() {
  return (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
}

/** Núcleos físicos segundo o sistema, ou null. Windows só com usarPowerShell = true. */
function fisicosDoSistema(usarPowerShell = false) {
  try {
    if (process.platform === 'linux') {
      // cada thread aparece com "physical id" (qual CPU) e "core id" (qual núcleo); conta os pares distintos
      const nucleos = new Set();
      let cpu = '0';
      for (const linha of fs.readFileSync('/proc/cpuinfo', 'utf8').split('\n')) {
        if (linha.startsWith('physical id')) cpu = linha.split(':')[1].trim();
        else if (linha.startsWith('core id')) nucleos.add(cpu + '-' + linha.split(':')[1].trim());
      }
      return nucleos.size || null;
    }
    if (process.platform === 'darwin') {
      return parseInt(execFileSync('sysctl', ['-n', 'hw.physicalcpu'], { encoding: 'utf8' }), 10) || null;
    }
    if (process.platform === 'win32' && usarPowerShell) {
      const comando = '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum';
      return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', comando], { encoding: 'utf8', timeout: 20000 }), 10) || null;
    }
  } catch { /* sem informação */ }
  return null;
}

/** { n, fonte }: núcleos físicos a considerar neste computador. */
function nucleosFisicos() {
  const logicas = threadsLogicas();
  const calibrado = +process.env.NUCLEOS_FISICOS;
  const logicasDaCalibracao = +process.env.THREADS_LOGICAS;
  if (calibrado > 0 && (!logicasDaCalibracao || logicasDaCalibracao === logicas)) return { n: calibrado, fonte: 'calibração' };
  const sistema = fisicosDoSistema();
  if (sistema) return { n: sistema, fonte: 'sistema' };
  return { n: logicas >= 8 ? Math.round(logicas / 2) : logicas, fonte: 'estimativa' };
}

/**
 * Perfil pelo NOME do processador. Chips de notebook de baixo consumo terminam
 * em "U" (Ryzen 7 5700U, Core i5-1235U): com ~15 W, todos os núcleos juntos
 * baixam muito a frequência. Medido no 5700U: 4 threads 1,75 s x 8 threads 2,9 s.
 */
function perfilEnergia() {
  const modelo = ((os.cpus()[0] || {}).model || '').trim();
  if (/\b\d{3,5}U\b/i.test(modelo)) return { modelo, perfil: 'notebook de baixo consumo (série U)', fator: 0.5 };
  return { modelo, perfil: 'padrão', fator: 1 };
}

module.exports = { threadsLogicas, fisicosDoSistema, nucleosFisicos, perfilEnergia };
