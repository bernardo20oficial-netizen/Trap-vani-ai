# Trap Vani AI — revisão técnica incremental

## Alterações desta etapa

- `src/audio/dspAnalysis.ts`: corrigida a validação dos limites de `detectFramePitchHz`. Um frame que termina exatamente no último índice válido agora é analisado; antes era rejeitado.
- `src/audio/dspAnalysis.ts`: a conversão para mono agora combina todos os canais do `AudioBuffer`, em vez de considerar apenas os dois primeiros.

## Limitações que continuam por validar

- O parâmetro `preserveFormants` está definido nos tipos/configuração, mas o motor `autotuneEngine.ts` ainda não implementa processamento independente de formantes. Não se deve afirmar que a preservação de formantes funciona.
- O algoritmo atual de correção de pitch usa reamostragem em grãos com overlap-add; precisa de avaliação auditiva e testes com vozes reais antes de ser considerado autotune de qualidade de estúdio.
- Não foi executada compilação nem teste de áudio nesta etapa: as dependências do projeto não estão instaladas neste ambiente.


## Etapa — proteção contra cancelamento de fase em áudio estéreo

17. A conversão estéreo/multicanal para mono usada na análise vocal e no autotune agora mede a energia do sinal resultante. Se a soma média cancelar quase todo o sinal (caso típico de canais em oposição de fase), usa temporariamente o canal com maior energia para análise/detecção de pitch.
18. A saída processada continua mantendo o número original de canais; o fallback afeta apenas o sinal mono usado para análise, não elimina canais da gravação.

### Validação desta etapa
- Revisão estática dos dois caminhos concluída.
- Ainda não foi executada compilação TypeScript nem teste com ficheiros estéreo reais; dependências e testes de áudio continuam pendentes.
- `preserveFormants` continua sem implementação DSP. Não foi ativado nem apresentado como funcional.

## Etapa — carregamento seletivo de samples do kit

19. `StudioAudioEngine.ensureKitBuffers` passou a aceitar uma lista de faixas e descarrega apenas os samples em falta para essas faixas. Chamadas simultâneas são serializadas e voltam a verificar quais faixas ainda faltam, evitando pedidos duplicados.
20. A reprodução calcula as faixas de kit realmente audíveis a partir do modo de monitorização, mute/solo, eventos do padrão e restrição de melodias. Em modo vocal ou quando o padrão não contém faixas de kit audíveis, não descarrega samples de bateria.
21. A exportação WAV reutiliza o mesmo cálculo e carrega somente as faixas necessárias para a renderização.

### Validação desta etapa
- Revisão estática dos caminhos de reprodução e exportação concluída.
- `npm install --ignore-scripts --no-audit --no-fund` foi tentado, mas excedeu o limite de tempo deste ambiente; não foi possível executar `tsc` nem `vite build`.
- Não foram realizados testes auditivos nem testes em navegador/dispositivo móvel. A melhoria está aplicada no código, mas ainda requer validação funcional.

## Etapa — limpeza fiável dos áudios personalizados

Revistos os fluxos de eliminação de samples 808 personalizados, pacotes 808 e substituição de gravações vocais/padrões feitos com a boca.

- As eliminações dos blobs associados deixaram de ser disparadas em segundo plano sem `await`.
- A aplicação aguarda a remoção do registo do sample e, em seguida, a remoção do áudio associado.
- Ao substituir uma gravação vocal ou de padrão de boca, a limpeza do áudio anterior também é aguardada.
- Isto reduz o risco de operações de armazenamento ficarem pendentes ou falharem silenciosamente.

**Limitação identificada:** as operações continuam a ser feitas em transações separadas. Se o dispositivo fechar a página entre a remoção do registo e a remoção do blob, ainda pode sobrar um blob órfão. Uma transação única entre stores seria uma melhoria futura mais robusta.

**Validação:** alteração de código revista; compilação e testes no navegador ainda pendentes.

## Etapa adicional — falhas e interrupções no armazenamento local
- As operações IndexedDB agora tratam explicitamente o evento `abort`, evitando que algumas promessas fiquem sem conclusão quando uma transação é interrompida.
- Erros de quota (`QuotaExceededError`) passam a produzir uma mensagem compreensível indicando falta de espaço no telefone.
- Mantida a base de dados existente (`trap_vani_ai_studio_v1`, versão 2), sem apagar nem recriar stores.
- Limitação: não foi possível executar a compilação nem testes reais no navegador nesta sessão; estas alterações precisam de validação no ambiente de execução.

## Etapa — substituição atómica de gravações

- Foi identificado um risco real nos fluxos de gravação vocal e de padrão feito com a boca: o áudio antigo era apagado antes de o áudio novo ser decodificado e antes de a referência do projeto ser guardada. Se a descodificação ou a gravação do projeto falhasse, o projeto podia ficar a apontar para um áudio já eliminado.
- Criada `replaceProjectAudio` em `src/storage/studioDb.ts`. A nova função guarda o novo Blob, atualiza o projeto e remove o Blob anterior dentro de uma única transação IndexedDB envolvendo as stores `projects` e `blobs`.
- Os fluxos de voz e de padrão feito com a boca agora descodificam/validam o áudio primeiro e só depois fazem a substituição atómica. O estado da interface é atualizado após a transação concluir.
- Se a transação falhar, a operação é revertida pelo IndexedDB e o áudio anterior permanece disponível.

### Validação desta etapa
- Revisão estática dos dois fluxos e da transação concluída.
- Compilação TypeScript, build Vite e testes reais no navegador ainda pendentes; não declarar esta alteração validada em execução até esses testes serem feitos.


## Etapa — eliminação atómica de projetos e bibliotecas 808

Foi identificado um problema concreto nos fluxos de eliminação: o projeto, o sample ou o pacote eram removidos numa transação e os Blobs de áudio noutra. Uma interrupção entre as duas operações podia deixar gravações órfãs no armazenamento local.

- `deleteProjectById` agora procura o projeto e remove o registo, o Blob vocal e o Blob do padrão de boca na mesma transação IndexedDB (`projects` + `blobs`).
- `deleteCustom808` agora remove o sample e o respetivo Blob na mesma transação (`custom808s` + `blobs`).
- `deleteCustomPack808` agora remove o pacote, todos os samples que lhe pertencem e os respetivos Blobs numa única transação (`packs808` + `custom808s` + `blobs`).
- A interface deixou de repetir a limpeza em operações separadas e aguarda a conclusão da transação atómica antes de atualizar o estado visual.

### Validação desta etapa
- Revisão estática dos fluxos de eliminação e das stores envolvidas concluída.
- A transação garante atomicidade: se uma operação falhar, o IndexedDB aborta o conjunto em vez de deixar apenas parte das eliminações aplicadas.
- Compilação TypeScript, build Vite e testes no navegador ainda não foram executados; não declarar a etapa validada em execução.
- Foi tentado `tsc --noEmit` com o compilador global disponível, mas a verificação parou antes de analisar o projeto porque as dependências locais não estão instaladas: falta a definição `vite/client`. Portanto, ainda não há resultado de compilação TypeScript.

## Etapa — proteção do autotune contra configurações inválidas

Foi identificado um risco no caminho DSP do autotune: os valores de configuração são guardados localmente e podem também vir de projetos importados ou de dados antigos. Se `mix`, `humanize` ou `retuneSpeedMs` chegassem como `NaN`/infinito, ou se a tonalidade/escala fosse inválida, os cálculos de correção podiam propagar valores não numéricos para o áudio processado.

- Criada a normalização de configurações antes do processamento do autotune.
- `retuneSpeedMs`, `mix` e `humanize` são agora limitados aos intervalos suportados e recebem valores seguros quando não são números finitos.
- Tonalidade e escala são verificadas contra as opções reconhecidas; valores inválidos passam para C menor.
- O estado `enabled` e `preserveFormants` é normalizado como booleano.
- A chave de cache do autotune passou a incluir `preserveFormants`, para que uma futura implementação real dessa opção não reutilize áudio processado com configuração diferente.

