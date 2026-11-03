# Detecção de Encontros

Algoritmo em **Node.js puro, sem dependências**, que processa dados de geolocalização de monitorados (tornozeleira eletrônica) e vítimas (rastreador portátil) e detecta encontros a **menos de 20 metros** no **mesmo timestamp**.

| Dataset | Tamanho | Encontros | generico | faccao | protetiva | Tempo* |
|---|---|---|---|---|---|---|
| 1 | 0,3 MB | 4 | 2 | 1 | 1 | 13 ms |
| 2 | 1,3 MB | 6 | 3 | 2 | 1 | 16 ms |
| 3 | 5 MB | 10 | 5 | 3 | 2 | 33 ms |
| 4 | 20 MB | 15 | 7 | 5 | 3 | 42 ms |
| 5 | 50 MB | 21 | 10 | 7 | 4 | 94 ms |
| 6 | 404 MB | 27 | 12 | 9 | 6 | 258 ms |
| 7 | 609 MB | 35 | 15 | 12 | 8 | 251 ms |
| **Total** | **1,1 GB** | **118** | | | | **≈ 700 ms** |

\* Medido num Ryzen 7 5700X (8 núcleos / 16 threads). O tempo varia cerca de 10% entre execuções.

**Exatidão:** a saída foi conferida por **força bruta** (comparando todos os pares de cada timestamp) em todos os datasets: **0 encontros faltando, 0 falsos positivos e 0 tipos errados**, com distâncias iguais até o último dígito. Nos datasets 1 e 2 a saída é **idêntica, byte a byte, ao gabarito oficial**.

---

## Por que esta é a melhor abordagem

O desafio tem dois critérios, nesta ordem: **acertar os encontros** (Score = soma_ec − soma_ei) e, no desempate, **rodar mais rápido**. A solução foi construída para não abrir mão do primeiro em troca do segundo.

**1. Exatidão em primeiro lugar.**
- A distância é a **Haversine do enunciado**, escrita na forma literal (R = 6.371.000 m), com o critério estrito `d < 20`. Ela reproduz o gabarito oficial **até o último dígito**.
- **Nada é arredondado:** as coordenadas são lidas com exatamente o mesmo valor que o `parseFloat` (seção 4.1).
- **Nenhum par é descartado por aproximação:** os atalhos de velocidade se apoiam numa propriedade matemática da Haversine (`d ≥ R·|Δφ|`, seção 4.3), não em estimativas.
- **Comprovado:** um verificador independente compara **todos os pares** de cada timestamp por força bruta e confere a saída encontro por encontro. Resultado: 0 faltando, 0 a mais, 0 tipos errados, e a saída é idêntica byte a byte aos gabaritos oficiais.

**2. Velocidade sem perder exatidão.** Cada etapa elimina trabalho desnecessário:
- **busca de pares em O(m)** com a tabela hash de faixas, em vez de O(m²): com 120 pessoas, ~240 consultas por timestamp em vez de 7.140 Haversines;
- **leitura em fluxo, direto nos bytes:** cada timestamp é processado e descartado assim que termina, então a memória usada é a de um bloco de 8 MB, e não a de 1 GB;
- **paralelismo ajustado ao processador**, uma thread por núcleo físico. Foi um conceito que **aprendi na faculdade** e uma das decisões que **mais deram certo** no projeto (veja a seção 4.4).

O resultado é **1,1 GB processado em ≈ 700 ms**, cerca de 1,6 GB por segundo.

**3. Simples e sem dependências.** É Node.js puro, sem bibliotecas: basta ter o Node e rodar `npm start`. São cerca de 960 linhas, e cada otimização existe por um motivo concreto nos dados. As que não faziam diferença nestes datasets foram implementadas, testadas e **retiradas** para manter o código fácil de ler e explicar (seção 8).

**4. Por que não outras abordagens.**
- **Comparar todos os pares (força bruta):** correta, mas O(m²). Ela é usada só no `verificar.js`, como referência.
- **Ler o arquivo inteiro como texto:** quebra em arquivos acima de ~512 MB, que é o limite de uma string no Node.js.
- **Árvores espaciais** (k-d tree, quadtree, R-tree) ou bibliotecas de geolocalização: com 10 a 120 pessoas por timestamp, montar uma árvore a cada timestamp custa mais do que a tabela de faixas, que é O(m) e não precisa ordenar nada.
- **Banco de dados com índice espacial:** só a carga de 1 GB num banco já levaria mais tempo do que o programa inteiro.

