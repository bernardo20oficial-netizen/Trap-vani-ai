# Revisão técnica — exportação WAV PCM 16/24 bits

Data: 2026-11-22

## Alterações

- A exportação principal aceita agora PCM WAV de 16 ou 24 bits.
- A interface de mistura apresenta uma seleção de profundidade de bits, com 24 bits como opção inicial e 16 bits como alternativa mais leve.
- O cabeçalho RIFF/WAVE, `blockAlign`, `byteRate`, tamanho do bloco `data` e o tamanho total são calculados conforme 2 ou 3 bytes por amostra.
- A conversão 24-bit escreve PCM signed two's-complement little-endian empacotado em três bytes.
- O dither TPDF é aplicado na escala de um LSB correspondente à profundidade selecionada.
- Mantém-se a proteção de pico amostrado a -1 dBFS; não é uma garantia de true-peak.
- O nome do ficheiro exportado identifica a profundidade (`16bit` ou `24bit`).

## Verificações executadas

- Transpilação sintática de 16 ficheiros TypeScript/TSX: sem erros.
- Teste automatizado do cabeçalho e comprimento WAV estéreo PCM 16-bit: aprovado.
- Teste automatizado do cabeçalho e comprimento WAV estéreo PCM 24-bit: aprovado.
- Integridade do ZIP: verificada após empacotamento.

## Limitações ainda por validar

- A compilação completa Vite/TypeScript ainda não foi executada neste ambiente porque as dependências locais não estão instaladas.
- Não foram realizados testes auditivos em dispositivos reais nem testes de compatibilidade em todos os leitores de WAV.
- A exportação continua a usar a frequência de amostragem do render offline (44,1 kHz); a seleção de 48/96 kHz não faz parte desta etapa.
- 24-bit aumenta o tamanho do ficheiro; não cria detalhe adicional na origem, mas evita reduzir a resolução para 16-bit na entrega.