### Validação desta etapa
- Revisão estática da normalização e dos pontos de utilização concluída.
- Ainda não foi possível executar a compilação TypeScript nem o build Vite, porque as dependências do projeto não estão instaladas neste ambiente (incluindo os tipos `vite/client`).
- Não foram realizados testes auditivos. A opção `preserveFormants` continua sem processamento DSP implementado e não deve ser anunciada como funcional.
- Na análise vocal, o ciclo de estimativa de tonalidade também excluía um último frame que terminasse exatamente no fim da gravação. O limite foi ajustado para incluir esse frame completo, mantendo a mesma validação usada pelo detetor de pitch.

## Etapa — cobertura do fim da gravação no autotune

Foi identificado um problema de cobertura no overlap-add do autotune: mesmo quando existia um último frame completo, a grelha regular de saltos (`hopSize`) podia deixar uma pequena região final da gravação fora de qualquer frame. Essa região era copiada sem correção, criando uma possível mudança de afinação no fim da voz.

- `autotuneEngine.ts` agora constrói explicitamente as posições dos frames.
- Mantém a grelha regular de análise e acrescenta um último frame ancorado em `input.length - frameSize` quando necessário.
- A análise de pitch e a síntese overlap-add usam a mesma lista de posições, garantindo cobertura do último bloco completo.
- Não altera o comprimento, a quantidade de canais nem a duração da gravação.

**Validação:** revisão estática do caminho de análise/síntese e verificação do ZIP concluídas. A compilação TypeScript, o build Vite e a avaliação auditiva continuam pendentes; esta alteração ainda precisa de testes com gravações reais. A opção `preserveFormants` continua sem implementação DSP.


## Etapa — autotune em gravações curtas

Foi identificado um caso concreto no `autotuneEngine.ts`: quando a gravação era menor do que o tamanho nominal da janela de análise (normalmente 1024–2048 amostras), a lista de frames ficava vazia. Nesse cenário, o caminho wet do autotune não processava nenhum frame e a saída acabava por reproduzir a gravação original, apesar de o autotune estar ligado.

- A janela de análise agora adapta-se ao comprimento real do áudio, até ao tamanho nominal.
- O passo entre frames é protegido para nunca ser zero.
- Para buffers demasiado curtos para conter sequer dois períodos mínimos da faixa de deteção, o motor devolve o áudio original em vez de tentar uma correção instável. É uma limitação explícita de duração mínima, não uma promessa de autotune em clips muito curtos.
- A duração e o número de canais são mantidos.

**Validação:** revisão estática concluída e cobertura das condições de tamanho verificada por simulação dos limites. A compilação TypeScript, o build Vite e os testes auditivos com gravações reais continuam pendentes; o algoritmo ainda precisa de avaliação de qualidade e `preserveFormants` continua sem implementação DSP.


## Etapa — ordenação e validação do padrão rítmico gravado com a boca

Foi identificado um problema concreto nos caminhos de reprodução ao vivo e exportação WAV: ambos utilizavam a última posição do array `mouthEvents` como se fosse necessariamente o evento com maior `timeSec`. A resposta da conversão por IA ou um projeto antigo/importado pode conter eventos fora de ordem. Nesse caso, a duração do ciclo podia ser calculada incorretamente e, na reprodução/exportação, o `break` ao encontrar um evento fora do limite podia descartar eventos válidos que aparecessem depois no array.

- Criada uma normalização comum dos eventos antes da reprodução e exportação: remove tempos negativos/não finitos e instrumentos desconhecidos, limita a velocidade a um intervalo seguro e ordena os eventos pelo tempo crescente.
- A duração do ciclo passa a ser calculada a partir do evento temporalmente mais tardio, deixando pelo menos um passo de semicolcheia após esse evento para evitar colisão com o início do ciclo seguinte.
- Reprodução ao vivo e exportação WAV usam a mesma sequência normalizada.
- Se o padrão indicar timing exato, mas não houver eventos válidos, a aplicação regressa ao padrão de grelha em vez de ficar silenciosa.

### Validação desta etapa
- Revisão estática dos dois caminhos (scheduler ao vivo e renderização offline) concluída.
- Simulação dos casos de eventos desordenados, tempo inválido e evento no limite do compasso confirmou a ordenação e o cálculo de ciclo esperado.
- A instalação das dependências foi novamente tentada com `npm install --ignore-scripts --no-audit --no-fund --prefer-offline`, mas excedeu o limite de tempo deste ambiente. Por isso, TypeScript, Vite build e testes reais de áudio continuam pendentes.

## Etapa — robustez do disparo dos samples 808 e leitura de padrões persistidos

Foi identificado um risco concreto no disparo do 808 em `library808.ts`: os metadados de projetos importados ou samples personalizados eram usados diretamente nos cálculos de `playbackRate` e na automação de ganho. Valores não finitos em `midiNote`, `rootNote`, `velocity`, `glideMs`, `time` ou duração do buffer podiam gerar automações inválidas ou exceções da Web Audio API. Gravações muito curtas também podiam criar tempos de ataque/libertação sobrepostos.

- O disparo agora rejeita buffers sem duração válida e timestamps não finitos.
- Nota MIDI e nota raiz são limitadas ao intervalo MIDI 0–127; valores inválidos recebem uma nota segura.
- A velocidade de reprodução é limitada a 0,25–4,0 para impedir pitch-shifts extremos vindos de dados corrompidos.
- A velocidade de disparo e o tempo de glide são normalizados antes de agendar os parâmetros.
- A envolvente de ganho adapta ataque e libertação à duração efetiva, evitando rampas em ordem temporal inválida em samples muito curtos.
- A função `getRequiredKitTracks` deixou de pressupor que `mouthEvents` e as listas de steps existem e são arrays válidos; projetos antigos/importados com estes campos ausentes deixam de provocar uma chamada `.some` sobre `undefined`.

### Validação desta etapa
- Revisão estática dos caminhos de disparo 808 e seleção de kits concluída.
- Casos-limite considerados: timestamp inválido, buffer sem duração, MIDI fora do intervalo, metadados `NaN`/infinito, glide inválido e buffer muito curto.
- A compilação integral e os testes auditivos ainda estão pendentes; estas correções não equivalem a certificação de funcionamento no navegador ou no telefone.

## Etapa — mistura Kick/808 e proteção dos disparos do kit

Foi identificado um problema concreto na reprodução ao vivo: o scheduler chamava o disparo das faixas mesmo quando estavam silenciadas ou excluídas pelo modo Solo/monitorização. O gate de áudio silenciava o resultado, mas o evento Kick continuava a acionar o sidechain do 808. Assim, um Kick inaudível podia baixar o volume do subgrave sem que o utilizador ouvisse o Kick.

- `StudioAudioEngine.triggerInstrumentEvent` agora verifica `isChannelAudible` antes de criar a fonte sonora ou acionar o sidechain. Faixas em mute, excluídas por Solo ou fora do modo de monitorização deixam de consumir processamento e deixam de alterar o 808.
- A automação do sidechain agora ignora timestamps inválidos e ancora o início no tempo atual do contexto quando o scheduler acorda atrasado, evitando programar automações inteiramente no passado.
- A profundidade do ducking foi ajustada de forma moderada (0.42) e com recuperação suave, para reduzir conflitos sem cortar excessivamente o corpo do 808.
- `triggerKitSample` agora valida buffer, duração e timestamp; normaliza velocidade e nota MIDI; limita a taxa de reprodução a uma faixa segura; e adapta ataque/libertação à duração real do sample. Isto protege especialmente melodias importadas e samples muito curtos contra `NaN`, taxas extremas e envelopes com tempos sobrepostos.
- Os disparos de 808 e dos samples do kit agora deslocam timestamps atrasados para alguns milissegundos à frente do relógio atual do contexto, evitando agendar fontes e envelopes no passado quando o scheduler sofre atrasos.
- O destino de playbackRate dos slides 808 também passou a respeitar o limite máximo de 4.0; antes, multiplicar a taxa base por 1.498 podia ultrapassar o limite que a própria normalização dizia garantir.