**5. Adaptável.** O mesmo código se ajusta à máquina de quem avalia:
- detecta os núcleos físicos e o perfil do processador;
- o `npm run calibrar` mede a melhor configuração na própria máquina;
- se um arquivo vier fora de ordem, o programa percebe e troca de modo, mantendo o resultado certo.

---

## 1. Como rodar

Requisito: **Node.js 16 ou superior**. Não há dependências, então não é preciso rodar `npm install`.

1. Coloque os arquivos em `data/`:
   ```
   data/dataset1.txt ... dataset7.txt
   data/respostas1.json, respostas2.json    (gabaritos oficiais, opcionais)
   ```
2. Gere as respostas:
   ```
   npm start
   ```
   Cria `output/respostasN.json` para cada dataset e mostra os encontros, as threads usadas e o tempo de cada um.
3. (Opcional) Confira a exatidão:
   ```
   npm run verificar
   ```
4. **(Opcional, mas recomendado) Ajuste a velocidade à sua máquina:**
   ```
   npm run calibrar
   ```
   > **Por que vale a pena.** O resultado é sempre o mesmo; o que muda é o **tempo**. O programa divide cada arquivo entre várias threads, que trabalham ao mesmo tempo (seção 4.4), e o número ideal de threads **depende do processador**: num desktop, uma por núcleo físico; num notebook de baixo consumo, menos que isso, porque o chip reduz a frequência quando todos os núcleos trabalham juntos. O padrão do código acerta na maioria dos casos, mas a calibração **mede em vez de adivinhar**: roda o programa várias vezes com cada configuração, grava a mais rápida em `calibracao.json`, e o `npm start` passa a usá-la.
   >
   > **Exemplo real:** num notebook Ryzen 7 5700U, a calibração reduziu o tempo total de **2,9 s para 1,75 s (40% mais rápido)**. Leva alguns minutos e só precisa ser feita uma vez por máquina.

---

## 2. Regras implementadas

Um par de pessoas é um **encontro** quando as duas condições abaixo valem:
1. as duas têm o **mesmo timestamp exato** (texto idêntico, por exemplo `2024-01-01 00:00:05`);
2. a distância entre elas, pela **fórmula de Haversine** com raio da Terra **R = 6.371.000 m**, é **menor que 20 m**. Exatamente 20 m não conta.

Cada encontro recebe **um único tipo**, nesta ordem de prioridade:

| Prioridade | Tipo | Regra |
|---|---|---|
| 1º | `protetiva` | um dos dois está na lista `idsRestricaoMedida` do outro (agressor e a vítima dele) |
| 2º | `faccao` | os dois têm facção preenchida **e** igual |
| 3º | `generico` | qualquer outro par de monitorados |

| Exemplo (a < 20 m) | Tipo |
|---|---|
| 2 agressores da mesma facção | `faccao` |
| 2 agressores de facções diferentes, ou sem facção | `generico` |
| Vítima + o agressor dela | `protetiva` |
| Vítima + um agressor que não é o dela | `generico` |
| 2 vítimas | `generico` |

- **Unicidade.** A prioridade garante um único registro por par e por timestamp. Um agressor perto da própria vítima é `protetiva` e não é contado de novo como `generico`. Se a mesma pessoa aparecer duas vezes no mesmo timestamp, vale a primeira posição.
- **Por que `generico` inclui as vítimas.** O enunciado define o genérico como encontro entre "**quaisquer dois monitorados**", e o próprio formato de entrada chama todos de monitorados ("idMonitorado: … podendo ser usuário de tornozeleira **ou vítima**"). O genérico funciona como a categoria de menor gravidade, que pega todo par que não é um caso de atenção.

