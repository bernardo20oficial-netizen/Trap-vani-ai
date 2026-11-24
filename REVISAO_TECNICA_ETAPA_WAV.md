# Trap Vani AI — revisão técnica (etapa de exportação WAV)

## Correção aplicada

- `src/audio/studioEngine.ts`: a conversão de áudio para PCM16 agora substitui amostras não finitas (`NaN`, `Infinity` e `-Infinity`) por silêncio antes de limitar e escrever os valores no WAV. Isto evita que valores inválidos de uma cadeia de efeitos contaminem o ficheiro exportado.
- A conversão continua a produzir WAV PCM de 16 bits, mono ou estéreo, preservando a taxa de amostragem do `AudioBuffer`.

## Limitações e testes pendentes

- A instalação das dependências (`npm install --ignore-scripts --no-audit --no-fund --prefer-offline`) excedeu o limite de tempo do ambiente.
- Por isso, ainda não foi possível executar `npm run build`, `npm run lint` nem testes de reprodução/escuta.
- `preserveFormants` existe no tipo/configuração, mas o motor `processVocalWithAutotune` não o utiliza. A preservação real de formantes continua pendente; não deve ser anunciada como funcional até existir implementação DSP adequada e testes auditivos.
- O algoritmo atual de autotune faz reamostragem por grãos e pode alterar o timbre; a opção de preservação de formantes não corrige isso atualmente.

## Estado

Correção estática aplicada; compilação e validação funcional ainda não confirmadas.