### Validação desta etapa
- Revisão estática dos caminhos live e offline concluída.
- Casos de mute/Solo/monitorização foram seguidos no fluxo de chamadas: o Kick inaudível já não chama `applySidechainDuck`.
- Integridade do ZIP será verificada após a compactação.
- Compilação TypeScript, build Vite, testes de reprodução no navegador e avaliação auditiva continuam pendentes. Não declarar a mistura certificada sem esses testes.

## Etapa — robustez da exportação WAV

Foi identificada uma fragilidade no caminho de exportação offline: os valores de BPM, número de passos, swing, efeitos vocais e ganho/master vinham diretamente dos dados do projeto. Um projeto antigo ou importado com valores `NaN`, infinitos ou fora dos limites podia provocar uma duração inválida no `OfflineAudioContext`, parâmetros inválidos no DSP ou uma alocação de memória excessiva.

- BPM limitado a 40–240, com fallback para 140; número de passos normalizado para 1–64; swing limitado a 0–0,75.
- Duração de exportação validada antes de criar o `OfflineAudioContext`; exports superiores a 15 minutos são rejeitados com mensagem clara para evitar esgotamento de memória em telefones.
- Ganho de saída, drive do clipper e parâmetros de vocal FX normalizados para intervalos seguros, com valores de fallback.
- O agendamento offline usa o BPM normalizado e os passos normalizados, e trata listas de tracks ausentes como vazias.
- O conversor WAV verifica a capacidade dos campos RIFF de 32 bits e a frequência de amostragem antes de escrever o cabeçalho; um ficheiro que exceda o limite do formato é rejeitado em vez de produzir um WAV corrompido.

### Validação desta etapa
- Revisão estática do caminho de exportação concluída.
- Verificação manual dos limites BPM, stepsCount, swing, duração, parâmetros de FX e tamanho RIFF concluída.
- `tsc --noEmit` foi tentado, mas termina antes de analisar o projeto porque as dependências locais não estão instaladas: falta `vite/client`. Não há confirmação de compilação.
- Build Vite e testes de renderização/escuta continuam pendentes. A nova proteção de duração também precisa ser testada em navegadores reais, sobretudo no Redmi A3.

## Etapa — ciclo de vida da gravação vocal no componente WaveformRecorder

Foi identificado um risco concreto no `WaveformRecorder.tsx`: o componente podia ser desmontado enquanto a gravação estava ativa ou enquanto o pedido de permissão do microfone ainda estava aberto. O cleanup anterior parava as tracks e fechava o AudioContext, mas não pedia ao `MediaRecorder` para terminar e descarregar o último bloco `dataavailable`. Além disso, dois toques rápidos no botão podiam iniciar pedidos concorrentes de microfone antes de o estado React `recording` ser atualizado.

- O componente agora mantém uma trava síncrona (`startingRef`) para impedir pedidos de gravação duplicados durante o fluxo assíncrono de permissões/inicialização.
- O cleanup de desmontagem pede `MediaRecorder.stop()` quando a gravação está ativa, permitindo que o evento final `dataavailable` seja entregue antes da limpeza normal feita em `onstop`.
- Se o utilizador sair do painel enquanto o diálogo de permissão está aberto, o stream recém-concedido é imediatamente parado e não é criado um gravador órfão.
- A mesma verificação é feita depois de `AudioContext.resume()`, pois essa operação também pode terminar depois da desmontagem do componente.
- As atualizações de estado React são protegidas por `mountedRef`, evitando atualizações de interface após desmontagem.
- A paragem manual trata a possibilidade de o navegador já ter tornado o recorder inativo, libertando recursos em segurança.
- A mensagem para navegadores sem `getUserMedia` esclarece que a gravação normalmente exige contexto seguro HTTPS (ou localhost durante desenvolvimento).

### Validação desta etapa
- Transpilação sintática isolada do `WaveformRecorder.tsx` com TypeScript: 0 diagnósticos de sintaxe.
- `tsc --noEmit` do projeto continua a falhar antes da análise dos componentes porque não existe a dependência local `vite/client`; por isso, não há confirmação de verificação de tipos nem de build.
- Não foram executados testes com microfone real, interrupção de chamadas, bloqueio de ecrã ou desmontagem em navegador móvel. Esses cenários continuam pendentes, especialmente no Redmi A3.

## Etapa — validação de importação de samples 808 (22/11/2026)

Revisão do fluxo `handleImportFiles808` em `src/App.tsx`.

- Rejeita ficheiros com menos de 64 bytes ou acima de 25 MiB antes de calcular hash e descodificar, reduzindo trabalho e picos de memória em telemóveis.
- Deixa de aceitar samples cuja duração descodificada esteja fora do intervalo de 0,05 a 8 segundos. Antes, a duração apenas era limitada no metadado, mas o ficheiro original completo continuava a ser guardado e reproduzido.
- Rejeita áudio com mais de dois canais ou taxa de amostragem fora de 8 kHz–192 kHz.
- Não guarda o sample se o motor de áudio não estiver disponível ou se a descodificação falhar.

Validação realizada nesta etapa: inspeção do fluxo e verificação do diff. Compilação TypeScript/build e testes com ficheiros de áudio reais continuam pendentes porque `node_modules` não está instalado nesta cópia de trabalho. Os limites escolhidos são limites de importação de samples 808, não limites para gravações vocais completas.

## Etapa — importação segura de pacotes 808 externos (22-11-2026)

### Problema identificado

As rotas de importação externa liam primeiro o corpo inteiro do manifesto e do áudio (`resp.text()` / `arrayBuffer()`) e só depois verificavam o tamanho. Um servidor remoto podia, portanto, provocar uma alocação de memória acima do limite pretendido antes de a validação acontecer. Além disso, a rota de proxy confiava sobretudo no `Content-Type` declarado pelo servidor remoto; um ficheiro HTML ou conteúdo arbitrário podia ser entregue com um tipo MIME de áudio.

### Alterações aplicadas em `server.ts`

- Criada `readResponseLimited`, que lê a resposta em blocos, verifica `Content-Length` quando disponível e interrompe a leitura assim que excede o limite.
- O manifesto JSON é agora limitado a 2 MiB durante a leitura, e não depois de ser totalmente carregado.
- O áudio externo é limitado a 15 MiB durante a leitura, com cancelamento do stream ao ultrapassar o limite.
- Criada deteção da assinatura real do ficheiro para WAV, MP3, OGG, FLAC, M4A/MP4 e WebM.
- A rota de proxy rejeita conteúdo inferior a 64 bytes ou cujo cabeçalho não corresponda a um formato de áudio reconhecido.
- O tipo MIME enviado ao browser passa a ser derivado da assinatura detetada, não apenas do cabeçalho fornecido pelo servidor externo.
- Adicionado `X-Content-Type-Options: nosniff` à resposta do áudio.

### Verificações

- `node --experimental-strip-types --check server.ts`: passou (verificação sintática).
- `tsc --noEmit`: não foi possível concluir porque as dependências do projeto não estão instaladas; o TypeScript parou em `TS2688: Cannot find type definition file for 'vite/client'`.
- Não foram executados testes de integração com servidores externos nem descodificação auditiva dos formatos nesta etapa.
- A integridade do ZIP foi verificada separadamente após a compactação.

### Limitações conhecidas

- A deteção de assinatura confirma o contentor/formato provável, mas não substitui a descodificação integral pelo navegador nem garante que o ficheiro esteja musicalmente válido.
- A validação DNS/SSRF da rede externa continua a merecer uma auditoria específica, incluindo endereços IPv6 e nomes DNS que resolvam para redes privadas.