**Saída:** um array JSON no formato de `JSON.stringify(lista, null, 2)`, ordenado por timestamp, com os IDs de cada par em ordem crescente:
```json
[
  {
    "tipo": "faccao",
    "monitoradosEncontro": [7, 8],
    "timestamp": "2024-01-01 00:36:00",
    "posicoes": {
      "7": { "lat": -13.02054, "lon": -46.40609 },
      "8": { "lat": -13.02046, "lon": -46.40609 }
    },
    "distanciaMetros": 8.895594131622975
  }
]
```

---

## 3. A base do algoritmo

Na forma mais simples, o algoritmo é este:

```
para cada timestamp:
    junte todas as pessoas com aquele timestamp
    para cada par (A, B) dessas pessoas:
        d = haversine(A, B)
        se d < 20:
            registre o encontro com o tipo (protetiva > faccao > generico)
```

A distância é a Haversine escrita exatamente como no enunciado:
```
a = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2)
d = 2 · R · arcsin(√a)          R = 6.371.000 m
```
(φ = latitude e λ = longitude, em radianos: `graus × π / 180`.)

Essa versão é correta, mas lenta: compara todos os pares e guarda o arquivo inteiro na memória. É exatamente o que o `verificar.js` faz, de propósito, para servir de referência. A seção a seguir mostra como o programa principal chega ao **mesmo resultado** muito mais rápido.

---

## 4. Como o algoritmo foi otimizado

Cada otimização abaixo **reduz trabalho sem mudar o resultado**. Nenhuma delas arredonda valores ou ignora um par que possa estar a menos de 20 m.

### 4.1 Leitura em blocos de bytes
- O arquivo é lido em **blocos de 8 MB**, nunca inteiro. Ler 600 MB como um texto só estoura o limite do Node.js, que é de cerca de 512 MB por string.
- Cada linha é interpretada **direto nos bytes**, procurando os `;`, sem `split`, sem `readline` e sem criar textos. Quase não sobra trabalho para o coletor de lixo.
- **Números sem `parseFloat` e sem perda:** `-10.07996` é lido como o inteiro `1007996` e dividido por `10⁵`. Para até 15 dígitos, essa divisão gera **exatamente o mesmo valor** que o `parseFloat`, bit por bit, porque a divisão em ponto flutuante tem arredondamento correto. Não é uma aproximação.
- **Timestamp sem conversão:** o timestamp quase sempre é igual ao da linha anterior, então basta comparar os bytes com os da linha anterior. Ele só vira texto quando muda, ou seja, uma vez por grupo.
- Dados fixos da pessoa (facção e agressores) são lidos **só na primeira vez** em que ela aparece.

### 4.2 Modo de fluxo: processar cada timestamp e descartar
Os datasets vêm **em ordem de timestamp**, com as linhas de cada instante em sequência. Então não é preciso guardar 12 milhões de pontos:
- quando o timestamp muda, o grupo anterior está completo: os encontros dele são calculados **na hora** e os pontos são descartados;
- uma linha cortada no fim de um bloco de 8 MB passa para o bloco seguinte;
- a memória usada é a de um bloco, não a do arquivo inteiro.

Se algum arquivo vier **fora de ordem** (um timestamp menor ou repetido depois de outro), o programa percebe e usa o **modo geral**: junta os pontos de cada timestamp na memória e só depois calcula. É mais lento, mas funciona em qualquer ordem, e o resultado é o mesmo.

### 4.3 Busca de pares: tabela hash de faixas de latitude
Comparar todos os pares de um timestamp custa O(m²). O programa evita isso com uma propriedade da própria Haversine:

> **d ≥ R · |Δφ|**: a distância nunca é menor que a diferença de latitude convertida em metros.

Logo, dois pontos a menos de 20 m têm latitudes a menos de 20 m uma da outra. O mapa é então dividido em **faixas horizontais de 40 m**, como as linhas de um caderno:

```
                     ┌───────────────────────────────────────────┐ 1.040 m
                     │                          • B  (1.025 m)   │
  faixa 25           │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │ 1.020 m  ← meio da faixa
  (1.000 a 1.040 m)  │       • A  (1.010 m)                      │
                     ├───────────────────────────────────────────┤ 1.000 m
  faixa 24           │                  • C  (995 m)             │
  (960 a 1.000 m)    └───────────────────────────────────────────┘   960 m
                        oeste ←────────── longitude ──────────→ leste
```
*(Para simplificar, a latitude está em metros a partir do equador; no código ela está em graus, e cada faixa tem cerca de 0,00036°.)*