## Etapa adicional — validação de endereços externos (22/11/2026)

Foi reforçada a validação do importador de pacotes 808 e do proxy de áudio em `server.ts`:

- A validação passou a ser assíncrona e resolve nomes DNS antes de permitir o pedido externo.
- São rejeitados nomes que resolvem para endereços IPv4 privados, loopback, link-local, CGNAT, documentação, multicast e faixas reservadas.
- Em IPv6, só é aceite o espaço de unicast global `2000::/3`; endereços locais, loopback, não especificados, multicast e documentação são rejeitados.
- Endereços IPv4 mapeados em IPv6 também são verificados.
- URLs com utilizador/palavra-passe incorporados são rejeitadas.
- A mesma validação é aplicada ao manifesto, a cada URL de sample e ao proxy de áudio.

**Limitação de segurança ainda aberta:** a resolução DNS é verificada antes de `fetch`, mas o transporte `fetch` resolve o nome novamente. Um domínio malicioso pode, em teoria, alterar a resposta DNS entre a verificação e a ligação (DNS rebinding). Para eliminar esse risco é necessário fixar os IPs validados no transporte HTTP/TLS, com um dispatcher/lookup controlado. Portanto, esta etapa reduz a superfície de SSRF, mas não deve ser descrita como proteção completa.

**Validação executada:** o ZIP foi reaberto e a sua estrutura foi inspecionada. A execução de `tsc --noEmit` continua bloqueada porque as dependências do projeto não estão instaladas; o erro observado é `TS2688: Cannot find type definition file for 'vite/client'`. Não foi possível confirmar a compilação integral nem executar testes HTTP reais nesta sessão.

## Etapa — proteção de chamadas à API e validação de áudio enviado à IA (22/11/2026)

Foi identificada uma superfície de abuso no servidor: as rotas que consomem a API Gemini e o proxy/importador externo não tinham limitação de frequência. Além disso, as rotas de análise vocal e beatbox aceitavam qualquer string como `audioBase64`/`mimeType`, sem validar formato nem tamanho antes de encaminhar os dados ao fornecedor de IA.

### Alterações em `server.ts`

- Adicionado rate limit em memória por IP para as rotas de IA, geração de capas, importação de manifestos e proxy de áudio. A geração de capas tem limite mais baixo por ser uma operação potencialmente mais cara.
- Respostas limitadas devolvem HTTP 429 e `Retry-After`, além dos cabeçalhos de limite/restantes/reinício.
- O rate limiter usa `req.ip` sem ativar `trust proxy`, para não confiar em `X-Forwarded-For` arbitrário. Em produção atrás de proxy, a configuração de proxies confiáveis deve ser feita apenas para os saltos efetivamente controlados pelo operador.
- Reduzido o limite geral do JSON de 40 MiB para 26 MiB, mantendo margem para metadados em pedidos que transportam áudio base64.
- Criada validação comum para o áudio enviado a `/api/ai/analyze-vocal` e `/api/ai/mouth-to-beat`: MIME permitido, base64 estrito, mínimo de 64 bytes e máximo de 18 MiB descodificados.
- Pedidos com data URL em vez de base64 simples, caracteres inválidos, áudio vazio ou formato não suportado são rejeitados com HTTP 400 antes da chamada à IA.

### Validação desta etapa

- `node --experimental-strip-types --check server.ts`: passou, sem erros sintáticos.
- Revisão estática confirmou que as duas rotas de áudio chamam o validador antes de criar o cliente Gemini.
- Não foi executado `tsc --noEmit`, build Vite, teste HTTP integrado ou teste com chave Gemini real; as dependências do projeto continuam ausentes nesta cópia de trabalho.

### Limitações conhecidas

- O rate limit é local ao processo: em deployments com várias instâncias, cada instância mantém o seu próprio contador. Para proteção distribuída é necessário um armazenamento partilhado (por exemplo Redis) ou rate limiting no gateway de produção.
- Sem autenticação de utilizador, o rate limit reduz abuso simples, mas não substitui autenticação, quotas por conta nem proteção no gateway.
- A correção de DNS rebinding (fixar o IP validado no transporte HTTP/TLS) continua pendente no importador externo.

## Etapa — importação de manifestos 808 com concorrência limitada (22/11/2026)

Na revisão do ZIP de trabalho atual, foi identificado que o importador validava até 48 samples com `Promise.all`, iniciando todas as verificações remotas ao mesmo tempo. Um manifesto válido no formato, mas com muitas URLs lentas, podia abrir dezenas de pedidos simultâneos e aumentar a pressão sobre sockets, memória e servidores externos. Também havia um caso de item `null`/não-objeto que podia rejeitar o conjunto inteiro de validações em vez de ser registado como item inválido.

- Adicionada `mapWithConcurrency`, que processa os itens do manifesto em grupos de no máximo quatro operações remotas simultâneas.
- Mantida a ordem dos resultados do processamento concorrente.
- Itens nulos, arrays ou valores que não sejam objetos são agora ignorados e registados em `failedUrls` em vez de interromperem a importação inteira.
- Mensagens de falha provenientes do nome/URL são limitadas a 160 caracteres para evitar respostas excessivamente grandes.

### Validação desta etapa
- `node --experimental-strip-types --check server.ts`: passou (verificação sintática do servidor).
- A revisão confirma que o limite de concorrência é aplicado ao fluxo de validação de URLs dos samples do manifesto.
- Não foram executados testes de integração contra servidores externos, build Vite ou compilação TypeScript completa. A dependência `vite/client` continua por instalar/verificar; esta etapa não certifica o site em execução.
- O risco DNS-rebinding descrito anteriormente permanece em aberto: a validação DNS ainda não fixa o IP validado na ligação HTTP(S).

## Etapa adicional — fixação do IP nas ligações externas (2026-11-22)

### Problema identificado

A validação anterior consultava DNS para confirmar que um domínio resolvia apenas para endereços públicos, mas depois utilizava `fetch()` com o nome do domínio. O `fetch()` podia fazer uma segunda resolução DNS independente. Um domínio malicioso poderia, em teoria, devolver um IP público na validação e um IP privado na ligação (DNS rebinding).

### Alteração aplicada em `server.ts`

- Adicionado `fetchPinnedExternal()`, que resolve o domínio imediatamente antes da ligação.
- A função rejeita a ligação se qualquer resposta DNS for privada, local ou reservada.
- A ligação HTTP/HTTPS é aberta diretamente para o IP público validado através da opção `lookup` personalizada; não é feita uma segunda resolução independente pelo cliente HTTP.
- Para HTTPS, o nome original do domínio é mantido para SNI e validação do certificado.
- Redirecionamentos não são seguidos automaticamente; as rotas continuam a rejeitar respostas 3xx.
- O manifesto, a verificação HEAD/GET dos samples e o proxy de áudio passaram a utilizar a ligação fixada.
- Mantidos os limites de tempo, tamanho de resposta e concorrência já existentes.

### Verificações executadas

- Transpilação/sintaxe TypeScript e TSX: 16 ficheiros analisados, 0 erros sintáticos.
- `tsc --noEmit`: não foi possível completar a verificação de tipos porque as dependências do projeto não estão instaladas; o primeiro bloqueio reportado é `TS2688: Cannot find type definition file for 'vite/client'`.
- `npm install --ignore-scripts --no-audit --no-fund --prefer-offline`: excedeu o limite de tempo do ambiente; não foram criados `node_modules/.bin/tsc` nem `node_modules/.bin/tsx`.
- Testes reais de rede/DNS, compilação Vite e testes no navegador: ainda pendentes.

### Limitação restante

A ligação agora fixa o endereço IP resolvido no próprio pedido HTTP/HTTPS. Ainda é necessário executar testes de integração com servidores HTTP/HTTPS de teste, incluindo certificados TLS, IPv4/IPv6, timeouts, respostas 3xx e corpos acima dos limites, antes de considerar a proteção validada em produção.