- **A** está na **metade de baixo** da faixa 25. Um vizinho a menos de 20 m **ao norte** chega no máximo a 1.030 m, ainda na faixa 25; **ao sul**, chega até 990 m, na faixa 24. Então A só precisa olhar **as faixas 25 e 24**: as outras não podem ter ninguém a menos de 20 m dela.
- **B** está na **metade de cima**, então olharia as faixas 25 e 26.
- Cada pessoa é comparada **só** com quem já foi colocado nessas 2 faixas, e depois entra na sua. Assim cada par é testado uma única vez.
- O Brasil tem uns 4.300 km de norte a sul, ou seja, **mais de 100 mil faixas** para no máximo 120 pessoas. Quase sempre cada pessoa está sozinha na sua faixa: em vez de 7.140 Haversines por timestamp (todos os pares de 120 pessoas), são cerca de **240 consultas rápidas**. O custo cai de O(m²) para **O(m)**, sem ordenar nada.

A faixa olha **só a latitude**, então duas pessoas na mesma faixa podem estar a 1.000 km uma da outra no sentido leste-oeste. A faixa só decide **quem vale a pena testar**; quem decide se é encontro é sempre a **Haversine exata**.

**Por que só a latitude, e não uma grade de latitude × longitude.** Um grau de latitude vale ~111 km em qualquer lugar, então "20 m" é sempre o mesmo tamanho em graus. Um grau de longitude encolhe longe do equador (111 km em Macapá, 96 km em Porto Alegre), então uma grade precisaria de células de largura variável. E como quase ninguém divide faixa, a longitude não teria o que separar: cada pessoa passaria a consultar 4 células em vez de 2 faixas, dobrando o trabalho para economizar uma conta rara.

**A tabela hash: onde as faixas ficam guardadas.** O nº da faixa é grande (ex.: −33,24° → faixa −92 333), e só umas poucas faixas têm alguém. Um array com uma posição por faixa possível teria milhões de posições vazias. A tabela hash é um **armário com poucas gavetas** (pelo menos 2 por pessoa; 256 para 120 pessoas):

```
  exemplo com 8 gavetas:  gaveta = faixa & 7   (o resto da divisão do nº da faixa por 8)

  gaveta 0 │ P2 (faixa 7000)
  gaveta 1 │ P3 (faixa 5097) ─► P1 (faixa 3001) ─► P0 (faixa 5097)
  gaveta 2 │ (vazia)
  ...
```
- Faixas diferentes podem cair na mesma gaveta (5097 e 3001 caem na gaveta 1), por isso o código confere a faixa de cada pessoa da gaveta.
- Quando **P3** chega, ele percorre a gaveta 1: **P1** é de outra faixa e é pulado; **P0** é da mesma faixa, e só esse par vai para a Haversine. De 6 pares possíveis, 1 conta.
- A lista de cada gaveta é uma corrente feita com dois arrays (`cabeca[gaveta]` = último a entrar, `proximo[pessoa]` = quem entrou antes dele). Os arrays são **reaproveitados** em todos os timestamps, sem criar objetos novos.
- **O carimbo:** cada gaveta guarda o nº do timestamp que a usou. No timestamp seguinte, as gavetas com carimbo antigo contam como vazias automaticamente, então não é preciso esvaziar o armário centenas de milhares de vezes.

### 4.4 Paralelismo adaptado ao processador

> **Um conceito da faculdade que fez a diferença.** O paralelismo foi um conteúdo que aprendi na faculdade: dividir um problema em partes **independentes** e processá-las **ao mesmo tempo**, em núcleos diferentes do processador. Também aprendi lá que mais threads nem sempre é melhor: quando o gargalo é a **memória**, threads demais competem pelo mesmo recurso e o tempo piora, e as duas threads de um mesmo núcleo físico (SMT/Hyper-Threading) dividem o mesmo hardware. Aplicar esses dois conceitos neste desafio **deu muito certo**: as medições abaixo confirmaram exatamente o que a teoria previa.