## Etapa adicional — validação das chamadas Gemini e respostas estruturadas (2026-11-22)

Foi feita uma revisão das rotas `/api/ai/*` e dos dados que alimentam os prompts.

### Alterações aplicadas
- O servidor rejeita corpos de pedido que não sejam objetos JSON e devolve erros JSON claros para JSON malformado e pedidos acima do limite.
- As rotas de áudio verificam o tamanho, MIME e conteúdo base64; a análise vocal também limita e valida a lista de 808 enviada.
- A conversão de beatbox limita a quantidade de impactos e valida os valores numéricos dos eventos DSP e o BPM recebido.
- A geração de beat valida BPM, tonalidade, escala, 808 e objeto de restrições antes de chamar a Gemini; o âmbito de regeneração fica limitado aos valores suportados.
- O histórico do chat fica limitado às últimas 12 mensagens, com limite de caracteres por mensagem; o contexto do estúdio também é limitado antes de entrar no prompt.
- A leitura de JSON devolvido pela Gemini passou a rejeitar resposta vazia, JSON inválido ou estrutura que não seja objeto, em vez de aceitar silenciosamente `{}`.
- As recomendações de 808 são filtradas contra os IDs realmente presentes na biblioteca, sem duplicados e com máximo de três resultados.
- O swing gerado pela IA deixa de ser descartado e é limitado ao intervalo seguro de 0 a 0,5.
- Mensagens internas e detalhes brutos do fornecedor deixam de ser devolvidos ao navegador; foram criadas mensagens específicas para chave ausente, limite de uso e modelo indisponível.
- O identificador da geração de capas foi atualizado de `gemini-3-pro-image-preview` para `gemini-3-pro-image`, que consta na documentação atual de modelos/preços da Gemini API.

### Verificações
- Transpilação sintática de 18 ficheiros TypeScript/TSX: 0 erros sintáticos.
- Ainda não foi possível executar `tsc --noEmit`, `vite build` ou testes reais de integração com Gemini porque as dependências do projeto não estão instaladas neste ambiente.
- Os IDs de modelos de texto/áudio ainda precisam de confirmação por chamada real com a chave Gemini do projeto; documentação e disponibilidade podem variar por projeto e faturação.


## Etapa adicional — compatibilidade dos modelos Gemini e validação do beatbox (2026-11-22)

### Problemas identificados
- As rotas de análise vocal, conversão de beatbox, geração de beat e chat utilizavam `gemini-4-hydrogen`. Esse identificador não consta na lista atual de modelos da Gemini Developer API consultada nesta revisão; a documentação da API apresenta `gemini-3.8-flash` para compreensão multimodal, incluindo áudio.
- A rota de beatbox aceitava a estrutura JSON da IA e devolvia os eventos sem uma validação final campo a campo. Uma resposta inesperada podia introduzir tempos, instrumentos ou velocidades inválidas no projeto.

### Alterações aplicadas
- Substituído `gemini-4-hydrogen` por `gemini-3.8-flash` nas operações de análise vocal, beatbox, geração de beats e chat.
- Mantido `gemini-3.1-flash-lite` nas tarefas rápidas e `gemini-3-pro-image` na geração de capas.
- A resposta do beatbox agora é normalizada no servidor: máximo de 512 eventos; tempos finitos entre 0 e 300 segundos; instrumentos limitados às pistas de bateria suportadas; velocidade limitada entre 0,1 e 1; deslocamento de nota do 808 limitado a -24..24; eventos ordenados pelo tempo; BPM limitado a 40..220; descrição limitada a 1.200 caracteres.
- Respostas sem eventos utilizáveis passam a devolver uma lista vazia em vez de introduzir dados inválidos no projeto.

### Verificações
- Transpilação sintática de 17 ficheiros TypeScript/TSX: sem erros.
- Integridade do ZIP: verificada após a atualização.
- Typecheck, build Vite e chamadas reais à Gemini: ainda pendentes, porque as dependências não estão instaladas e não há uma chave Gemini configurada neste ambiente.


## Etapa adicional — sincronização fiel do beatbox com o motor musical (2026-11-22)

### Problema identificado
A resposta generativa da Gemini podia propor eventos em instantes que não correspondiam aos ataques medidos pelo DSP. Mesmo com a instrução para respeitar os tempos, uma resposta generativa não é garantia suficiente para preservar pausas e timing.

### Alterações aplicadas
- `server.ts`: os ataques detetados pelo DSP passam a ser a fonte de verdade para os instantes dos eventos.
- A Gemini classifica o instrumento; cada evento final usa exatamente o `timeSec` do ataque medido.
- Cada ataque medido gera no máximo um evento; eventos inventados pela Gemini e sem correspondência próxima (janela de 130 ms) são ignorados.
- Se a Gemini não classificar um ataque, é usada uma classificação de reserva determinística baseada nas proporções espectrais medidas, para não apagar um ataque real.
- A velocidade de reserva usa o pico medido no áudio.
- `src/App.tsx`: se nenhum ataque for detetado, a conversão apresenta uma mensagem clara e não substitui o padrão musical existente por um padrão vazio.
- O motor em tempo real e a exportação offline já consomem `mouthEvents` com `useExactMouthTiming`; a inspeção confirmou ambos os caminhos e não foi necessário alterar o agendamento.

### Validação desta etapa
- Transpilação sintática de 16 ficheiros TypeScript/TSX: 0 erros.
- Integridade do ZIP: validada após criação.
- Typecheck completo, build Vite, teste auditivo e teste real com Gemini: ainda pendentes por falta de dependências instaladas e execução integrada.

## Etapa adicional — carregamento e validação dos samples do estúdio (2026-11-22)

### Auditoria dos ficheiros de áudio
- Foram comparados os 104 caminhos `audioUrl` da biblioteca 808 com os ficheiros reais em `public/`; os 104 ficheiros existem.
- Os sete samples usados pelas pistas kick, snare, clap, hi-hat fechado, hi-hat aberto, percussão e melodia também existem no caminho configurado.
- Foram encontrados 111 ficheiros WAV em `public/audio`; todos passaram a verificação básica de cabeçalho RIFF/WAVE e nenhum apresentou duração estimada inferior a 10 ms.

### Alterações aplicadas em `src/audio/studioEngine.ts`
- Criada uma função comum de carregamento WAV para o kit e para os 808 da biblioteca.
- O pedido de rede tem timeout de 20 segundos e é cancelado se exceder esse prazo.
- O servidor/ficheiro é verificado quanto ao estado HTTP, tamanho declarado e tamanho real (máximo de 32 MiB).
- O conteúdo tem de possuir cabeçalho RIFF/WAVE antes de ser enviado ao descodificador Web Audio.
- Os erros de carregamento passam a indicar qual sample falhou, e os pedidos abortados recebem uma mensagem compreensível sobre a ligação.
- A cache e a descodificação existente foram preservadas; os samples personalizados importados continuam a usar o caminho de descodificação por Blob.

### Verificações
- Auditoria estática dos caminhos: 104/104 samples 808 e 7/7 samples do kit encontrados.
- Auditoria básica dos ficheiros: 111 WAV, 0 cabeçalhos inválidos.
- Transpilação sintática TypeScript/TSX: 16 ficheiros analisados, 0 erros.
- Testes reais de browser, reprodução, falhas de rede e `vite build`: ainda pendentes; não foi possível instalar as dependências neste ambiente.

## Etapa — duração da exportação para padrões longos de beatbox (2026-11-22)

Foi identificado um corte real no render offline: a duração do WAV era calculada apenas com base na duração da voz e no loop normal do sequenciador (com mínimo de 8 segundos). Quando o utilizador gravava um padrão com a boca que continha eventos depois desse limite, os eventos finais eram omitidos na exportação, apesar de existirem no padrão e serem agendáveis no caminho de reprodução.