Junto com o modo de fluxo, o paralelismo foi **a ideia que mais reduziu o tempo**. Ler e interpretar 1 GB de texto é o trabalho pesado do programa, e ele pode ser dividido: cada parte do arquivo é independente das outras, então várias threads podem trabalhar ao mesmo tempo, cada uma num núcleo do processador. Mas o **número** de threads importa muito: threads demais disputam a memória e atrapalham umas às outras.

| Máquina (soma dos 7 datasets) | Threads | Tempo |
|---|---|---|
| Desktop Ryzen 7 5700X (8 núcleos / 16 threads) | 16 (todas as threads lógicas) | ≈ 930 ms |
| | **8 (1 por núcleo físico)** | **≈ 723 ms** |
| Notebook Ryzen 7 5700U (8 núcleos / 16 threads) | 8 (1 por núcleo físico) | 2,9 s |
| | **4 (metade, perfil série U)** | **1,75 s** |

Como funciona:
- O arquivo é dividido em trechos, **um por thread**, e cada thread lê e processa o seu trecho ao mesmo tempo que as outras.
- Cada corte é posicionado **exatamente numa troca de timestamp**: antes de dividir, o programa lê alguns KB em volta do ponto de corte e avança até a primeira linha com um timestamp novo. Assim nenhum grupo fica dividido entre duas threads, e cada thread já devolve os encontros prontos.
- **Quantas threads:** `mín(tamanho do arquivo / 4 MB, núcleos físicos)`. Arquivos pequenos usam 1 thread, porque coordenar threads custaria mais do que dividir economizaria. Arquivos grandes usam uma thread por **núcleo físico**.
- **Por que núcleos físicos, e não todas as threads:** o trabalho é limitado pela memória, e as threads "extras" do SMT/Hyper-Threading dividem o mesmo núcleo. Medido no Ryzen 7 5700X: 8 threads ≈ 723 ms e 16 threads ≈ 930 ms.
- **Notebooks de baixo consumo (processadores série "U") usam metade dos núcleos.** Esses chips têm limite de cerca de 15 W: com todos os núcleos ativos, cada um baixa muito a frequência, e a memória, mais lenta, satura. Medido num Ryzen 7 5700U (8 núcleos): **4 threads = 1,75 s contra 8 threads = 2,9 s**. O tipo do processador é identificado pelo nome (`Ryzen 7 5700U`, `Core i5-1235U`…), que o Node informa sem custo. Nos demais processadores, vale um thread por núcleo físico.
- Os núcleos físicos são detectados automaticamente (Linux, Mac) ou estimados (Windows; o `calibrar.js` mede de verdade); veja `src/cpu.js`. Isso adapta o programa a qualquer processador: Ryzen 5 5600 → 6 threads, i5 sem Hyper-Threading com 6 núcleos → 6, notebook com 2 núcleos e 4 threads → 4.

### 4.5 Saída
Os encontros são poucos (dezenas por dataset), então a saída é gerada com o próprio `JSON.stringify(lista, null, 2)`, exatamente o formato pedido.

### Evolução na máquina do autor (soma dos 7 datasets)
| Versão | Tempo |
|---|---|
| Primeira versão (arquivo lido inteiro como texto) | quebrava em arquivos > 512 MB |
| Leitura em bytes + threads + hash de faixas | 1.412 ms |
| \+ Modo de fluxo (processa e descarta cada timestamp) | 949 ms |
| \+ Threads por núcleo físico, parâmetros calibrados | **≈ 700 ms** |

---

## 5. Decisão final e exatidão

### Como cada par é decidido
Todo par que sobra da busca por faixas (que só elimina pares certamente a 20 m ou mais) passa pela **Haversine completa**, exatamente como no enunciado. Ele só vira encontro se **`d < 20`**. Os pontos de exatidão:
- **as coordenadas não são arredondadas:** a leitura gera o mesmo valor que o `parseFloat` (seção 4.1);
- **nenhum par válido é descartado:** a busca por faixas se apoia em `d ≥ R·|Δφ|`, que é uma propriedade matemática;
- **a fórmula é a do enunciado:** `sin²(Δφ/2) + cos φ1·cos φ2·sin²(Δλ/2)` e `d = 2R·arcsin(√a)`.