- A duração do ciclo de beatbox passa a ser calculada antes da criação do `OfflineAudioContext`, usando a lista normalizada e ordenada de eventos.
- A exportação instrumental sem voz reserva pelo menos dois ciclos completos do padrão de beatbox, mantendo também o mínimo anterior de 8 segundos.
- Quando existe voz, o render dura o suficiente para incluir a voz e pelo menos um ciclo completo do padrão de beatbox, caso este seja mais longo.
- O limite de 15 minutos continua ativo para proteger a memória dos telefones.
- A mesma lista normalizada de eventos é reutilizada no agendamento offline, evitando divergência entre o cálculo da duração e a sequência efetivamente renderizada.

### Validação desta etapa
- Transpilação sintática de 16 ficheiros TypeScript/TSX: 0 erros.
- A lógica de duração foi revista para padrões com eventos depois de 8 segundos, padrões mais longos do que a voz e exportação instrumental sem voz.
- Build Vite, verificação completa de tipos e teste auditivo em navegador/dispositivo continuam pendentes; não declarar exportação certificada sem esses testes.

## Etapa adicional — sincronização dos efeitos vocais em reprodução e exportação (2026-11-22)

Durante a revisão do caminho de reprodução em tempo real, foi identificado que a montagem da cadeia vocal lia diretamente os parâmetros de `project.vocalFx` e utilizava `offsetMs` sem declarar/obter esse valor nesse escopo. Isso podia impedir a compilação TypeScript e também deixava a reprodução ao vivo menos protegida contra projetos antigos ou valores inválidos do que a exportação WAV.

Correções aplicadas em `src/audio/studioEngine.ts`:
- A cadeia vocal em tempo real agora usa os mesmos valores padrão e limites seguros de ganho, compressão, de-esser, reverb, delay e alinhamento usados no render offline.
- O `offsetMs` é agora definido explicitamente no caminho ao vivo.
- O alinhamento vocal é limitado a -200..+200 ms, conforme o contrato de `VocalFxSettings` e a intenção do controlo de alinhamento, tanto na reprodução como na exportação.
- A aplicação de efeitos ao vivo e a exportação usam os mesmos valores normalizados, reduzindo diferenças entre o que se ouve no estúdio e o WAV final.

Validação realizada: transpilation/sintaxe de 16 ficheiros TypeScript/TSX (incluindo `server.ts`) sem diagnósticos. Isto não substitui `tsc --noEmit`, `vite build` nem teste auditivo real; esses continuam pendentes porque as dependências do projeto não estão instaladas/verificadas neste ambiente.


## Etapa adicional — transparência sobre preservação de formantes (2026-11-22)

- A revisão do `autotuneEngine.ts` confirmou que o algoritmo atual usa reamostragem por grãos com overlap-add; não implementa preservação independente de formantes.
- Para não prometer um resultado que o DSP ainda não consegue garantir, o parâmetro `preserveFormants` fica desativado na normalização e na configuração inicial.
- O painel vocal passou a identificar a função como correção de afinação e informa que a preservação avançada do timbre ainda está em desenvolvimento.
- O algoritmo continua a manter o comprimento do buffer e os tempos dos frames, mas isso não equivale a preservação de formantes nem a qualidade de autotune profissional.
- Validação desta etapa: revisão estática; compilação, build e testes auditivos continuam pendentes.


## Etapa adicional — proteção e monitorização da gravação vocal (2026-11-22)

Na revisão de `src/components/WaveformRecorder.tsx`, foram reforçados os limites e a monitorização da gravação no navegador, sem ativar cancelamento automático de ruído ou ganho automático (essas opções permanecem desligadas para não alterar o timbre e a dinâmica da captação).

Alterações aplicadas:
- A duração final agora usa `performance.now()` (relógio monotónico), evitando saltos causados por alterações do relógio do dispositivo durante a gravação.
- A gravação é interrompida de forma controlada quando os dados acumulados ultrapassam 100 MiB, para reduzir o risco de consumo excessivo de memória em telefones com poucos recursos.
- O componente passa a medir RMS e pico aproximado do sinal de entrada e avisa visualmente quando deteta níveis próximos do limite digital; a indicação é um alerta preventivo, não uma medição certificada de clipping no ficheiro codificado.
- O callback que processa a gravação não é chamado se o componente já tiver sido desmontado, evitando processamento tardio depois de o utilizador sair do painel.
- A limpeza de recursos do microfone e do AudioContext foi mantida.

Limitações e validação:
- O limite de 100 MiB é uma proteção do lado do navegador; o tamanho final também depende do codec e do navegador.
- A deteção de pico usa a resolução de `AnalyserNode.getByteTimeDomainData`, pelo que é aproximada e serve apenas como aviso ao artista.
- Não foram simulados microfones reais, permissões, interrupções do Android nem gravações prolongadas neste ambiente.

## Etapa adicional — validação de áudio importado (2026-11-22)

Foi reforçada a entrada de áudio local no navegador, sobretudo para utilização em telemóveis com memória limitada.

- `WaveformRecorder.tsx`: valida ficheiros vazios, limite comprimido de 50 MB e tipo/extensão reconhecidos antes de chamar o importador. Extensões de áudio reconhecidas continuam permitidas quando o Android/navegador fornece um MIME genérico ou vazio.
- `studioEngine.ts`: `decodeAudioBlob` valida o Blob, limita o tamanho a 50 MB e converte falhas de descodificação numa mensagem compreensível. Depois de descodificar, rejeita durações acima de 10 minutos, mais de dois canais, taxas fora de 8–96 kHz ou mais de 30 milhões de amostras descodificadas.
- A validação central aplica-se a voz, beatbox e áudio carregado para o motor; a importação 808 mantém também os seus limites específicos mais restritos.

**Verificação executada:** transpilation sintática de 16 ficheiros TypeScript/TSX e `server.ts`: 0 erros. A compilação Vite, typecheck completo e testes com ficheiros reais continuam pendentes porque as dependências do projeto não estão instaladas neste ambiente.


## Etapa adicional — consistência e falhas no autosave (2026-11-22)

### Problema identificado

As atualizações automáticas dos projetos eram disparadas sem aguardar nem tratar a Promise de `saveProject`. Uma falha de quota/IndexedDB podia ficar invisível para o artista. Além disso, a abertura assíncrona da base de dados permitia que escritas concorrentes do mesmo projeto terminassem em ordem diferente; uma gravação antiga poderia sobrescrever uma alteração mais recente ou uma referência de áudio recém-substituída.

### Alterações aplicadas

- Introduzida fila de escritas por identificador de projeto em `src/storage/studioDb.ts`.
- `saveProject`, `replaceProjectAudio` e `deleteProjectById` passam pela mesma fila, preservando a ordem das operações do projeto.
- A substituição de áudio continua a gravar o novo Blob, atualizar o projeto e remover a referência anterior numa única transação IndexedDB.
- As chamadas automáticas de gravação em `src/App.tsx` passam por `persistProject`; falhas deixam de ser silenciosas e mostram uma mensagem ao utilizador.
- A falha de uma escrita não bloqueia permanentemente as escritas seguintes da mesma fila.

### Validação efetuada

- Transpilação sintática de 16 ficheiros TypeScript/TSX: 0 erros.
- Integridade do ZIP: verificada após empacotamento.
- Compilação Vite, verificação completa de tipos e testes de IndexedDB em navegador: ainda pendentes, pois as dependências não estão instaladas neste ambiente.

## Etapa — cópia de segurança e restauro de projetos

- Adicionadas `createProjectBackup` e `restoreProjectBackup` em `src/storage/studioDb.ts`.
- A exportação cria um ficheiro JSON versionado (`trap-vani-project-backup`, versão 1) com os dados do projeto e os Blobs de voz e beatbox convertidos para Base64.
- A restauração valida o formato, versão, campos essenciais e limites de tamanho antes de gravar.
- Cada restauro cria um novo identificador e novas chaves de áudio; não sobrescreve o projeto existente.
- Projeto e gravações são inseridos na mesma transação IndexedDB, para evitar restauros parciais.
- `ProjectsAndAiPanel.tsx` agora apresenta os controlos “Guardar cópia deste projeto” e “Restaurar cópia”, com mensagens de erro e estado de processamento.
- `App.tsx` liga os controlos ao armazenamento e seleciona o projeto restaurado.

**Limitações:** esta cópia inclui os dados do projeto, a capa e as gravações vocal/beatbox associadas. Não inclui a biblioteca global de samples 808 personalizados nem ficheiros externos referenciados por essa biblioteca. O ficheiro pode ser grande, pois o áudio é incorporado em Base64; o limite atual é 150 MB.

**Validação desta etapa:** 16 ficheiros TypeScript/TSX passaram pela transpilação sintática sem erros e o ZIP foi verificado. A compilação completa, teste de IndexedDB no navegador, exportação/restauro com gravações reais e teste no Redmi A3 continuam pendentes.

## Etapa adicional — falha visível no arranque do estúdio (2026-11-22)

### Problema identificado

Na inicialização do `App.tsx`, a leitura simultânea de projetos, 808 personalizados e pacotes era executada sem um `catch` para a Promise principal. Se o IndexedDB estivesse indisponível, bloqueado ou sem quota, a aplicação podia permanecer indefinidamente no ecrã “A carregar estúdio TRAP VANI AI...”, sem explicar o motivo nem oferecer uma ação de recuperação.

### Alterações

- Adicionado estado `bootError` para capturar falhas na inicialização.
- A cadeia assíncrona de arranque agora trata erros e evita atualizar o estado depois de o componente desmontar.
- O ecrã de carregamento passa a apresentar uma mensagem de erro e um botão “Tentar novamente”.
- A mensagem informa que os projetos não foram apagados e sugere verificar o espaço disponível.

### Verificações

- Transpilação sintática de 16 ficheiros TypeScript/TSX: 0 erros.
- Integridade do ZIP: verificada após empacotamento.
- Typecheck completo, build Vite e teste em Android/Chrome: ainda pendentes porque as dependências não estão instaladas neste ambiente.

Esta alteração melhora a recuperação quando o armazenamento local falha; não constitui uma garantia contra perda de dados nem substitui cópias de segurança externas.

## Etapa adicional — instalação Android (PWA) e shell offline (2026-11-22)

### Alterações
- Adicionado `public/manifest.webmanifest` com nome, idioma `pt-AO`, escopo `/`, modo `standalone`, cores e ícone.
- Adicionado `public/trap-vani-icon.svg` como ícone escalável da aplicação.
- Adicionado `public/sw.js` para cache limitado ao shell e recursos estáticos same-origin.
- O service worker não interceta `/api/`, pedidos não-GET nem recursos de outros domínios; gravações de áudio e dados de projeto não são colocados na cache HTTP.
- `index.html` referencia o manifesto e o ícone e inclui metadados para instalação móvel.
- `src/main.tsx` regista o service worker apenas em produção.

### Limitações importantes
- A instalação PWA e a permissão do microfone exigem publicação num contexto seguro HTTPS (ou localhost para desenvolvimento).
- O modo offline é parcial: permite recuperar o shell e os recursos same-origin que já tenham sido visitados/cacheados. Não garante o primeiro arranque offline, não torna a API Gemini disponível sem internet e não garante que fontes externas sejam carregadas offline.
- A compatibilidade real deve ser testada no Chrome Android do Redmi A3; o navegador pode impor limites próprios de armazenamento e reprodução em segundo plano.

### Verificações realizadas
- JSON do manifesto válido.
- Sintaxe JavaScript do service worker válida (`node --check`).
- Transpilação sintática de 16 ficheiros TypeScript/TSX: zero diagnósticos.
- Build Vite não executado: dependências locais (`node_modules/.bin/vite`) não estão instaladas neste ambiente.

## Etapa — modo offline limitado e auditoria da biblioteca 808 (2026-11-22)

### Decisão de produto
- O modo offline completo não será requisito para a primeira versão funcional. As operações Gemini/API precisam de internet; tentar oferecer geração IA offline aumentaria muito a complexidade e os requisitos de armazenamento/processamento.
- Mantém-se apenas uma PWA instalável e um cache pequeno da interface, como melhoria opcional. O estúdio principal deve ser validado primeiro online, com gravação, reprodução, mistura e exportação.

### Correção do Service Worker
- O Service Worker anterior dizia não guardar áudio, mas a regra genérica de cache podia guardar também ficheiros WAV servidos pela mesma origem.
- A versão `trap-vani-shell-v2` exclui explicitamente `/api/`, `/audio/` e extensões de áudio, e só guarda recursos pequenos da interface (JS, CSS, SVG, PNG, WebP, ICO e WOFF).
- Isto evita que a biblioteca de 808 encha inadvertidamente o armazenamento de cache do telefone. O modo offline continua limitado à interface e aos recursos já armazenados; não equivale a um estúdio totalmente offline.

### Auditoria dos 808
- O projeto contém 104 ficheiros WAV na pasta `public/audio/808`.
- A inspeção dos scripts `generate808Samples.mjs` e `generateArtist808s.mjs` mostra que os sons são sintetizados por código (osciladores, envelopes, varrimento de pitch, harmónicos, saturação e filtros), não são gravações oficiais nem stems extraídos de músicas dos artistas citados.
- Os nomes de referência indicam direções estéticas, não identidade sonora exata. Não se pode afirmar que sejam exatamente iguais aos 808 usados por artistas profissionais.
- Para aproximar a qualidade de uma produção profissional, ainda será necessário ouvir e avaliar os samples, afinar por nota, comparar em diferentes sistemas de som, verificar transientes/caudas/ruído e fazer mistura/masterização. Também será importante usar samples originais licenciados ou criados especificamente para o projeto.

### Verificações desta etapa
- `node --check public/sw.js`: aprovado.
- Contagem de ficheiros WAV 808: 104 encontrados.
- Formato inspecionado em amostras: WAV PCM mono, 44,1 kHz, 16-bit.
- Build Vite, typecheck e testes de reprodução no Android: ainda pendentes.

## Etapa — slides 808 com destino musical real (2026-11-22)

### Problema identificado
- O parâmetro `slide` do sequenciador apenas fazia o 808 subir automaticamente uma quinta justa (razão aproximada de 1,498), independentemente da nota seguinte. Isso não correspondia necessariamente à intenção musical do padrão.

### Alterações
- `getNext808SlideNote` procura a próxima etapa 808 ativa com nota definida, incluindo a volta ao início do padrão.
- A reprodução em tempo real e a renderização offline passam agora a enviar essa nota como destino do slide.
- `trigger808Sound` calcula a frequência de reprodução de destino a partir da nota MIDI seguinte e executa o glide durante o tempo configurado em `glideMs` (com limites de segurança).
- Projetos antigos sem nota de destino mantêm o comportamento anterior de subida de uma quinta, para compatibilidade.
- Removida uma instrução `return` duplicada e inalcançável em `triggerKitSample`.

### Verificações
- Transpilação sintática de 16 ficheiros TypeScript/TSX, incluindo `server.ts`: 0 erros.
- O caminho de reprodução em tempo real e o caminho de exportação offline foram atualizados para utilizar o mesmo destino MIDI.
- Build Vite, verificação completa de tipos e teste auditivo em navegador/Android continuam pendentes; não se afirma que o glide já foi validado auditivamente.

## Etapa adicional — afinação dos 808 à tonalidade do projeto (2026-11-22)