### O caso de 19,9999999 m
Computadores representam números reais com precisão finita, de cerca de 16 dígitos. Duas escritas da Haversine que são matematicamente iguais podem diferir **no último dígito**. Por exemplo:
- `atan2(√a, √(1−a))` em vez de `arcsin(√a)`;
- `(cos·cos·sin)·sin` em vez de `cos·cos·(sin²)`.

Num teste, isso gerou `10.81640474094182` contra `10.816404740941822`, uma diferença de 0,000000000000002 m.

Isso só mudaria o resultado de um encontro se a distância real estivesse colada nos 20 m, como **19,99999999999999** contra **20,00000000000001**. Para reduzir esse risco:
1. foi usada a forma **literal** do enunciado, e ela reproduz o gabarito oficial **até o último dígito** em todos os encontros conhecidos;
2. as coordenadas têm 5 casas decimais, ou seja, uma "grade" de cerca de 1,1 m. As distâncias possíveis entre pontos dessa grade são valores discretos, e a chance de um deles cair a menos de 10⁻¹² m dos 20 m é praticamente nula;
3. o critério é estrito: exatamente 20 m **não** é encontro, como pede o enunciado.

### Como foi verificado
O `verificar.js` é **independente** do código otimizado. Ele não usa nenhum dos atalhos acima:
- lê cada dataset linha a linha e compara **todos os pares** de cada timestamp com a Haversine;
- confere cada encontro da saída: o par, o tipo e a **distância exata**;
- acusa encontro faltando, falso positivo, tipo errado e duplicado;
- se existir um gabarito oficial em `data/`, compara com ele também.

Resultado nos 7 datasets: **todas as saídas conferem com a força bruta e com os gabaritos oficiais disponíveis.**

---

## 6. Calibração (opcional, mas recomendada)

**Benefício:** o mesmo resultado, no menor tempo possível **na máquina de quem roda**. Como a seção 4.4 mostra, o número certo de threads pode mudar o tempo em até 40%, e ele depende do processador, da memória e até do limite de energia do notebook. Em vez de confiar só no padrão, a calibração mede.

Três parâmetros mudam só a **velocidade**, nunca o resultado. Os padrões são a melhor configuração medida nas máquinas do autor: num desktop Ryzen 7 5700X (3 calibrações consistentes) e num notebook Ryzen 7 5700U. A calibração faz diferença: no notebook, o padrão de desktop levava 2,9 s e a configuração calibrada, 1,75 s.

| Parâmetro | Padrão | O que faz |
|---|---|---|
| `BLOCO_MB` | 8 | tamanho do bloco de leitura |
| `FATOR_NUCLEOS` | 1 (0,5 em série U) | máximo de threads = núcleos físicos × fator |
| `MB_POR_THREAD` | 4 | mínimo de MB por thread (decide quantas threads os arquivos médios usam) |

`npm run calibrar` mede os melhores valores **na máquina em que roda**:
1. testa cada valor várias vezes, cada uma como um processo novo, e tira a média, descartando a primeira execução, que só aquece o cache do disco;
2. faz um **confronto final alternado** (candidata, padrão, candidata…) entre a melhor combinação encontrada e o padrão, para que oscilações da máquina afetem os dois por igual; **vence a menor média**;
3. grava o resultado em `calibracao.json` e roda o programa principal com ele.

Sem `calibracao.json`, valem os padrões. Os núcleos medidos só são usados no mesmo computador; em outro, o programa detecta os núcleos de novo.

---

## 7. Estrutura do projeto

```
index.js            npm start: lê data/, decide as threads, grava output/ e mostra o resumo
verificar.js        npm run verificar: conferência independente (força bruta + gabaritos oficiais)
calibrar.js         npm run calibrar: mede a melhor configuração de velocidade nesta máquina
src/
  leitor.js         lê o arquivo em blocos de bytes e entrega os pontos agrupados por timestamp
  encontros.js      busca de pares (hash de faixas de latitude), Haversine e classificação
  processar.js      corta o arquivo nas trocas de timestamp, distribui entre as threads, modo geral
  worker.js         código que roda em cada thread
  cpu.js            núcleos físicos e perfil do processador
data/               entradas
output/             respostas geradas
```

---