- Foi identificada a necessidade de alinhar as notas MIDI do 808 com `project.key` e `project.scale`, sem alterar o áudio-fonte dos samples.
- Implementada uma tabela de intervalos para menor, menor harmónica, frígio, dórico, maior e cromática.
- As notas 808 são encaminhadas para a nota mais próxima permitida pela escala, respeitando o intervalo MIDI 0–127.
- O ajuste é aplicado nos caminhos de reprodução em tempo real e renderização offline/exportação, incluindo as notas de destino dos slides.
- A escala cromática mantém as notas originais. Projetos antigos ou com metadados inválidos também mantêm as notas originais como fallback.
- Verificação realizada: transpilation sintática de 16 ficheiros TypeScript/TSX, sem erros; integridade do ZIP validada.
- Limitações: não foi possível executar build Vite, typecheck completo nem teste auditivo no navegador, pois as dependências não estão instaladas nesta cópia. A quantização é uma assistência musical; o produtor continua a poder usar a escala cromática para evitar correções automáticas.

## Etapa adicional — melhoria do clipper e limitador master (2026-11-22)

- A curva do soft clipper passou de 512 para 2048 pontos e agora valida o valor de drive antes de calcular a curva.
- O clipper passou a usar oversampling `4x` através de `WaveShaperNode.oversample`, tanto na reprodução em tempo real como na renderização offline.
- Os parâmetros do compressor usado como limitador foram alinhados entre reprodução e exportação: threshold de -2 dB quando ligado, knee de 2 dB, ratio 12:1, attack 3 ms e release 100 ms.
- O objetivo é reduzir aliasing audível e aproximar o comportamento do master entre o que se ouve no estúdio e o WAV exportado. Isto não equivale a um limitador true-peak dedicado nem garante masterização profissional; requer testes auditivos e medição de pico/true-peak.
- Validação realizada: transpilation sintática de 16 ficheiros TypeScript/TSX sem erros; `unzip -t` sem erros. Build Vite, typecheck e teste auditivo continuam pendentes.

## Etapa adicional — sidechain Kick → 808 (2026-11-22)

### Auditoria
- O projeto já possuía um bus dedicado para reduzir temporariamente o 808 quando ocorre um kick, tanto na reprodução em tempo real como na renderização offline.
- Foi identificado um caso incorreto: o ducking era disparado antes de confirmar que o sample de kick tinha sido efetivamente iniciado. Se o sample estivesse ausente ou falhasse ao tocar, o 808 podia baixar sem existir kick audível.

### Alterações
- O sidechain agora é acionado somente quando `triggerKitSample` devolve uma voz válida para o kick.
- A mesma condição foi aplicada à reprodução ao vivo e à exportação offline.
- O envelope foi centralizado em constantes: nível de duck 0,48, ataque 6 ms, manutenção 12 ms e recuperação com constante de tempo de 45 ms.
- O comportamento continua a ser redução de ganho programada por eventos, não um compressor sidechain detector de áudio em tempo real.

### Validação
- Transpilação sintática de 16 ficheiros TypeScript/TSX: zero erros.
- Integridade do ZIP: verificada após empacotamento.
- Typecheck completo, build Vite e teste auditivo em navegador: pendentes, pois as dependências locais não estão instaladas.
- A separação de frequências entre voz e subgrave e o ducking vocal automático não foram implementados nesta etapa.

## Etapa — limpeza conservadora de subgrave na faixa vocal

- `src/audio/studioEngine.ts`: adicionado um filtro passa-altas Butterworth-like (Biquad high-pass, Q = 0,707) a 55 Hz no caminho vocal, antes do ganho, compressor, de-esser, reverb e delay.
- A mesma função e frequência são usadas na reprodução em tempo real e na exportação offline, para reduzir rumble de manuseamento/ambiente sem criar uma diferença entre o que se ouve no estúdio e o WAV exportado.
- O filtro atua apenas na faixa vocal; não corta o subgrave do 808.

**Limitação:** isto é uma limpeza fixa e conservadora de frequências muito baixas, não uma separação inteligente de stems nem um equalizador dinâmico. A região vocal e o 808 ainda podem competir entre aproximadamente 60–250 Hz. A adequação do corte de 55 Hz precisa de teste auditivo com vozes diferentes, especialmente vozes graves.

**Validação desta etapa:** revisão estática do encaminhamento live/offline; verificação sintática e compilação completa ainda pendentes por falta de dependências instaladas. Não foi feito teste auditivo.

## Etapa — equalização dinâmica vocal-keyed no low-mid do 808

Foi acrescentada uma etapa de equalização dinâmica dedicada ao canal 808, sem alterar o nível do subgrave fundamental:

- O canal 808 recebe um filtro peaking dinâmico centrado em 185 Hz (Q 0,85), inicialmente neutro (0 dB).
- A curva de redução é calculada a partir do RMS da gravação vocal em janelas aproximadas de 20 ms, considerando todos os canais da gravação.
- Quando a voz está ativa, o filtro reduz progressivamente essa região até um máximo de 2,5 dB; em pausas regressa a 0 dB. O subgrave abaixo desta região não é diretamente reduzido por este filtro.
- A automação é agendada tanto na reprodução em tempo real como na renderização OfflineAudioContext, usando a mesma curva e respeitando o offset vocal.
- A redução só é aplicada quando a faixa vocal está audível segundo mute/solo/modo de monitorização. Valores inválidos de offset são limitados a 0 ms.

**Limitações e validação:** esta é uma primeira forma conservadora de dynamic EQ sidechain, não um separador de stems nem um substituto de mistura por ouvido. A curva é baseada no nível global da voz, não numa análise fonética/perceptual. A sintaxe foi revista; compilação Vite, typecheck, testes de automação Web Audio e avaliação auditiva continuam pendentes porque as dependências não estão instaladas neste ambiente.

## Etapa — proteção de pico e dither na exportação WAV (2026-11-22)

### Problema identificado
- O conversor final de `AudioBuffer` para PCM16 limitava cada amostra individualmente a ±1. Isso evitava valores inválidos, mas podia criar clipping duro na conversão se a cadeia de master deixasse picos acima de 0 dBFS.
- A conversão não aplicava dither antes da quantização de 16 bits, o que pode aumentar distorção de quantização em sinais de baixo nível.

### Alterações em `src/audio/studioEngine.ts`
- O exportador mede o pico amostra-a-amostra de todos os canais antes de escrever o WAV.
- Se o pico ultrapassar -1 dBFS, aplica uma atenuação uniforme ao ficheiro inteiro até esse teto; não aumenta o ganho de misturas mais baixas.
- Adicionado dither TPDF determinístico na quantização PCM16.
- Reforçada a validação de duração, tamanho RIFF, frequência de amostragem e comprimentos dos canais antes da alocação do WAV.
- Mantida a exportação de até dois canais e o formato WAV PCM de 16 bits.

### Verificações desta etapa
- Transpilação sintática TypeScript/TSX: 16 ficheiros, zero erros.
- Teste isolado do conversor WAV com áudio estéreo sintético incluindo picos acima de 0 dBFS: cabeçalho RIFF/WAV, estéreo, 44,1 kHz e teto de pico próximo de -1 dBFS confirmados.
- Integridade do ZIP: verificada após empacotamento.
- Build Vite, typecheck completo, medição de true-peak e teste auditivo em navegador/Android continuam pendentes. O controlo implementado é de pico amostrado, não um limitador true-peak nem uma garantia de masterização profissional.

## Etapa adicional — seleção da frequência de exportação WAV (2026-11-22)

Foi acrescentada a seleção entre 44,1 kHz e 48 kHz no painel de exportação. A opção é encaminhada ao `OfflineAudioContext`, para que a renderização seja criada na frequência escolhida, e o nome do ficheiro passa a identificar a frequência e a profundidade de bits. A profundidade 16/24 bits foi preservada. A transpilação sintática de 16 ficheiros TS/TSX não encontrou erros; a compilação Vite e a verificação completa de tipos continuam pendentes por ausência de `node_modules`. Ver `REVISAO_TECNICA_ETAPA_SAMPLE_RATE.md`.