## 8. Melhorias implementadas, testadas e retiradas para simplificar

> **Importante:** tudo o que está nesta seção **foi implementado e testado**. Numa versão anterior do projeto, com todas essas otimizações, a saída era **idêntica byte a byte** à atual nos 7 datasets e em testes extras feitos para forçar esses casos (pessoas concentradas numa área pequena, arquivo fora de ordem, milhares de encontros), tudo conferido pela força bruta do `verificar.js`. Elas foram **retiradas de propósito**: nestes datasets não mudavam o tempo e deixavam o código com o dobro do tamanho (cerca de 1.900 linhas contra 960). Preferi um algoritmo mais simples de ler, explicar e manter, e deixar aqui o caminho para quando os dados pedirem.

A solução atual foi feita sob medida para estes datasets: pessoas **espalhadas pelo Brasil**, arquivos **em ordem de timestamp** e **poucos encontros**. Em dados de outro formato ela continua dando a resposta **certa**; só algumas situações ficariam mais lentas. Estas são as melhorias para elas.

### 8.1 Filtro barato antes da Haversine
A Haversine é a conta mais cara do programa: 2 senos, 2 cossenos, uma raiz quadrada e um arco-seno, funções que custam dezenas de vezes mais que uma soma ou multiplicação. O **filtro barato** decide, só com **somas e multiplicações**, se vale a pena calcular a Haversine:
```
Δlat² + (Δlon × cos_min)²  ≥  (20 m em graus)²     →  longe demais: descarta sem calcular a Haversine
```
- **Por que ele nunca erra:** `cos_min` é o cosseno da latitude mais longe do equador no grupo, o menor de todos. Multiplicar a diferença de longitude por ele **encurta** a distância, então a estimativa fica sempre **abaixo** da real. Se até a estimativa "por baixo" dá 20 m ou mais, a distância real com certeza também dá. Uma folga de 1% cobre o arredondamento.
- **Ele só elimina, nunca aprova:** todo par que passa pelo filtro ainda é decidido pela Haversine exata.
- **Quando faz diferença:** quando muitos pares caem na mesma faixa (caso 8.2), quase todos estão longe na longitude, e o filtro elimina a grande maioria a um custo mínimo. Nestes datasets, com ~0,1 par candidato por timestamp, não há o que economizar; por isso saiu.

### 8.2 Muita gente concentrada numa cidade
A hash de faixas é O(m) porque quase ninguém divide faixa. Se centenas de pessoas estivessem na mesma cidade, todas cairiam nas mesmas poucas faixas e a busca viraria quase "todos contra todos". A ideia é escolher a estratégia por timestamp:
- **poucos pontos concentrados (até ~32):** ordenar por latitude (insertion sort, ótimo para listas pequenas) e, para cada ponto, comparar só com os seguintes até a latitude passar de 20 m;
- **muitos pontos concentrados:** ordenar por faixas de 20 m (counting sort, O(m)) e, dentro de cada faixa e da faixa de cima, ordenar por longitude e comparar só quem está numa **janela de longitude** de 20 m (`Δlon ≤ 20 m / cos(lat)`), com o filtro barato antes da Haversine.

### 8.3 Arquivo fora de ordem, com várias threads
Hoje o modo geral roda numa thread só. A versão paralela: cada thread lê um trecho e conta os pontos por timestamp; a thread principal soma as contagens e calcula onde cada timestamp começa num array **compartilhado** (`SharedArrayBuffer`, counting sort em O(n)); cada thread copia os seus pontos para lá, e a detecção é dividida em faixas de timestamps entre as threads.

### 8.4 Saída com milhões de encontros
Com poucos encontros, `JSON.stringify` é instantâneo. Com milhões, montar milhões de objetos pesa na memória. Dá para escrever o JSON **direto em bytes**, por pedaços, já no formato de `JSON.stringify(lista, null, 2)`, e gravar cada pedaço assim que fica pronto.

### 8.5 Outros formatos de entrada
O leitor assume ids numéricos e o timestamp no formato `AAAA-MM-DD HH:MM:SS`. Ids com letras (tabela de texto → índice) ou outros formatos de data (tabela de textos à parte, ordenada no fim) podem ser aceitos sem mudar o caminho rápido.
